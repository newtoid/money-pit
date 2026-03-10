import fs from "node:fs";
import path from "node:path";
import { ArbScannerConfig } from "./config";
import { BookStateStore } from "./bookState";
import { ExecutionSimulator, buildExecutionSimConfig } from "./executionSimulator";
import { FeeModel } from "./feeModel";
import { PaperTrader } from "./paperTrader";
import { assessBinaryFullSetArb } from "./strategy";
import { BinaryMarket, PaperTraderState, RecordedEvent, ReplayExecutionOutcome, ReplayLegExecution } from "./types";
import { SettlementSource } from "../core/settlementSource";
import { ExecutionAttemptRecord, ExecutionAttemptStateMachine, ExecutionTransitionReason } from "../core/executionStateMachine";
import { StrandedDamageTracker } from "../core/strandedDamage";
import { createExecutionAdapter } from "../live/createExecutionAdapter";
import { buildExecutionRequest } from "../live/buildExecutionRequest";
import { ReconciliationSnapshot } from "../live/types";

export type ReplayReport = {
    tradeCount: number;
    positionOpens: number;
    positionsResolved: number;
    winRate: number;
    averageEdge: number;
    realizedPnl: number;
    dailyRealizedPnl: number;
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
    dailyLossSummary: {
        dailyLossDenials: number;
        firstDailyLossBlockAt: number | null;
    };
    currentState: {
        openPositionsCount: number;
        unresolvedPositionsCount: number;
        unresolvedLockedExposure: number;
        openPositionsMissingTrustworthySettlementPath: number;
        lockedExposureMissingTrustworthySettlementPath: number;
    };
    dayRollover: PaperTraderState["dayRollover"];
    unresolvedAging: PaperTraderState["unresolvedAging"];
    settlementSummary: {
        settlementModeUsed: string;
        recordedExplicitResolutionEvents: number;
        resolutionEventProvenanceBreakdown: Record<string, number>;
        trustworthyResolutionEvents: number;
        untrustworthyResolutionEvents: number;
        usedOnlyPlaceholderFallback: boolean;
        positionsResolvedByExplicitResolutionEvent: number;
        positionsResolvedByPlaceholderAssumption: number;
        unresolvedPositions: number;
        unresolvedLockedExposure: number;
        positionsMissingTrustworthySettlementData: number;
        lockedExposureMissingTrustworthySettlementData: number;
    };
    settlementCoverage: PaperTraderState["settlementCoverage"];
    executionOutcomes: {
        fullFillCount: number;
        fullFillTopLevelCount: number;
        fullFillMultiLevelSweepCount: number;
        legAFillOnly: number;
        legBFillOnly: number;
        noFill: number;
        partialFillCount: number;
        depthLimitedPartialFillCount: number;
        noUsableLiquidityCount: number;
        invalidatedBeforeSecondLegCount: number;
        queueLimitedNoFillCount: number;
        queueLimitedPartialFillCount: number;
        averageVisibleToFillableHaircut: number;
        queueMode: ArbScannerConfig["queuePriorityMode"];
        visibleBaselineFullFillCount: number;
        fullFillReductionVsVisibleBaseline: number;
        executionSuccessReductionVsVisibleBaseline: number;
        partialFillDamage: number;
        averageLevelsConsumedPerSuccessfulLeg: number;
        averageFillPriceDeviationFromDetectedBestAsk: number;
        averageSweepSlippageFromDepth: number;
        successfulLegsWithoutDepthLadders: number;
    };
    averageDetectionToExecutionDelayMs: number;
    opportunityInvalidationRate: number;
    executionSuccessRate: number;
    executionDamage: PaperTraderState["executionDamage"];
    executionStateSummary: PaperTraderState["executionStateSummary"];
    executionAttempts: ExecutionAttemptRecord[];
    strandedDamageRecords: PaperTraderState["strandedDamageRecords"];
    executionAdapter: ReconciliationSnapshot;
    partialFillDamageReport: {
        partialFills: number;
        pnlLostToPartial: number;
    };
};

type PendingExecution = {
    opportunity: NonNullable<ReturnType<typeof assessBinaryFullSetArb>["opportunity"]>;
    legAPlannedAt: number;
    legBDueAt: number | null;
    legA: ReplayLegExecution | null;
    legB: ReplayLegExecution | null;
    attempt: ExecutionAttemptStateMachine;
};

type ReplayAttemptWithOutcome = {
    attempt: ExecutionAttemptRecord;
    outcome?: ReplayExecutionOutcome;
};

function visibleAskDepth(book: ReturnType<BookStateStore["getBookState"]>, fallbackSize: number | null) {
    if (book && book.asks.length > 0) {
        return book.asks.reduce((sum, level) => sum + (level.size ?? 0), 0);
    }
    return fallbackSize ?? 0;
}

function parseRecordedEvents(filePath: string): RecordedEvent[] {
    const content = fs.readFileSync(filePath, "utf8");
    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedEvent);
}

function buildReplayOrderLifecycleUpdate(attempt: ExecutionAttemptRecord, outcome: ReplayExecutionOutcome) {
    const mapLeg = (side: "yes" | "no", leg: ReplayLegExecution | null) => {
        if (!leg) {
            return {
                legId: `${attempt.id}-${side}`,
                terminalState: "rejected" as const,
                reason: "rejected_by_stub" as const,
            };
        }
        if (leg.filledSize >= leg.requestedSize) {
            return {
                legId: `${attempt.id}-${side}`,
                terminalState: "filled" as const,
                reason: "filled_by_replay_simulation" as const,
                filledSize: leg.filledSize,
                averageFillPrice: leg.averageFillPrice ?? undefined,
            };
        }
        if (leg.filledSize > 0) {
            return {
                legId: `${attempt.id}-${side}`,
                terminalState: "partially_filled" as const,
                reason: "partially_filled_by_replay_simulation" as const,
                filledSize: leg.filledSize,
                averageFillPrice: leg.averageFillPrice ?? undefined,
            };
        }
        return {
            legId: `${attempt.id}-${side}`,
            terminalState: leg.reason === "stale_orderbook" ? "expired" as const : "rejected" as const,
            reason: leg.reason === "stale_orderbook" ? "expired_by_stub_timeout" as const : "rejected_by_stub" as const,
        };
    };
    return {
        executionAttemptId: attempt.id,
        ts: outcome.legBAttemptedAt ?? outcome.legAAttemptedAt,
        legUpdates: [
            mapLeg("yes", outcome.legA.side === "yes" ? outcome.legA : outcome.legB),
            mapLeg("no", outcome.legA.side === "no" ? outcome.legA : outcome.legB),
        ],
        reconciliationPending: true,
        reconcileNow: true,
    };
}

function summarizeExecutionAttempts(attempts: ReplayAttemptWithOutcome[]): PaperTraderState["executionStateSummary"] {
    const attemptsByTerminalState = attempts.reduce<Record<string, number>>((acc, item) => {
        const key = item.attempt.terminalState ?? "non_terminal";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
    }, {});
    const transitionReasonCounts = attempts.flatMap((item) => item.attempt.history).reduce<Record<string, number>>((acc, item) => {
        acc[item.reason] = (acc[item.reason] ?? 0) + 1;
        return acc;
    }, {});
    const phaseDurations = attempts.map(({ attempt }) => {
        const findTs = (state: string) => attempt.history.find((item) => item.toState === state)?.ts ?? null;
        const detectTs = findTs("detected");
        const queueTs = findTs("queued_for_execution");
        const legATs = findTs("leg_a_pending");
        const legBTs = findTs("leg_b_pending");
        const terminalTs = attempt.history[attempt.history.length - 1]?.ts ?? null;
        return {
            detect_to_queue: detectTs !== null && queueTs !== null ? queueTs - detectTs : null,
            queue_to_leg_a: queueTs !== null && legATs !== null ? legATs - queueTs : null,
            leg_a_to_leg_b: legATs !== null && legBTs !== null ? legBTs - legATs : null,
            detect_to_terminal: detectTs !== null && terminalTs !== null ? terminalTs - detectTs : null,
        };
    });
    const averagePhaseDuration = (key: keyof typeof phaseDurations[number]) => {
        const values = phaseDurations.map((item) => item[key]).filter((value): value is number => value !== null);
        return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    const strandedDamageByTerminalState = attempts.reduce<Record<string, number>>((acc, item) => {
        const key = item.attempt.terminalState ?? "non_terminal";
        acc[key] = (acc[key] ?? 0) + (item.outcome?.partialFillDamage ?? 0);
        return acc;
    }, {});

    return {
        attemptsByTerminalState,
        transitionReasonCounts,
        averagePhaseDurationsMs: {
            detect_to_queue: averagePhaseDuration("detect_to_queue"),
            queue_to_leg_a: averagePhaseDuration("queue_to_leg_a"),
            leg_a_to_leg_b: averagePhaseDuration("leg_a_to_leg_b"),
            detect_to_terminal: averagePhaseDuration("detect_to_terminal"),
        },
        expiredAttempts: attempts.filter((item) => item.attempt.terminalState === "expired").length,
        invalidatedAttempts: attempts.filter((item) => item.attempt.terminalState === "invalidated").length,
        partialFillTerminalStates: attempts.filter((item) => item.attempt.terminalState === "partially_filled").length,
        strandedDamageByTerminalState,
    };
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
    const executionAdapter = createExecutionAdapter({
        executionMode: config.executionMode,
        liveExecutionEnabled: config.liveExecutionEnabled,
        executionKillSwitch: config.executionKillSwitch,
    });
    const settlementSource = new SettlementSource({
        mode: "prefer_explicit_recorded_resolution_event",
        allowPlaceholderFallback: config.settlementAllowPlaceholderFallback,
    });
    const trader = new PaperTrader(simulator, config, {
        maxTradesPerMarket: config.paperMaxTradesPerMarket,
        emitLogs: false,
        settlementSource,
    });
    const feeModel = new FeeModel(config);
    let wsEventsProcessed = 0;
    const missedTradeReasons = new Map<string, number>();
    let partialFills = 0;
    let pnlLostToPartial = 0;
    let firstDailyLossBlockAt: number | null = null;
    const pendingExecutions: PendingExecution[] = [];
    const executionOutcomes: ReplayExecutionOutcome[] = [];
    const replayAttempts: ReplayAttemptWithOutcome[] = [];
    const replayStrandedDamage = new StrandedDamageTracker();
    let maxEventTs = Number.NEGATIVE_INFINITY;
    let nextReplayAttemptId = 1;

    const finalizePending = (pending: PendingExecution) => {
        if (!pending.legA || !pending.legB) return;
        if (pending.legA.filledSize > 0) {
            pending.attempt.finishLegAFilled(pending.legA.attemptedAt, pending.legA.status === "partial");
            pending.attempt.startLegB(pending.legB.attemptedAt ?? pending.legA.attemptedAt);
        } else {
            const reason: ExecutionTransitionReason = pending.legA.reason === "stale_orderbook"
                ? "leg_a_failed_stale_orderbook"
                : pending.legA.queueLimitedReason === "queue_limited_no_fill"
                    ? "leg_a_failed_queue_limited"
                    : pending.legA.reason === "missing_top_of_book" || pending.legA.reason === "missing_ask"
                        ? "leg_a_failed_missing_liquidity"
                        : pending.legA.reason === "no_usable_liquidity" || pending.legA.reason.includes("depth")
                        ? "leg_a_failed_missing_liquidity"
                        : "leg_a_failed_other";
            pending.attempt.failLegA(pending.legA.attemptedAt, reason);
        }

        if (pending.legA.filledSize > 0) {
            if (pending.legB.filledSize > 0) {
                pending.attempt.finishLegBFilled(pending.legB.attemptedAt ?? pending.legA.attemptedAt, pending.legB.status === "partial");
            } else {
                const reason: ExecutionTransitionReason = pending.legB.reason === "stale_orderbook"
                    ? "leg_b_failed_stale_orderbook"
                    : pending.legB.queueLimitedReason === "queue_limited_no_fill"
                        ? "leg_b_failed_queue_limited"
                        : pending.legB.reason === "missing_top_of_book" || pending.legB.reason === "missing_ask"
                            ? "leg_b_failed_missing_liquidity"
                            : pending.legB.reason === "no_usable_liquidity" || pending.legB.reason.includes("depth")
                            ? "leg_b_failed_missing_liquidity"
                            : "leg_b_failed_other";
                pending.attempt.failLegB(
                    pending.legB.attemptedAt ?? pending.legA.attemptedAt,
                    reason,
                    pending.legA.filledSize > 0,
                );
            }
        }
        const outcome = simulator.finalizeReplayExecution({
            opportunity: pending.opportunity,
            legA: pending.legA,
            legB: pending.legB,
        });
        const attemptSnapshot = pending.attempt.snapshot();
        if (!attemptSnapshot.terminalState) {
            pending.attempt.complete(
                outcome.legBAttemptedAt ?? outcome.legAAttemptedAt,
                outcome.outcome === "partial_fill_insufficient_depth" || outcome.fullSetFill?.status === "partial",
            );
        }
        executionOutcomes.push(outcome);
        const replayAttempt = pending.attempt.snapshot();
        replayAttempts.push({ attempt: replayAttempt, outcome });
        executionAdapter.recordSimulatedOrderLifecycle(buildReplayOrderLifecycleUpdate(replayAttempt, outcome));
        replayStrandedDamage.recordExecutionOutcome({
            attempt: replayAttempt,
            outcome,
            provenance: "replay_execution_outcome",
        });
        trader.recordExecutionAttempt(replayAttempt, outcome);
        if (outcome.fullSetFill) {
            const result = trader.handleExecutedFill({
                ...pending.opportunity,
                observedAt: outcome.fullSetFill.ts,
            }, outcome.fullSetFill);
            if ("skipped" in result) {
                if (result.reason === "risk_denied" && result.risk) {
                    for (const reasonCode of result.risk.reasonCodes) {
                        countReason(reasonCode);
                        if (reasonCode === "daily_loss_limit_reached") {
                            firstDailyLossBlockAt ??= outcome.fullSetFill.ts;
                        }
                    }
                } else {
                    countReason(result.reason);
                }
            }
        }
        if (outcome.fullSetFill?.status === "partial") {
            partialFills += 1;
            pnlLostToPartial += outcome.fullSetFill.pnlLostToPartial ?? 0;
        }
    };

    const processPendingExecutions = (now: number) => {
        for (let index = pendingExecutions.length - 1; index >= 0; index -= 1) {
            const pending = pendingExecutions[index]!;
            const snapshot = pending.attempt.snapshot();
            if (!snapshot.terminalState && now >= snapshot.expiresAt) {
                pending.attempt.expire(now);
                const expiredAttempt = pending.attempt.snapshot();
                replayAttempts.push({ attempt: expiredAttempt });
                trader.recordExecutionAttempt(expiredAttempt);
                pendingExecutions.splice(index, 1);
                continue;
            }
            if (!pending.legA && now >= pending.legAPlannedAt) {
                pending.attempt.startLegA(now);
                pending.legA = simulator.simulateReplayLeg({
                    side: "yes",
                    opportunity: pending.opportunity,
                    book: store.getBookState(pending.opportunity.market.yesTokenId),
                    top: store.getTopOfBook(pending.opportunity.market.yesTokenId),
                    attemptedAt: now,
                });
                pending.legBDueAt = pending.legA.attemptedAt + config.legExecutionDriftMs;
            }
            if (pending.legA && !pending.legB && pending.legBDueAt !== null && now >= pending.legBDueAt) {
                pending.legB = simulator.simulateReplayLeg({
                    side: "no",
                    opportunity: pending.opportunity,
                    book: store.getBookState(pending.opportunity.market.noTokenId),
                    top: store.getTopOfBook(pending.opportunity.market.noTokenId),
                    attemptedAt: now,
                });
            }
            if (pending.legA && pending.legB) {
                finalizePending(pending);
                pendingExecutions.splice(index, 1);
            }
        }
    };

    const countReason = (reason: string) => {
        missedTradeReasons.set(reason, (missedTradeReasons.get(reason) ?? 0) + 1);
    };

    for (const event of events) {
        maxEventTs = Math.max(maxEventTs, event.ts);
        trader.advanceTime(event.ts);
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
        } else if (event.type === "resolution_event") {
            settlementSource.recordResolution(event.resolution);
            trader.recordResolutionEvent(event.resolution);
            trader.advanceTime(event.ts);
            processPendingExecutions(event.ts);
            continue;
        } else {
            continue;
        }
        processPendingExecutions(event.ts);
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
            const risk = trader.previewTradeRisk(evaluation.opportunity);
            const yesBook = store.getBookState(market.yesTokenId);
            const noBook = store.getBookState(market.noTokenId);
            const onlyTopLiquidityDenied = !risk.allow
                && risk.reasonCodes.length === 1
                && risk.reasonCodes[0] === "missing_required_liquidity";
            const depthBackedLiquidity =
                visibleAskDepth(yesBook, evaluation.opportunity.quote.yesAskSize) >= config.tradeSize
                && visibleAskDepth(noBook, evaluation.opportunity.quote.noAskSize) >= config.tradeSize;
            if (!risk.allow && !(onlyTopLiquidityDenied && depthBackedLiquidity)) {
                for (const reasonCode of risk.reasonCodes) {
                    countReason(reasonCode);
                    if (reasonCode === "daily_loss_limit_reached") {
                        firstDailyLossBlockAt ??= evaluation.opportunity.observedAt;
                    }
                }
                continue;
            }
            pendingExecutions.push({
                opportunity: evaluation.opportunity,
                legAPlannedAt: evaluation.opportunity.observedAt + config.executionLatencyMs,
                legBDueAt: null,
                legA: null,
                legB: null,
                attempt: (() => {
                    const attempt = new ExecutionAttemptStateMachine({
                        id: `replay-attempt-${nextReplayAttemptId++}`,
                        marketId: evaluation.opportunity.market.marketId,
                        slug: evaluation.opportunity.market.slug,
                        detectedAt: evaluation.opportunity.observedAt,
                        scheduledExecutionAt: evaluation.opportunity.observedAt + config.executionLatencyMs,
                        expiresAt: evaluation.opportunity.observedAt + config.executionLatencyMs + config.orderbookStalenessToleranceMs,
                    });
                    attempt.queue(evaluation.opportunity.observedAt);
                    executionAdapter.submitExecutionAttempt(buildExecutionRequest({
                        executionAttemptId: attempt.snapshot().id,
                        source: "replay",
                        opportunity: evaluation.opportunity,
                        requestedSize: config.tradeSize,
                        createdAtMs: evaluation.opportunity.observedAt,
                    }));
                    return attempt;
                })(),
            });
        }
        processPendingExecutions(event.ts);
    }

    const maxPendingExecutionTs = pendingExecutions.reduce((max, pending) => {
        const legBDueAt = pending.legA
            ? (pending.legBDueAt ?? (pending.legA.attemptedAt + config.legExecutionDriftMs))
            : (pending.opportunity.observedAt + config.executionLatencyMs + config.legExecutionDriftMs);
        return Math.max(max, legBDueAt);
    }, Number.NEGATIVE_INFINITY);
    const finalExecutionTs = Math.max(maxEventTs, maxPendingExecutionTs);
    if (Number.isFinite(finalExecutionTs)) {
        trader.advanceTime(finalExecutionTs);
        processPendingExecutions(finalExecutionTs);
    }

    const maxResolutionTimeMs = events
        .filter((event): event is Extract<RecordedEvent, { type: "resolution_event" }> => event.type === "resolution_event")
        .map((event) => event.resolution.resolvedAtMs)
        .filter((value) => Number.isFinite(value))
        .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
    const maxKnownEndTimeMs = Array.from(markets.values())
        .map((market) => (market.endDate ? Date.parse(market.endDate) : NaN))
        .filter((value) => Number.isFinite(value))
        .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
    const finalAdvanceTime = Math.max(
        Number.isFinite(maxResolutionTimeMs) ? maxResolutionTimeMs : Number.NEGATIVE_INFINITY,
        Number.isFinite(maxKnownEndTimeMs) ? maxKnownEndTimeMs : Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(finalAdvanceTime)) {
        trader.advanceTime(finalAdvanceTime);
    }
    const replayDamageResolutionTs = Number.isFinite(finalExecutionTs)
        ? finalExecutionTs
        : (Number.isFinite(maxEventTs) ? maxEventTs : 0);
    replayStrandedDamage.resolveAllOpen(
        replayDamageResolutionTs,
        "replay_session_end_summary",
    );

    const state = trader.getState();
    const successfulLegs = executionOutcomes.flatMap((item) => [item.legA, item.legB].filter((leg): leg is ReplayLegExecution => Boolean(leg && leg.filledSize > 0)));
    const attemptedLegs = executionOutcomes.flatMap((item) => [item.legA, item.legB].filter((leg): leg is ReplayLegExecution => Boolean(leg)));
    const sweepLegs = successfulLegs.filter((leg) => leg.fullFillMethod === "multi_level_sweep" || leg.levelsConsumedCount > 1);
    const avgLevels = successfulLegs.length > 0
        ? successfulLegs.reduce((sum, leg) => sum + leg.levelsConsumedCount, 0) / successfulLegs.length
        : 0;
    const avgFillDeviation = successfulLegs.length > 0
        ? successfulLegs.reduce((sum, leg) => sum + Math.max(0, (leg.averageFillPrice ?? 0) - (leg.detectedBestAsk ?? 0)), 0) / successfulLegs.length
        : 0;
    const avgSweepSlippage = sweepLegs.length > 0
        ? sweepLegs.reduce((sum, leg) => sum + Math.max(0, (leg.averageFillPrice ?? 0) - (leg.detectedBestAsk ?? 0)), 0) / sweepLegs.length
        : 0;
    const successfulLegsWithoutDepthLadders = successfulLegs.filter((leg) => !leg.depthUsed && leg.levelsConsumedCount <= 1).length;
    const legsWithVisibleSize = attemptedLegs.filter((leg) => (leg.visibleAvailableSize ?? 0) > 0);
    const averageVisibleToFillableHaircut = legsWithVisibleSize.length > 0
        ? legsWithVisibleSize.reduce((sum, leg) => {
            const visible = leg.visibleAvailableSize ?? 0;
            const fillable = leg.fillableAvailableSize ?? 0;
            return sum + Math.max(0, 1 - (fillable / visible));
        }, 0) / legsWithVisibleSize.length
        : 0;
    const visibleBaselineFullFillCount = executionOutcomes.filter((item) => {
        const legAVisible = (item.legA.visibleAvailableSize ?? 0) >= item.legA.requestedSize;
        const legBVisible = (item.legB?.visibleAvailableSize ?? 0) >= (item.legB?.requestedSize ?? 0);
        return legAVisible && legBVisible;
    }).length;
    const actualFullFillCount = executionOutcomes.filter((item) => item.outcome === "full_fill_top_level" || item.outcome === "full_fill_multi_level_sweep").length;
    const replayDamageSummary = replayStrandedDamage.getSummary(
        replayDamageResolutionTs,
    );
    const replayExecutionStateSummary = {
        ...summarizeExecutionAttempts(replayAttempts),
        strandedDamageByTerminalState: replayDamageSummary.strandedDamageByOriginatingTerminalState,
    };

    return {
        tradeCount: state.positionOpens,
        positionOpens: state.positionOpens,
        positionsResolved: state.positionsResolved,
        winRate: state.positionsResolved > 0 ? state.wins / state.positionsResolved : 0,
        averageEdge: state.averageEdge,
        realizedPnl: state.realizedPnl,
        dailyRealizedPnl: state.dailyRealizedPnl,
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
        dailyLossSummary: {
            dailyLossDenials: missedTradeReasons.get("daily_loss_limit_reached") ?? 0,
            firstDailyLossBlockAt,
        },
        currentState: {
            openPositionsCount: state.positions.filter((position) => position.state === "open").length,
            unresolvedPositionsCount: state.unresolvedPositions,
            unresolvedLockedExposure: state.unresolvedLockedExposure,
            openPositionsMissingTrustworthySettlementPath: state.positionsMissingTrustworthySettlementData,
            lockedExposureMissingTrustworthySettlementPath: state.lockedExposureMissingTrustworthySettlementData,
        },
        dayRollover: state.dayRollover,
        unresolvedAging: state.unresolvedAging,
        settlementSummary: {
            settlementModeUsed: state.settlementModeUsed,
            recordedExplicitResolutionEvents: state.recordedExplicitResolutionEvents,
            resolutionEventProvenanceBreakdown: state.resolutionEventProvenanceBreakdown,
            trustworthyResolutionEvents: state.trustworthyResolutionEvents,
            untrustworthyResolutionEvents: state.untrustworthyResolutionEvents,
            usedOnlyPlaceholderFallback: state.recordedExplicitResolutionEvents === 0,
            positionsResolvedByExplicitResolutionEvent: state.positionsResolvedByExplicitResolutionEvent,
            positionsResolvedByPlaceholderAssumption: state.positionsResolvedByPlaceholderAssumption,
            unresolvedPositions: state.unresolvedPositions,
            unresolvedLockedExposure: state.unresolvedLockedExposure,
            positionsMissingTrustworthySettlementData: state.positionsMissingTrustworthySettlementData,
            lockedExposureMissingTrustworthySettlementData: state.lockedExposureMissingTrustworthySettlementData,
        },
        settlementCoverage: state.settlementCoverage,
        executionOutcomes: {
            fullFillCount: executionOutcomes.filter((item) => item.outcome === "full_fill_top_level" || item.outcome === "full_fill_multi_level_sweep").length,
            fullFillTopLevelCount: executionOutcomes.filter((item) => item.outcome === "full_fill_top_level").length,
            fullFillMultiLevelSweepCount: executionOutcomes.filter((item) => item.outcome === "full_fill_multi_level_sweep").length,
            legAFillOnly: executionOutcomes.filter((item) => item.outcome === "leg_a_fill_only").length,
            legBFillOnly: executionOutcomes.filter((item) => item.outcome === "leg_b_fill_only").length,
            noFill: executionOutcomes.filter((item) => item.outcome === "no_fill").length,
            partialFillCount: executionOutcomes.filter((item) => item.outcome === "partial_both" || item.outcome === "partial_fill_insufficient_depth").length,
            depthLimitedPartialFillCount: executionOutcomes.filter((item) => item.outcome === "partial_fill_insufficient_depth").length,
            noUsableLiquidityCount: executionOutcomes.filter((item) => item.legA.reason === "no_usable_liquidity" || item.legB?.reason === "no_usable_liquidity").length,
            invalidatedBeforeSecondLegCount: executionOutcomes.filter((item) => item.invalidatedBeforeSecondLeg).length,
            queueLimitedNoFillCount: executionOutcomes.filter((item) =>
                item.legA.queueLimitedReason === "queue_limited_no_fill" || item.legB?.queueLimitedReason === "queue_limited_no_fill",
            ).length,
            queueLimitedPartialFillCount: executionOutcomes.filter((item) =>
                item.legA.queueLimitedReason === "queue_limited_partial_fill" || item.legB?.queueLimitedReason === "queue_limited_partial_fill",
            ).length,
            averageVisibleToFillableHaircut,
            queueMode: config.queuePriorityMode,
            visibleBaselineFullFillCount,
            fullFillReductionVsVisibleBaseline: Math.max(0, visibleBaselineFullFillCount - actualFullFillCount),
            executionSuccessReductionVsVisibleBaseline: visibleBaselineFullFillCount > 0
                ? Math.max(0, visibleBaselineFullFillCount - actualFullFillCount) / visibleBaselineFullFillCount
                : 0,
            partialFillDamage: executionOutcomes.reduce((sum, item) => sum + item.partialFillDamage, 0),
            averageLevelsConsumedPerSuccessfulLeg: avgLevels,
            averageFillPriceDeviationFromDetectedBestAsk: avgFillDeviation,
            averageSweepSlippageFromDepth: avgSweepSlippage,
            successfulLegsWithoutDepthLadders,
        },
        averageDetectionToExecutionDelayMs: executionOutcomes.length > 0
            ? executionOutcomes.reduce((sum, item) => sum + item.detectionToExecutionDelayMs, 0) / executionOutcomes.length
            : 0,
        opportunityInvalidationRate: executionOutcomes.length > 0
            ? executionOutcomes.filter((item) => item.opportunityInvalidated).length / executionOutcomes.length
            : 0,
        executionSuccessRate: executionOutcomes.length > 0
            ? executionOutcomes.filter((item) => item.fullSetFill !== null && item.matchedSize > 0).length / executionOutcomes.length
            : 0,
        executionDamage: replayDamageSummary,
        executionStateSummary: replayExecutionStateSummary,
        executionAttempts: replayAttempts.map((item) => item.attempt),
        strandedDamageRecords: replayStrandedDamage.getRecords(),
        executionAdapter: executionAdapter.reconcileExecutionState(),
        partialFillDamageReport: {
            partialFills,
            pnlLostToPartial,
        },
    };
}
