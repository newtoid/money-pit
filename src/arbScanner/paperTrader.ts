import { logger } from "../logger";
import { ArbRecorder } from "./recorder";
import { ExecutionSimulator } from "./executionSimulator";
import { Opportunity, PaperTraderState, SimulatedFill } from "./types";
import { ArbScannerConfig } from "./config";
import { SimulatedPortfolio } from "../core/portfolio";
import { evaluateTradeRisk, TradeRiskDecision } from "../core/riskEngine";

type PaperTraderOpts = {
    maxTradesPerMarket: number;
    recorder?: ArbRecorder;
    emitLogs?: boolean;
};

export class PaperTrader {
    private readonly edges: number[] = [];
    private readonly tradesByMarket = new Map<string, number>();
    private readonly denialCounts = new Map<string, number>();
    private readonly portfolio = new SimulatedPortfolio();
    private maxDrawdown = 0;
    private peakRealizedPnl = 0;
    private wins = 0;
    private losses = 0;
    private tradeAttempts = 0;
    private positionOpens = 0;
    private positionsResolved = 0;

    constructor(
        private readonly simulator: ExecutionSimulator,
        private readonly config: ArbScannerConfig,
        private readonly opts: PaperTraderOpts,
    ) {}

    handleOpportunity(opportunity: Opportunity): SimulatedFill | { skipped: true; reason: string; risk?: TradeRiskDecision } {
        this.advanceTime(opportunity.observedAt);
        this.tradeAttempts += 1;

        const tradeCount = this.tradesByMarket.get(opportunity.market.marketId) ?? 0;
        if (tradeCount >= this.opts.maxTradesPerMarket) {
            this.countDenial("max_trades_per_market");
            return { skipped: true, reason: "max_trades_per_market" };
        }

        const risk = evaluateTradeRisk({
            opportunity,
                marketState: {
                    quoteAgeMs: opportunity.quote.quoteAgeMs,
                    yesAskSize: opportunity.quote.yesAskSize,
                    noAskSize: opportunity.quote.noAskSize,
                    marketEndTimeMs: opportunity.market.endDate ? Date.parse(opportunity.market.endDate) : null,
                },
            portfolioState: this.portfolio.getSnapshot(),
            config: this.config,
            now: opportunity.observedAt,
        });
        if (!risk.allow) {
            for (const reasonCode of risk.reasonCodes) this.countDenial(reasonCode);
            if (this.opts.emitLogs !== false) {
                logger.info(
                    {
                        marketId: opportunity.market.marketId,
                        slug: opportunity.market.slug,
                        question: opportunity.market.question,
                        attemptedEdge: opportunity.edge,
                        attemptedTotalAllIn: opportunity.totalAllIn,
                        attemptedSize: this.config.tradeSize,
                        reasonCodes: risk.reasonCodes,
                        riskDetails: risk.details,
                    },
                    "Paper trade denied by risk engine",
                );
            }
            return { skipped: true, reason: "risk_denied", risk };
        }

        const fill = this.simulator.simulateEntry(opportunity, opportunity.observedAt);
        this.opts.recorder?.recordSimFill(fill);

        if (fill.status === "rejected" || fill.filledSize <= 0 || fill.edgeAfter === null) {
            this.countDenial(fill.reason);
            if (this.opts.emitLogs !== false) {
                logger.info(
                    {
                        marketId: fill.marketId,
                        slug: fill.slug,
                        status: fill.status,
                        reason: fill.reason,
                        requestedSize: fill.requestedSize,
                    },
                    "Paper trade rejected",
                );
            }
            return fill;
        }

        this.tradesByMarket.set(opportunity.market.marketId, tradeCount + 1);
        this.edges.push(fill.edgeAfter);
        const opened = this.portfolio.openFromFill(opportunity, fill);
        if (!opened.opened) {
            this.countDenial(opened.reason);
            return { skipped: true, reason: opened.reason };
        }
        this.positionOpens += 1;
        this.opts.recorder?.recordPositionOpen(opened.position);

        if (this.opts.emitLogs !== false) {
            logger.info(
                {
                    positionId: opened.position.id,
                    marketId: opened.position.marketId,
                    slug: opened.position.slug,
                    status: fill.status,
                    requestedSize: fill.requestedSize,
                    filledSize: fill.filledSize,
                    yesPrice: fill.yesPrice,
                    noPrice: fill.noPrice,
                    edgeBefore: fill.edgeBefore,
                    edgeAfter: fill.edgeAfter,
                    lockedNotional: opened.position.lockedNotional,
                    marketEndTimeMs: opened.position.marketEndTimeMs,
                    resolutionSource: opened.position.resolutionSource,
                },
                "Paper position opened",
            );
        }
        return fill;
    }

    advanceTime(now: number) {
        const resolved = this.portfolio.resolveMaturedPositions(now);
        for (const item of resolved) {
            this.positionsResolved += 1;
            if ((item.position.realizedPnl ?? 0) >= 0) this.wins += 1;
            else this.losses += 1;
            const portfolio = this.portfolio.getSnapshot();
            this.peakRealizedPnl = Math.max(this.peakRealizedPnl, portfolio.realizedPnl);
            this.maxDrawdown = Math.max(this.maxDrawdown, this.peakRealizedPnl - portfolio.realizedPnl);
            this.opts.recorder?.recordPositionResolve(item.position);
            if (this.opts.emitLogs !== false) {
                logger.info(
                    {
                        positionId: item.position.id,
                        marketId: item.position.marketId,
                        slug: item.position.slug,
                        resolvedAt: item.position.resolvedAt,
                        releasedExposure: item.releasedExposure,
                        settlementGrossPayout: item.position.settlementGrossPayout,
                        realizedPnlDelta: item.realizedPnlDelta,
                        cumulativeRealizedPnl: portfolio.realizedPnl,
                    },
                    "Paper position resolved",
                );
            }
        }
    }

    getState(): PaperTraderState {
        const portfolio = this.portfolio.getSnapshot();
        const averageEdge = this.edges.length > 0
            ? this.edges.reduce((sum, value) => sum + value, 0) / this.edges.length
            : 0;

        return {
            tradeAttempts: this.tradeAttempts,
            positionOpens: this.positionOpens,
            positionsResolved: this.positionsResolved,
            wins: this.wins,
            losses: this.losses,
            averageEdge,
            realizedPnl: portfolio.realizedPnl,
            maxDrawdown: this.maxDrawdown,
            grossOpenNotional: portfolio.grossOpenNotional,
            unrealizedPnlMarkedToMarket: null,
            releasedExposure: portfolio.releasedExposure,
            denialCounts: Object.fromEntries(this.denialCounts.entries()),
            positions: portfolio.positions.map((position) => ({
                id: position.id,
                state: position.state,
                marketId: position.marketId,
                slug: position.slug,
                size: position.size,
                entryTotalAllInPerUnit: position.entryTotalAllInPerUnit,
                lockedNotional: position.lockedNotional,
                openedAt: position.openedAt,
                resolvedAt: position.resolvedAt,
                realizedPnl: position.realizedPnl,
            })),
        };
    }

    private countDenial(reason: string) {
        this.denialCounts.set(reason, (this.denialCounts.get(reason) ?? 0) + 1);
    }
}
