import fs from "node:fs";
import path from "node:path";
import { ArbScannerConfig } from "./config";
import { BookStateStore } from "./bookState";
import { ExecutionSimulator, buildExecutionSimConfig } from "./executionSimulator";
import { FeeModel } from "./feeModel";
import { PaperTrader } from "./paperTrader";
import { assessBinaryFullSetArb } from "./strategy";
import { BinaryMarket, RecordedEvent } from "./types";

export type ReplayReport = {
    tradeCount: number;
    positionOpens: number;
    positionsResolved: number;
    winRate: number;
    averageEdge: number;
    realizedPnl: number;
    maxDrawdown: number;
    positionsOpen: number;
    releasedExposure: number;
    marketsLoaded: number;
    wsEventsProcessed: number;
    missedTradeReasons: Record<string, number>;
    staleDataSummary: {
        staleQuoteDenials: number;
    };
    liquidityDenialSummary: {
        missingRequiredLiquidityDenials: number;
    };
    partialFillDamageReport: {
        partialFills: number;
        pnlLostToPartial: number;
    };
};

function parseRecordedEvents(filePath: string): RecordedEvent[] {
    const content = fs.readFileSync(filePath, "utf8");
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedEvent);
}

export function runReplay(filePath: string, config: ArbScannerConfig): ReplayReport {
    const resolvedPath = path.resolve(process.cwd(), filePath);
    const events = parseRecordedEvents(resolvedPath);

    const markets = new Map<string, BinaryMarket>();
    for (const event of events) {
        if (event.type === "market_metadata") {
            markets.set(event.market.marketId, event.market);
        }
    }
    if (markets.size === 0) {
        throw new Error("Replay file does not contain any market_metadata events");
    }

    const tokenIds = Array.from(markets.values()).flatMap((market) => [market.yesTokenId, market.noTokenId]);
    const store = new BookStateStore(tokenIds);
    const marketByTokenId = new Map<string, BinaryMarket>();
    for (const market of markets.values()) {
        marketByTokenId.set(market.yesTokenId, market);
        marketByTokenId.set(market.noTokenId, market);
    }

    const simulator = new ExecutionSimulator(buildExecutionSimConfig(config));
    const trader = new PaperTrader(simulator, config, {
        maxTradesPerMarket: config.paperMaxTradesPerMarket,
        emitLogs: false,
    });
    const feeModel = new FeeModel(config);
    let wsEventsProcessed = 0;
    const missedTradeReasons = new Map<string, number>();
    let partialFills = 0;
    let pnlLostToPartial = 0;

    const countReason = (reason: string) => {
        missedTradeReasons.set(reason, (missedTradeReasons.get(reason) ?? 0) + 1);
    };

    for (const event of events) {
        let updates: Array<{ tokenId: string }> = [];
        if (event.type === "ws_market") {
            wsEventsProcessed += 1;
            updates = store.applyMarketMessage(event.payload, event.ts);
        } else if (event.type === "book_top") {
            store.applyMarketMessage({
                event_type: "best_bid_ask",
                asset_id: event.tokenId,
                best_bid: event.top.bid,
                best_ask: event.top.ask,
                best_bid_size: event.top.bidSize,
                best_ask_size: event.top.askSize,
            }, event.ts);
            updates = [{ tokenId: event.tokenId }];
        } else {
            continue;
        }
        const touchedMarkets = new Set<BinaryMarket>();
        for (const update of updates) {
            const market = marketByTokenId.get(update.tokenId);
            if (market) touchedMarkets.add(market);
        }
        for (const market of touchedMarkets) {
            const evaluation = assessBinaryFullSetArb(
                market,
                store.getTopOfBook(market.yesTokenId),
                store.getTopOfBook(market.noTokenId),
                config,
                feeModel,
                event.ts + config.replayLatencyMs,
            );
            if (evaluation.reason !== "ok" || !evaluation.opportunity) {
                countReason(evaluation.reason);
                continue;
            }

            const result = trader.handleOpportunity(evaluation.opportunity);
            if ("skipped" in result) {
                if (result.reason === "risk_denied" && result.risk) {
                    for (const reasonCode of result.risk.reasonCodes) countReason(reasonCode);
                } else {
                    countReason(result.reason);
                }
                continue;
            }
            if (result.status === "rejected") {
                countReason(result.reason);
                continue;
            }
            if (result.status === "partial") {
                partialFills += 1;
                pnlLostToPartial += result.pnlLostToPartial ?? 0;
            }
        }
    }

    const maxKnownEndTimeMs = Array.from(markets.values())
        .map((market) => (market.endDate ? Date.parse(market.endDate) : NaN))
        .filter((value) => Number.isFinite(value))
        .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
    if (Number.isFinite(maxKnownEndTimeMs)) {
        trader.advanceTime(maxKnownEndTimeMs);
    }

    const state = trader.getState();

    return {
        tradeCount: state.positionOpens,
        positionOpens: state.positionOpens,
        positionsResolved: state.positionsResolved,
        winRate: state.positionsResolved > 0 ? state.wins / state.positionsResolved : 0,
        averageEdge: state.averageEdge,
        realizedPnl: state.realizedPnl,
        maxDrawdown: state.maxDrawdown,
        positionsOpen: state.positions.filter((position) => position.state === "open").length,
        releasedExposure: state.releasedExposure,
        marketsLoaded: markets.size,
        wsEventsProcessed,
        missedTradeReasons: Object.fromEntries(missedTradeReasons.entries()),
        staleDataSummary: {
            staleQuoteDenials: missedTradeReasons.get("stale_market_state") ?? 0,
        },
        liquidityDenialSummary: {
            missingRequiredLiquidityDenials: missedTradeReasons.get("missing_required_liquidity") ?? 0,
        },
        partialFillDamageReport: {
            partialFills,
            pnlLostToPartial,
        },
    };
}
