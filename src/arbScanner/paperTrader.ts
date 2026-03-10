import { logger } from "../logger";
import { ArbRecorder } from "./recorder";
import { ExecutionSimulator } from "./executionSimulator";
import { BinaryMarket, Opportunity, PaperTraderRuntimeBaselineCapture, PaperTraderState, RecordedResolutionEvent, ReplayExecutionOutcome, SimulatedFill } from "./types";
import { ArbScannerConfig } from "./config";
import { SimulatedPortfolio } from "../core/portfolio";
import { evaluateTradeRisk, TradeRiskDecision } from "../core/riskEngine";
import { dayBucketEndMs, dayBucketStartMs, parseUtcOffsetToMinutes } from "../util/time";
import { SettlementSource } from "../core/settlementSource";
import { ExecutionAttemptRecord, ExecutionAttemptStateMachine } from "../core/executionStateMachine";
import { StrandedDamageTracker } from "../core/strandedDamage";
import { ExecutionAdapter } from "../live/executionAdapter";
import { buildExecutionRequest } from "../live/buildExecutionRequest";

type PaperTraderOpts = {
    maxTradesPerMarket: number;
    recorder?: ArbRecorder;
    emitLogs?: boolean;
    settlementSource: SettlementSource;
    executionAdapter?: ExecutionAdapter;
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
    private currentTimeMs = 0;
    private readonly riskDayUtcOffsetMinutes: number;
    private dailyLossDenials = 0;
    private firstDailyLossBlockAt: number | null = null;
    private readonly markets = new Map<string, BinaryMarket>();
    private resolvedByExplicitResolutionEvent = 0;
    private resolvedByPlaceholderAssumption = 0;
    private recordedExplicitResolutionEvents = 0;
    private trustworthyResolutionEvents = 0;
    private untrustworthyResolutionEvents = 0;
    private readonly resolutionEventProvenanceBreakdown = new Map<string, number>();
    private readonly bucketStats = new Map<number, {
        denialCount: number;
        dailyLossDenials: number;
        firstDailyLossBlockAt: number | null;
    }>();
    private currentBucketStartMs: number | null = null;
    private rolloverCount = 0;
    private lastSummaryAtMs: number | null = null;
    private readonly executionAttempts: ExecutionAttemptRecord[] = [];
    private readonly strandedDamageTracker = new StrandedDamageTracker();
    private nextExecutionAttemptId = 1;

    constructor(
        private readonly simulator: ExecutionSimulator,
        private readonly config: ArbScannerConfig,
        private readonly opts: PaperTraderOpts,
    ) {
        this.riskDayUtcOffsetMinutes = parseUtcOffsetToMinutes(config.riskDayUtcOffset);
    }

    recordResolutionEvent(resolution: RecordedResolutionEvent) {
        this.opts.settlementSource.recordResolution(resolution);
        this.recordedExplicitResolutionEvents += 1;
        this.resolutionEventProvenanceBreakdown.set(
            resolution.provenance,
            (this.resolutionEventProvenanceBreakdown.get(resolution.provenance) ?? 0) + 1,
        );
        if (resolution.trustworthy) this.trustworthyResolutionEvents += 1;
        else this.untrustworthyResolutionEvents += 1;
        if (this.opts.emitLogs !== false) {
            logger.info(
                {
                    marketId: resolution.marketId,
                    resolvedAtMs: resolution.resolvedAtMs,
                    settlementMode: resolution.settlementMode,
                    payoutPerUnit: resolution.payoutPerUnit,
                    provenance: resolution.provenance,
                    trustworthy: resolution.trustworthy,
                    sourceLabel: resolution.sourceLabel,
                    rawSourceMetadata: resolution.rawSourceMetadata,
                },
                "Recorded explicit settlement event",
            );
        }
    }

    recordExecutionAttempt(attempt: ExecutionAttemptRecord, outcome?: ReplayExecutionOutcome) {
        this.executionAttempts.push(attempt);
        if (!outcome) return;
        const records = this.strandedDamageTracker.recordExecutionOutcome({
            attempt,
            outcome,
            provenance: attempt.id.startsWith("replay-attempt")
                ? "replay_execution_outcome"
                : "paper_execution_outcome",
        });
        if (this.opts.emitLogs !== false && records.length > 0) {
            logger.info(
                {
                    attemptId: attempt.id,
                    marketId: attempt.marketId,
                    slug: attempt.slug,
                    terminalState: attempt.terminalState,
                    strandedDamageRecords: records,
                },
                "Recorded stranded execution damage",
            );
        }
    }

    previewTradeRisk(opportunity: Opportunity): TradeRiskDecision {
        return evaluateTradeRisk({
            opportunity,
            marketState: {
                quoteAgeMs: opportunity.quote.quoteAgeMs,
                yesAskSize: opportunity.quote.yesAskSize,
                noAskSize: opportunity.quote.noAskSize,
                marketEndTimeMs: opportunity.market.endDate ? Date.parse(opportunity.market.endDate) : null,
            },
            portfolioState: this.portfolio.getSnapshot(opportunity.observedAt, this.riskDayUtcOffsetMinutes),
            config: this.config,
            now: opportunity.observedAt,
        });
    }

    handleOpportunity(opportunity: Opportunity): SimulatedFill | { skipped: true; reason: string; risk?: TradeRiskDecision } {
        return this.handlePreparedFill(opportunity, this.simulator.simulateEntry(opportunity, opportunity.observedAt), true, false);
    }

    handleExecutedFill(
        opportunity: Opportunity,
        fill: SimulatedFill,
    ): SimulatedFill | { skipped: true; reason: string; risk?: TradeRiskDecision } {
        return this.handlePreparedFill(opportunity, fill, false, true);
    }

    private handlePreparedFill(
        opportunity: Opportunity,
        fill: SimulatedFill,
        recordFill: boolean,
        skipPreTradeChecks: boolean,
    ): SimulatedFill | { skipped: true; reason: string; risk?: TradeRiskDecision } {
        this.advanceTime(opportunity.observedAt);
        this.tradeAttempts += 1;
        this.markets.set(opportunity.market.marketId, opportunity.market);
        const attempt = new ExecutionAttemptStateMachine({
            id: `paper-attempt-${this.nextExecutionAttemptId++}`,
            marketId: opportunity.market.marketId,
            slug: opportunity.market.slug,
            detectedAt: opportunity.observedAt,
            scheduledExecutionAt: opportunity.observedAt,
            expiresAt: opportunity.observedAt + this.config.orderbookStalenessToleranceMs,
        });
        attempt.queue(opportunity.observedAt);
        attempt.startLegA(opportunity.observedAt);

        const tradeCount = this.tradesByMarket.get(opportunity.market.marketId) ?? 0;
        if (!skipPreTradeChecks && tradeCount >= this.opts.maxTradesPerMarket) {
            attempt.failLegA(opportunity.observedAt, "leg_a_failed_other");
            this.recordExecutionAttempt(attempt.snapshot());
            this.countDenial("max_trades_per_market");
            return { skipped: true, reason: "max_trades_per_market" };
        }

        if (!skipPreTradeChecks) {
            const risk = this.previewTradeRisk(opportunity);
            if (!risk.allow) {
                for (const reasonCode of risk.reasonCodes) this.countDenial(reasonCode);
                if (risk.reasonCodes.includes("daily_loss_limit_reached")) {
                    this.dailyLossDenials += 1;
                    this.firstDailyLossBlockAt ??= opportunity.observedAt;
                }
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
                attempt.failLegA(opportunity.observedAt, "leg_a_failed_other");
                this.recordExecutionAttempt(attempt.snapshot());
                return { skipped: true, reason: "risk_denied", risk };
            }
        }
        if (this.opts.executionAdapter) {
            const executionRequest = buildExecutionRequest({
                executionAttemptId: attempt.snapshot().id,
                source: "paper",
                opportunity,
                requestedSize: this.config.tradeSize,
                createdAtMs: opportunity.observedAt,
            });
            const submitResult = this.opts.executionAdapter.submitExecutionAttempt(executionRequest);
            if (this.opts.emitLogs !== false) {
                logger.info(
                    {
                        executionRequest,
                        executionSubmitResult: submitResult,
                    },
                    "Created paper execution request at adapter boundary",
                );
            }
        }
        if (recordFill) this.opts.recorder?.recordSimFill(fill);

        if (fill.status === "rejected" || fill.filledSize <= 0 || fill.edgeAfter === null) {
            attempt.failLegA(fill.ts, "paper_atomic_reject");
            this.recordExecutionAttempt(attempt.snapshot());
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
        attempt.finishLegAFilled(fill.ts, fill.status === "partial");
        attempt.startLegB(fill.ts);
        attempt.finishLegBFilled(fill.ts, fill.status === "partial");
        attempt.complete(fill.ts, fill.status === "partial");
        this.recordExecutionAttempt(attempt.snapshot());
        const opened = this.portfolio.openFromFill(
            opportunity,
            fill,
            this.opts.settlementSource.getSettlementStatus({
                market: opportunity.market,
                now: opportunity.observedAt,
            }),
        );
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
                    settlementMode: opened.position.settlementMode,
                    settlementProvenance: opened.position.settlementProvenance,
                    settlementTrustworthy: opened.position.settlementTrustworthy,
                },
                "Paper position opened",
            );
        }
        return fill;
    }

    advanceTime(now: number) {
        this.currentTimeMs = Math.max(this.currentTimeMs, now);
        const nextBucketStartMs = dayBucketStartMs(this.currentTimeMs, this.riskDayUtcOffsetMinutes);
        this.ensureBucketStats(nextBucketStartMs);
        if (this.currentBucketStartMs !== null && nextBucketStartMs !== this.currentBucketStartMs) {
            this.rolloverCount += 1;
            if (this.opts.emitLogs !== false) {
                logger.info(
                    {
                        previousDayBucketStartMs: this.currentBucketStartMs,
                        nextDayBucketStartMs: nextBucketStartMs,
                        utcOffset: this.config.riskDayUtcOffset,
                    },
                    "Paper trader day rollover detected",
                );
            }
        }
        this.currentBucketStartMs = nextBucketStartMs;
        this.strandedDamageTracker.expireOpenDamageOlderThan(now, this.config.strandedDamageReportingWindowMs);
        const resolved = this.portfolio.resolvePositions(now, (position) => {
            const market = this.markets.get(position.marketId);
            if (!market) {
                return {
                    isResolved: false,
                    resolvedAtMs: null,
                    settlementMode: position.settlementMode,
                    payoutPerUnit: null,
                    provenance: "missing_market_metadata_for_settlement",
                    trustworthy: false,
                };
            }
            return this.opts.settlementSource.getSettlementStatus({ market, now });
        });
        for (const item of resolved) {
            this.positionsResolved += 1;
            if ((item.position.realizedPnl ?? 0) >= 0) this.wins += 1;
            else this.losses += 1;
            if (item.position.settlementMode === "explicit_recorded_resolution_event") {
                this.resolvedByExplicitResolutionEvent += 1;
            } else {
                this.resolvedByPlaceholderAssumption += 1;
            }
            const portfolio = this.portfolio.getSnapshot(now, this.riskDayUtcOffsetMinutes);
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
                        settlementMode: item.position.settlementMode,
                        settlementProvenance: item.position.settlementProvenance,
                        settlementTrustworthy: item.position.settlementTrustworthy,
                        settlementGrossPayout: item.position.settlementGrossPayout,
                        realizedPnlDelta: item.realizedPnlDelta,
                        cumulativeRealizedPnl: portfolio.realizedPnl,
                    },
                    "Paper position resolved",
                );
            }
        }
        if (this.opts.emitLogs !== false && (this.lastSummaryAtMs === null || now - this.lastSummaryAtMs >= this.config.paperSummaryIntervalMs)) {
            this.lastSummaryAtMs = now;
            const state = this.getState();
            logger.info(
                {
                    tradeAttempts: state.tradeAttempts,
                    positionOpens: state.positionOpens,
                    positionsResolved: state.positionsResolved,
                    realizedPnl: state.realizedPnl,
                    dailyRealizedPnl: state.dailyRealizedPnl,
                    openPositions: state.positions.filter((position) => position.state === "open").length,
                    unresolvedLockedExposure: state.unresolvedLockedExposure,
                    executionDamage: state.executionDamage,
                    executionStateSummary: state.executionStateSummary,
                    dayRollover: state.dayRollover,
                    unresolvedAging: state.unresolvedAging,
                    settlementCoverage: state.settlementCoverage,
                },
                "Paper trader summary",
            );
        }
    }

    getState(): PaperTraderState {
        const now = this.currentTimeMs || Date.now();
        const portfolio = this.portfolio.getSnapshot(now, this.riskDayUtcOffsetMinutes);
        const averageEdge = this.edges.length > 0
            ? this.edges.reduce((sum, value) => sum + value, 0) / this.edges.length
            : 0;
        const openPositions = portfolio.positions.filter((position) => position.state === "open");
        const positionsMissingTrustworthySettlementData = openPositions.filter((position) => {
            const market = this.markets.get(position.marketId);
            if (!market) return true;
            return !this.opts.settlementSource.getSettlementStatus({ market, now }).trustworthy;
        });
        const unresolvedPositionsMissingEndTime = openPositions.filter((position) => position.marketEndTimeMs === null).length;
        const openAges = openPositions.map((position) => now - position.openedAt);
        const countsOlderThanThresholds = Object.fromEntries(
            this.config.openPositionAgeThresholdsMs.map((thresholdMs) => [
                String(thresholdMs),
                openAges.filter((age) => age >= thresholdMs).length,
            ]),
        );
        const oldestByMarket = Array.from(
            openPositions.reduce<Map<string, {
                marketId: string;
                slug: string;
                openPositions: number;
                unresolvedLockedExposure: number;
                oldestOpenPositionAgeMs: number;
                missingTrustworthySettlementCount: number;
            }>>((acc, position) => {
                const ageMs = now - position.openedAt;
                const entry = acc.get(position.marketId) ?? {
                    marketId: position.marketId,
                    slug: position.slug,
                    openPositions: 0,
                    unresolvedLockedExposure: 0,
                    oldestOpenPositionAgeMs: ageMs,
                    missingTrustworthySettlementCount: 0,
                };
                entry.openPositions += 1;
                entry.unresolvedLockedExposure += position.lockedNotional;
                entry.oldestOpenPositionAgeMs = Math.max(entry.oldestOpenPositionAgeMs, ageMs);
                if (!position.settlementTrustworthy) entry.missingTrustworthySettlementCount += 1;
                acc.set(position.marketId, entry);
                return acc;
            }, new Map()).values(),
        )
            .sort((a, b) => b.oldestOpenPositionAgeMs - a.oldestOpenPositionAgeMs)
            .slice(0, 5);
        const bucketSummaries = Array.from(this.bucketStats.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([bucketStartMs, stats]) => ({
                dayBucketStartMs: bucketStartMs,
                dayBucketEndMs: bucketStartMs + 86_400_000,
                denialCount: stats.denialCount,
                dailyLossDenials: stats.dailyLossDenials,
                firstDailyLossBlockAt: stats.firstDailyLossBlockAt,
            }));
        const denialsBeforeFirstRollover = bucketSummaries[0]?.denialCount ?? 0;
        const denialsAfterFirstRollover = bucketSummaries.slice(1).reduce((sum, bucket) => sum + bucket.denialCount, 0);
        const provenanceBreakdown = portfolio.positions.reduce<Record<string, number>>((acc, position) => {
            acc[position.settlementProvenance] = (acc[position.settlementProvenance] ?? 0) + 1;
            return acc;
        }, {});
        const executionDamageSummary = this.strandedDamageTracker.getSummary(now);
        const attemptsByTerminalState = this.executionAttempts.reduce<Record<string, number>>((acc, attempt) => {
            const key = attempt.terminalState ?? "non_terminal";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
        }, {});
        const transitionReasonCounts = this.executionAttempts.flatMap((attempt) => attempt.history).reduce<Record<string, number>>((acc, item) => {
            acc[item.reason] = (acc[item.reason] ?? 0) + 1;
            return acc;
        }, {});
        const phaseDurations = this.executionAttempts.map((attempt) => {
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
        return {
            tradeAttempts: this.tradeAttempts,
            positionOpens: this.positionOpens,
            positionsResolved: this.positionsResolved,
            wins: this.wins,
            losses: this.losses,
            averageEdge,
            realizedPnl: portfolio.realizedPnl,
            dailyRealizedPnl: portfolio.dailyRealizedPnl,
            maxDrawdown: this.maxDrawdown,
            grossOpenNotional: portfolio.grossOpenNotional,
            unrealizedPnlMarkedToMarket: null,
            releasedExposure: portfolio.releasedExposure,
            denialCounts: Object.fromEntries(this.denialCounts.entries()),
            dailyLossDenials: this.dailyLossDenials,
            firstDailyLossBlockAt: this.firstDailyLossBlockAt,
            dayRollover: {
                currentDayBucketStartMs: portfolio.dayBucketStartMs,
                currentDayBucketEndMs: dayBucketEndMs(now, this.riskDayUtcOffsetMinutes),
                currentUtcOffset: this.config.riskDayUtcOffset,
                rolloverOccurred: this.rolloverCount > 0,
                rolloverCount: this.rolloverCount,
                denialsBeforeFirstRollover,
                denialsAfterFirstRollover,
                bucketSummaries,
            },
            unresolvedAging: {
                oldestOpenPositionAgeMs: openAges.length > 0 ? Math.max(...openAges) : null,
                newestOpenPositionAgeMs: openAges.length > 0 ? Math.min(...openAges) : null,
                averageOpenPositionAgeMs: openAges.length > 0
                    ? openAges.reduce((sum, value) => sum + value, 0) / openAges.length
                    : null,
                countsOlderThanThresholds,
                oldestUnresolvedByMarket: oldestByMarket,
            },
            settlementCoverage: {
                positionsResolvedByExplicitResolutionEvent: this.resolvedByExplicitResolutionEvent,
                positionsResolvedByPlaceholderAssumption: this.resolvedByPlaceholderAssumption,
                positionsUnresolvedNoTrustworthySettlementPath: positionsMissingTrustworthySettlementData.length,
                positionsUnresolvedMissingEndTime: unresolvedPositionsMissingEndTime,
                provenanceBreakdown,
            },
            executionDamage: executionDamageSummary,
            executionStateSummary: {
                attemptsByTerminalState,
                transitionReasonCounts,
                averagePhaseDurationsMs: {
                    detect_to_queue: averagePhaseDuration("detect_to_queue"),
                    queue_to_leg_a: averagePhaseDuration("queue_to_leg_a"),
                    leg_a_to_leg_b: averagePhaseDuration("leg_a_to_leg_b"),
                    detect_to_terminal: averagePhaseDuration("detect_to_terminal"),
                },
                expiredAttempts: attemptsByTerminalState.expired ?? 0,
                invalidatedAttempts: attemptsByTerminalState.invalidated ?? 0,
                partialFillTerminalStates: attemptsByTerminalState.partially_filled ?? 0,
                strandedDamageByTerminalState: executionDamageSummary.strandedDamageByOriginatingTerminalState,
            },
            settlementModeUsed: this.opts.settlementSource.describeSelectionMode(),
            recordedExplicitResolutionEvents: this.recordedExplicitResolutionEvents,
            resolutionEventProvenanceBreakdown: Object.fromEntries(this.resolutionEventProvenanceBreakdown.entries()),
            trustworthyResolutionEvents: this.trustworthyResolutionEvents,
            untrustworthyResolutionEvents: this.untrustworthyResolutionEvents,
            positionsResolvedByExplicitResolutionEvent: this.resolvedByExplicitResolutionEvent,
            positionsResolvedByPlaceholderAssumption: this.resolvedByPlaceholderAssumption,
            unresolvedPositions: openPositions.length,
            unresolvedLockedExposure: openPositions.reduce((sum, position) => sum + position.lockedNotional, 0),
            positionsMissingTrustworthySettlementData: positionsMissingTrustworthySettlementData.length,
            lockedExposureMissingTrustworthySettlementData: positionsMissingTrustworthySettlementData
                .reduce((sum, position) => sum + position.lockedNotional, 0),
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
                settlementMode: position.settlementMode,
                settlementTrustworthy: position.settlementTrustworthy,
            })),
            strandedDamageRecords: this.strandedDamageTracker.getRecords(),
        };
    }

    getExecutionAttempts(): ExecutionAttemptRecord[] {
        return this.executionAttempts.map((attempt) => ({
            ...attempt,
            history: attempt.history.map((item) => ({ ...item })),
        }));
    }

    captureRuntimeBaseline(capturedAtMs = this.currentTimeMs || Date.now()): PaperTraderRuntimeBaselineCapture {
        const state = this.getState();
        return {
            provenance: "future_runtime_internal_baseline_capture",
            sourceLabel: "paper_trader_runtime_state",
            capturedAtMs,
            account: {
                snapshot: null,
                available: false,
                reason: "unavailable_runtime_account_state",
            },
            rawSourceMetadata: {
                tradeAttempts: state.tradeAttempts,
                positionOpens: state.positionOpens,
                positionsResolved: state.positionsResolved,
                realizedPnl: state.realizedPnl,
                grossOpenNotional: state.grossOpenNotional,
                unresolvedPositions: state.unresolvedPositions,
                unresolvedLockedExposure: state.unresolvedLockedExposure,
            },
        };
    }

    private countDenial(reason: string, ts = this.currentTimeMs || Date.now()) {
        this.denialCounts.set(reason, (this.denialCounts.get(reason) ?? 0) + 1);
        const bucketStartMs = dayBucketStartMs(ts, this.riskDayUtcOffsetMinutes);
        const current = this.ensureBucketStats(bucketStartMs);
        current.denialCount += 1;
        if (reason === "daily_loss_limit_reached") {
            current.dailyLossDenials += 1;
            current.firstDailyLossBlockAt ??= ts;
        }
        this.bucketStats.set(bucketStartMs, current);
    }

    private ensureBucketStats(bucketStartMs: number) {
        const current = this.bucketStats.get(bucketStartMs) ?? {
            denialCount: 0,
            dailyLossDenials: 0,
            firstDailyLossBlockAt: null,
        };
        this.bucketStats.set(bucketStartMs, current);
        return current;
    }
}
