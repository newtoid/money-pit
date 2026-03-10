import { ArbScannerConfig } from "./config";
import {
    BookState,
    ExecutionSimConfig,
    Opportunity,
    ReplayConsumedLevel,
    ReplayExecutionOutcome,
    ReplayLegExecution,
    SimulatedFill,
    TopOfBook,
} from "./types";

function roundSize(size: number) {
    return Math.floor(size * 100) / 100;
}

function clampPrice(price: number) {
    return Math.max(0.001, Math.min(0.999, price));
}

function tickBufferPrice(ticks: number) {
    return ticks * 0.01;
}

function buildAskLevels(book: BookState | null, top: TopOfBook): ReplayConsumedLevel[] {
    if (book && book.asks.length > 0) {
        return book.asks.map((level) => ({
            price: level.price,
            displayedSize: level.size,
            fillableSize: 0,
            consumedSize: 0,
            queueHaircutApplied: 0,
        }));
    }
    if (top.ask !== null) {
        return [{
            price: top.ask,
            displayedSize: top.askSize,
            fillableSize: 0,
            consumedSize: 0,
            queueHaircutApplied: 0,
        }];
    }
    return [];
}

export function buildExecutionSimConfig(config: ArbScannerConfig): ExecutionSimConfig {
    return {
        requestedSize: config.tradeSize,
        slippagePerLeg: config.simSlippagePerLeg,
        partialFillRatio: config.simPartialFillRatio,
        partialFillMode: config.simPartialFillMode,
        partialFillProbability: config.simPartialFillProbability,
        requireFullFill: config.simRequireFullFill,
        requireKnownSize: config.simRequireKnownSize,
        executionLatencyMs: config.executionLatencyMs,
        legExecutionDriftMs: config.legExecutionDriftMs,
        orderbookStalenessToleranceMs: config.orderbookStalenessToleranceMs,
        maxBookLevelsToSimulate: config.maxBookLevelsToSimulate,
        allowMultiLevelSweep: config.allowMultiLevelSweep,
        depthSlippageBufferTicks: config.depthSlippageBufferTicks,
        queuePriorityMode: config.queuePriorityMode,
        queueHaircutRatio: config.queueHaircutRatio,
        minVisibleSizeToAssumeFill: config.minVisibleSizeToAssumeFill,
        maxQueuePenaltyLevels: config.maxQueuePenaltyLevels,
    };
}

function deterministicRoll(parts: Array<string | number>): number {
    const text = parts.join("|");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 100000) / 100000;
}

export class ExecutionSimulator {
    constructor(private readonly config: ExecutionSimConfig) {}

    private fillableSizeForLevel(displayedSize: number, levelIndex: number): { fillableSize: number; haircutApplied: number } {
        if (this.config.queuePriorityMode === "optimistic_visible_depth") {
            return { fillableSize: displayedSize, haircutApplied: 0 };
        }
        if (this.config.queuePriorityMode === "strict_top_priority_block") {
            if (levelIndex > 0 || displayedSize < this.config.minVisibleSizeToAssumeFill) {
                return { fillableSize: 0, haircutApplied: 1 };
            }
            return { fillableSize: displayedSize, haircutApplied: 0 };
        }

        const penaltyIndex = Math.min(levelIndex, this.config.maxQueuePenaltyLevels - 1);
        const depthPenalty = 1 / (penaltyIndex + 1);
        const ratio = this.config.queueHaircutRatio * depthPenalty;
        const fillableSize = displayedSize >= this.config.minVisibleSizeToAssumeFill
            ? displayedSize * ratio
            : 0;
        const roundedFillable = roundSize(fillableSize);
        const haircutApplied = displayedSize > 0 ? Math.max(0, 1 - (roundedFillable / displayedSize)) : 1;
        return { fillableSize: roundedFillable, haircutApplied };
    }

    simulateEntry(opportunity: Opportunity, ts = Date.now()): SimulatedFill {
        const yesAvailable = opportunity.quote.yesAskSize;
        const noAvailable = opportunity.quote.noAskSize;
        if (this.config.requireKnownSize && (yesAvailable === null || noAvailable === null)) {
            return this.reject(opportunity, ts, "unknown_leg_size");
        }

        const cappedByBook = Math.min(
            this.config.requestedSize,
            yesAvailable ?? this.config.requestedSize,
            noAvailable ?? this.config.requestedSize,
        );
        const filledSize = roundSize(cappedByBook * this.config.partialFillRatio);
        if (filledSize <= 0) {
            return this.reject(opportunity, ts, "insufficient_size");
        }
        if (this.config.requireFullFill && filledSize < this.config.requestedSize) {
            return this.reject(opportunity, ts, "partial_fill_not_allowed");
        }

        const yesPrice = clampPrice(opportunity.quote.yesAsk + this.config.slippagePerLeg);
        const noPrice = clampPrice(opportunity.quote.noAsk + this.config.slippagePerLeg);
        const totalAllInPerUnit = yesPrice + noPrice + opportunity.cost.totalCostBuffer;
        const edgeAfter = 1 - totalAllInPerUnit;
        const realizedPnl = filledSize * edgeAfter;
        const fullSizePnlEquivalent = this.config.requestedSize * edgeAfter;
        const pnlLostToPartial = fullSizePnlEquivalent - realizedPnl;

        return {
            ts,
            marketId: opportunity.market.marketId,
            slug: opportunity.market.slug,
            status: filledSize < this.config.requestedSize ? "partial" : "filled",
            requestedSize: this.config.requestedSize,
            filledSize,
            yesPrice,
            noPrice,
            totalAllInPerUnit,
            edgeBefore: opportunity.edge,
            edgeAfter,
            realizedPnl,
            fullSizePnlEquivalent,
            pnlLostToPartial,
            quoteAgeMs: opportunity.quote.quoteAgeMs,
            reason: filledSize < this.config.requestedSize ? "partial_fill_assumption" : "filled",
        };
    }

    simulateReplayLeg(args: {
        side: "yes" | "no";
        opportunity: Opportunity;
        book: BookState | null;
        top: TopOfBook | null;
        attemptedAt: number;
    }): ReplayLegExecution {
        const { side, opportunity, book, top, attemptedAt } = args;
        const detectedBestAsk = side === "yes" ? opportunity.quote.yesAsk : opportunity.quote.noAsk;

        if (!top) {
            return {
                side,
                attemptedAt,
                topUpdatedAt: null,
                topAgeMs: null,
                detectedBestAsk,
                availableSize: null,
                visibleAvailableSize: null,
                fillableAvailableSize: null,
                requestedSize: this.config.requestedSize,
                filledSize: 0,
                price: null,
                averageFillPrice: null,
                levelsConsumed: [],
                levelsConsumedCount: 0,
                unfilledRemainder: this.config.requestedSize,
                fullFillMethod: null,
                depthUsed: false,
                queueMode: this.config.queuePriorityMode,
                queueLimited: false,
                queueLimitedReason: null,
                averageQueueHaircutApplied: null,
                status: "failed",
                reason: "missing_top_of_book",
            };
        }
        if (top.ask === null) {
            return {
                side,
                attemptedAt,
                topUpdatedAt: top.updatedAt,
                topAgeMs: Math.max(0, attemptedAt - top.updatedAt),
                detectedBestAsk,
                availableSize: top.askSize,
                visibleAvailableSize: top.askSize,
                fillableAvailableSize: null,
                requestedSize: this.config.requestedSize,
                filledSize: 0,
                price: null,
                averageFillPrice: null,
                levelsConsumed: [],
                levelsConsumedCount: 0,
                unfilledRemainder: this.config.requestedSize,
                fullFillMethod: null,
                depthUsed: false,
                queueMode: this.config.queuePriorityMode,
                queueLimited: false,
                queueLimitedReason: null,
                averageQueueHaircutApplied: null,
                status: "failed",
                reason: "missing_ask",
            };
        }

        const topAgeMs = Math.max(0, attemptedAt - top.updatedAt);
        if (topAgeMs > this.config.orderbookStalenessToleranceMs) {
            return {
                side,
                attemptedAt,
                topUpdatedAt: top.updatedAt,
                topAgeMs,
                detectedBestAsk,
                availableSize: top.askSize,
                visibleAvailableSize: top.askSize,
                fillableAvailableSize: null,
                requestedSize: this.config.requestedSize,
                filledSize: 0,
                price: null,
                averageFillPrice: null,
                levelsConsumed: [],
                levelsConsumedCount: 0,
                unfilledRemainder: this.config.requestedSize,
                fullFillMethod: null,
                depthUsed: false,
                queueMode: this.config.queuePriorityMode,
                queueLimited: false,
                queueLimitedReason: null,
                averageQueueHaircutApplied: null,
                status: "failed",
                reason: "stale_orderbook",
            };
        }

        const depthLevels = buildAskLevels(book, top).slice(0, this.config.maxBookLevelsToSimulate);
        const effectiveLevels = this.config.allowMultiLevelSweep ? depthLevels : depthLevels.slice(0, 1);
        const visibleAvailableSize = effectiveLevels.reduce((sum, level) => sum + (level.displayedSize ?? 0), 0);
        let fillableAvailableSize = 0;
        effectiveLevels.forEach((level, index) => {
            const displayedSize = level.displayedSize ?? 0;
            const { fillableSize, haircutApplied } = this.fillableSizeForLevel(displayedSize, index);
            level.fillableSize = fillableSize;
            level.queueHaircutApplied = haircutApplied;
            fillableAvailableSize += fillableSize;
        });
        const availableSize = fillableAvailableSize;
        if (this.config.requireKnownSize && effectiveLevels.some((level) => level.displayedSize === null)) {
            return {
                side,
                attemptedAt,
                topUpdatedAt: top.updatedAt,
                topAgeMs,
                detectedBestAsk,
                availableSize: availableSize > 0 ? availableSize : null,
                visibleAvailableSize,
                fillableAvailableSize: availableSize > 0 ? availableSize : 0,
                requestedSize: this.config.requestedSize,
                filledSize: 0,
                price: null,
                averageFillPrice: null,
                levelsConsumed: [],
                levelsConsumedCount: 0,
                unfilledRemainder: this.config.requestedSize,
                fullFillMethod: null,
                depthUsed: effectiveLevels.length > 1,
                queueMode: this.config.queuePriorityMode,
                queueLimited: false,
                queueLimitedReason: null,
                averageQueueHaircutApplied: null,
                status: "failed",
                reason: "unknown_leg_size",
            };
        }

        let remaining = this.config.requestedSize;
        const levelsConsumed: ReplayConsumedLevel[] = [];
        for (const level of effectiveLevels) {
            if (remaining <= 0) break;
            if (level.fillableSize <= 0) continue;
            const consumedSize = Math.min(remaining, level.fillableSize);
            if (consumedSize <= 0) continue;
            remaining -= consumedSize;
            levelsConsumed.push({
                price: level.price,
                displayedSize: level.displayedSize,
                fillableSize: level.fillableSize,
                consumedSize,
                queueHaircutApplied: level.queueHaircutApplied,
            });
        }

        let filledSize = roundSize(levelsConsumed.reduce((sum, level) => sum + level.consumedSize, 0));
        let reason = "no_usable_liquidity";
        if (this.config.partialFillMode === "none") {
            if (filledSize >= this.config.requestedSize) {
                reason = levelsConsumed.length > 1 ? "multi_level_sweep_fill" : "filled";
            } else {
                filledSize = 0;
                levelsConsumed.length = 0;
                remaining = this.config.requestedSize;
                reason = effectiveLevels.length > 0 ? "insufficient_depth" : "no_usable_liquidity";
            }
        } else if (this.config.partialFillMode === "probabilistic") {
            const roll = deterministicRoll([opportunity.market.marketId, side, attemptedAt, top.ask, top.askSize ?? "unknown"]);
            if (roll > this.config.simPartialFillProbability) {
                filledSize = roundSize(filledSize * this.config.partialFillRatio);
                if (filledSize <= 0) {
                    levelsConsumed.length = 0;
                    remaining = this.config.requestedSize;
                }
                reason = filledSize > 0 ? "probabilistic_partial_fill" : "probabilistic_no_fill";
            } else {
                reason = filledSize >= this.config.requestedSize
                    ? (levelsConsumed.length > 1 ? "probabilistic_multi_level_fill" : "probabilistic_full_fill")
                    : "probabilistic_partial_fill";
            }
        } else {
            reason = filledSize >= this.config.requestedSize
                ? (levelsConsumed.length > 1 ? "multi_level_sweep_fill" : "filled")
                : (filledSize > 0 ? "depth_limited_partial_fill" : "no_usable_liquidity");
        }

        const unfilledRemainder = roundSize(Math.max(0, this.config.requestedSize - filledSize));
        if (filledSize <= 0) {
            return {
                side,
                attemptedAt,
                topUpdatedAt: top.updatedAt,
                topAgeMs,
                detectedBestAsk,
                availableSize: availableSize > 0 ? availableSize : top.askSize,
                visibleAvailableSize,
                fillableAvailableSize,
                requestedSize: this.config.requestedSize,
                filledSize: 0,
                price: null,
                averageFillPrice: null,
                levelsConsumed: [],
                levelsConsumedCount: 0,
                unfilledRemainder: this.config.requestedSize,
                fullFillMethod: null,
                depthUsed: effectiveLevels.length > 1,
                queueMode: this.config.queuePriorityMode,
                queueLimited: visibleAvailableSize > 0 && fillableAvailableSize <= 0,
                queueLimitedReason: visibleAvailableSize > 0 && fillableAvailableSize <= 0 ? "queue_limited_no_fill" : null,
                averageQueueHaircutApplied: effectiveLevels.length > 0
                    ? effectiveLevels.reduce((sum, level) => sum + level.queueHaircutApplied, 0) / effectiveLevels.length
                    : null,
                status: "failed",
                reason,
            };
        }

        const weightedPrice = levelsConsumed.reduce((sum, level) => sum + (level.price * level.consumedSize), 0) / filledSize;
        const averageFillPrice = clampPrice(
            weightedPrice + this.config.slippagePerLeg + tickBufferPrice(this.config.depthSlippageBufferTicks),
        );

        return {
            side,
            attemptedAt,
            topUpdatedAt: top.updatedAt,
            topAgeMs,
            detectedBestAsk,
            availableSize: availableSize > 0 ? availableSize : top.askSize,
            visibleAvailableSize,
            fillableAvailableSize,
            requestedSize: this.config.requestedSize,
            filledSize,
            price: averageFillPrice,
            averageFillPrice,
            levelsConsumed,
            levelsConsumedCount: levelsConsumed.length,
            unfilledRemainder,
            fullFillMethod: filledSize >= this.config.requestedSize
                ? (levelsConsumed.length > 1 ? "multi_level_sweep" : "top_level")
                : null,
            depthUsed: effectiveLevels.length > 1,
            queueMode: this.config.queuePriorityMode,
            queueLimited: fillableAvailableSize < visibleAvailableSize,
            queueLimitedReason: fillableAvailableSize < visibleAvailableSize
                ? (filledSize < this.config.requestedSize ? "queue_limited_partial_fill" : null)
                : null,
            averageQueueHaircutApplied: effectiveLevels.length > 0
                ? effectiveLevels.reduce((sum, level) => sum + level.queueHaircutApplied, 0) / effectiveLevels.length
                : null,
            status: filledSize < this.config.requestedSize ? "partial" : "filled",
            reason,
        };
    }

    finalizeReplayExecution(args: {
        opportunity: Opportunity;
        legA: ReplayLegExecution;
        legB: ReplayLegExecution | null;
    }): ReplayExecutionOutcome {
        const { opportunity, legA, legB } = args;
        const legBFilledSize = legB?.filledSize ?? 0;
        const matchedSize = roundSize(Math.min(legA.filledSize, legBFilledSize));
        const totalFilledSize = legA.filledSize + legBFilledSize;
        const strandedSize = roundSize(Math.max(0, totalFilledSize - (matchedSize * 2)));
        const legAPrice = legA.averageFillPrice ?? legA.price ?? 0;
        const legBPrice = legB?.averageFillPrice ?? legB?.price ?? 0;
        const strandedNotional = roundSize(Math.max(legA.filledSize - matchedSize, 0) * legAPrice)
            + roundSize(Math.max(legBFilledSize - matchedSize, 0) * legBPrice);

        let fullSetFill: SimulatedFill | null = null;
        let opportunityInvalidated = true;
        if (matchedSize > 0 && legB?.averageFillPrice !== null && legA.averageFillPrice !== null) {
            const totalAllInPerUnit = legA.averageFillPrice + legB.averageFillPrice + opportunity.cost.totalCostBuffer;
            const edgeAfter = 1 - totalAllInPerUnit;
            opportunityInvalidated = edgeAfter < 0;
            fullSetFill = {
                ts: legB.attemptedAt,
                marketId: opportunity.market.marketId,
                slug: opportunity.market.slug,
                status: matchedSize < this.config.requestedSize ? "partial" : "filled",
                requestedSize: this.config.requestedSize,
                filledSize: matchedSize,
                yesPrice: legA.side === "yes" ? legA.averageFillPrice : legB.averageFillPrice,
                noPrice: legA.side === "no" ? legA.averageFillPrice : legB.averageFillPrice,
                totalAllInPerUnit,
                edgeBefore: opportunity.edge,
                edgeAfter,
                realizedPnl: matchedSize * edgeAfter,
                fullSizePnlEquivalent: this.config.requestedSize * edgeAfter,
                pnlLostToPartial: (this.config.requestedSize * edgeAfter) - (matchedSize * edgeAfter),
                quoteAgeMs: opportunity.quote.quoteAgeMs,
                reason: matchedSize < this.config.requestedSize ? "partial_replay_fill" : "replay_fill",
            };
        }

        let outcome: ReplayExecutionOutcome["outcome"] = "no_fill";
        if (legA.filledSize > 0 && legBFilledSize > 0 && matchedSize >= this.config.requestedSize) {
            outcome = legA.fullFillMethod === "multi_level_sweep" || legB?.fullFillMethod === "multi_level_sweep"
                ? "full_fill_multi_level_sweep"
                : "full_fill_top_level";
        } else if (legA.filledSize > 0 && legBFilledSize > 0) {
            outcome = "partial_fill_insufficient_depth";
        } else if (legA.filledSize > 0) {
            outcome = "leg_a_fill_only";
        } else if (legBFilledSize > 0) {
            outcome = "leg_b_fill_only";
        }

        const partialFillDamage = roundSize(strandedNotional + Math.max(0, fullSetFill?.pnlLostToPartial ?? 0));

        return {
            marketId: opportunity.market.marketId,
            slug: opportunity.market.slug,
            detectedAt: opportunity.observedAt,
            legAPlannedAt: opportunity.observedAt + this.config.executionLatencyMs,
            legAAttemptedAt: legA.attemptedAt,
            legBAttemptedAt: legB?.attemptedAt ?? null,
            detectionToExecutionDelayMs: legA.attemptedAt - opportunity.observedAt,
            opportunityInvalidated,
            outcome,
            legA,
            legB,
            matchedSize,
            strandedSize,
            strandedNotional,
            partialFillDamage,
            depthLimited: legA.reason.includes("depth") || Boolean(legB?.reason.includes("depth")) || outcome === "partial_fill_insufficient_depth",
            invalidatedBeforeSecondLeg: legA.filledSize > 0 && (legB?.filledSize ?? 0) <= 0,
            queueLimited: legA.queueLimited || Boolean(legB?.queueLimited),
            fullSetFill,
        };
    }

    private reject(opportunity: Opportunity, ts: number, reason: string): SimulatedFill {
        return {
            ts,
            marketId: opportunity.market.marketId,
            slug: opportunity.market.slug,
            status: "rejected",
            requestedSize: this.config.requestedSize,
            filledSize: 0,
            yesPrice: null,
            noPrice: null,
            totalAllInPerUnit: null,
            edgeBefore: opportunity.edge,
            edgeAfter: null,
            realizedPnl: 0,
            fullSizePnlEquivalent: null,
            pnlLostToPartial: null,
            quoteAgeMs: opportunity.quote.quoteAgeMs,
            reason,
        };
    }
}
