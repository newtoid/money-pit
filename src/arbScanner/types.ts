export type BinarySide = "yes" | "no";

export type BookLevel = {
    price: number;
    size: number | null;
};

export type BinaryMarket = {
    marketId: string;
    conditionId: string | null;
    slug: string;
    question: string;
    eventSlug: string | null;
    tagSlugs: string[];
    tagLabels: string[];
    yesTokenId: string;
    noTokenId: string;
    tokenMappingSource: "outcomes" | "index_fallback";
    active: boolean;
    closed: boolean;
    archived: boolean;
    endDate: string | null;
    liquidityNum: number | null;
    volumeNum: number | null;
    feeRaw: string | null;
    feesEnabled: boolean | null;
};

export type TopOfBook = {
    bid: number | null;
    ask: number | null;
    bidSize: number | null;
    askSize: number | null;
    updatedAt: number;
};

export type BookState = TopOfBook & {
    bids: BookLevel[];
    asks: BookLevel[];
};

export type OpportunityQuote = {
    yesAsk: number;
    noAsk: number;
    yesAskSize: number | null;
    noAskSize: number | null;
    quoteAgeMs: number;
};

export type OpportunityCost = {
    explicitCostBuffer: number;
    feeCost: number;
    totalCostBuffer: number;
    notes: string[];
};

export type Opportunity = {
    market: BinaryMarket;
    quote: OpportunityQuote;
    cost: OpportunityCost;
    totalAllIn: number;
    edge: number;
    observedAt: number;
};

export type ArbEvaluation = {
    market: BinaryMarket;
    observedAt: number;
    reason:
        | "ok"
        | "missing_top_of_book"
        | "missing_ask"
        | "stale_quote"
        | "below_min_edge";
    opportunity: Opportunity | null;
};

export type ExecutionSimConfig = {
    requestedSize: number;
    slippagePerLeg: number;
    partialFillRatio: number;
    partialFillMode: "none" | "probabilistic" | "liquidity_limited";
    partialFillProbability: number;
    requireFullFill: boolean;
    requireKnownSize: boolean;
    executionLatencyMs: number;
    legExecutionDriftMs: number;
    orderbookStalenessToleranceMs: number;
    maxBookLevelsToSimulate: number;
    allowMultiLevelSweep: boolean;
    depthSlippageBufferTicks: number;
    queuePriorityMode: "optimistic_visible_depth" | "conservative_queue_haircut" | "strict_top_priority_block";
    queueHaircutRatio: number;
    minVisibleSizeToAssumeFill: number;
    maxQueuePenaltyLevels: number;
};

export type ReplayConsumedLevel = {
    price: number;
    displayedSize: number | null;
    fillableSize: number;
    consumedSize: number;
    queueHaircutApplied: number;
};

export type ReplayLegExecution = {
    side: BinarySide;
    attemptedAt: number;
    topUpdatedAt: number | null;
    topAgeMs: number | null;
    detectedBestAsk: number | null;
    availableSize: number | null;
    visibleAvailableSize: number | null;
    fillableAvailableSize: number | null;
    requestedSize: number;
    filledSize: number;
    price: number | null;
    averageFillPrice: number | null;
    levelsConsumed: ReplayConsumedLevel[];
    levelsConsumedCount: number;
    unfilledRemainder: number;
    fullFillMethod: "top_level" | "multi_level_sweep" | null;
    depthUsed: boolean;
    queueMode: ExecutionSimConfig["queuePriorityMode"];
    queueLimited: boolean;
    queueLimitedReason: "queue_limited_no_fill" | "queue_limited_partial_fill" | null;
    averageQueueHaircutApplied: number | null;
    status: "filled" | "partial" | "failed";
    reason: string;
};

export type ReplayExecutionOutcomeType =
    | "full_fill_top_level"
    | "full_fill_multi_level_sweep"
    | "leg_a_fill_only"
    | "leg_b_fill_only"
    | "no_fill"
    | "partial_both"
    | "partial_fill_insufficient_depth";

export type ReplayExecutionOutcome = {
    marketId: string;
    slug: string;
    detectedAt: number;
    legAPlannedAt: number;
    legAAttemptedAt: number;
    legBAttemptedAt: number | null;
    detectionToExecutionDelayMs: number;
    opportunityInvalidated: boolean;
    outcome: ReplayExecutionOutcomeType;
    legA: ReplayLegExecution;
    legB: ReplayLegExecution | null;
    matchedSize: number;
    strandedSize: number;
    strandedNotional: number;
    partialFillDamage: number;
    depthLimited: boolean;
    invalidatedBeforeSecondLeg: boolean;
    queueLimited: boolean;
    fullSetFill: SimulatedFill | null;
};

export type SimulatedFill = {
    ts: number;
    marketId: string;
    slug: string;
    status: "filled" | "partial" | "rejected";
    requestedSize: number;
    filledSize: number;
    yesPrice: number | null;
    noPrice: number | null;
    totalAllInPerUnit: number | null;
    edgeBefore: number;
    edgeAfter: number | null;
    realizedPnl: number;
    fullSizePnlEquivalent: number | null;
    pnlLostToPartial: number | null;
    quoteAgeMs: number;
    reason: string;
};

export type SimulatedPositionState = "pending" | "open" | "resolved";

export type ResolutionEventProvenance =
    | "synthetic_test_event"
    | "recorded_external_resolution_source"
    | "placeholder_end_time_assumption";

export type ResolutionEventSourceLabel =
    | "synthetic_manual_input"
    | "gamma_market_poll"
    | "placeholder_end_time_assumption";

export type SimulatedPosition = {
    id: string;
    state: SimulatedPositionState;
    marketId: string;
    slug: string;
    yesTokenId: string;
    noTokenId: string;
    size: number;
    entryYesPrice: number;
    entryNoPrice: number;
    entryTotalAllInPerUnit: number;
    lockedNotional: number;
    openedAt: number;
    marketEndTimeMs: number | null;
    resolvedAt: number | null;
    settlementPayoutPerUnit: number | null;
    settlementGrossPayout: number | null;
    realizedPnl: number | null;
    settlementMode: "placeholder_end_time_full_set_assumption" | "explicit_recorded_resolution_event";
    settlementProvenance: string;
    settlementTrustworthy: boolean;
};

export type StrandedDamageState =
    | "detected_damage"
    | "open_damage"
    | "resolved_damage"
    | "expired_damage";

export type StrandedDamageType =
    | "leg_a_only"
    | "leg_b_only"
    | "partial_fill"
    | "stale_execution"
    | "invalidated_opportunity"
    | "queue_limited_partial_fill";

export type StrandedDamageFlag =
    | "stale_execution"
    | "invalidated_opportunity"
    | "queue_limited_partial_fill";

export type StrandedDamageRecord = {
    id: string;
    attemptId: string;
    marketId: string;
    slug: string;
    legSide: BinarySide | null;
    intendedSize: number;
    filledSize: number;
    averageFillPrice: number | null;
    damageType: StrandedDamageType;
    damageFlags: StrandedDamageFlag[];
    amount: number;
    outstandingExposure: number;
    originatingTerminalExecutionState: string;
    createdAtMs: number;
    resolvedAtMs: number | null;
    provenance: "replay_execution_outcome" | "paper_execution_outcome";
    resolutionReason: "damage_opened_for_accounting" | "replay_session_end_summary" | "reporting_window_elapsed" | null;
    currentState: StrandedDamageState;
    history: Array<{
        fromState: StrandedDamageState | null;
        toState: StrandedDamageState;
        reason: "damage_detected" | "damage_opened_for_accounting" | "replay_session_end_summary" | "reporting_window_elapsed";
        ts: number;
    }>;
};

export type PaperTraderState = {
    tradeAttempts: number;
    positionOpens: number;
    positionsResolved: number;
    wins: number;
    losses: number;
    averageEdge: number;
    realizedPnl: number;
    dailyRealizedPnl: number;
    maxDrawdown: number;
    grossOpenNotional: number;
    unrealizedPnlMarkedToMarket: null;
    releasedExposure: number;
    denialCounts: Record<string, number>;
    dailyLossDenials: number;
    firstDailyLossBlockAt: number | null;
    dayRollover: {
        currentDayBucketStartMs: number;
        currentDayBucketEndMs: number;
        currentUtcOffset: string;
        rolloverOccurred: boolean;
        rolloverCount: number;
        denialsBeforeFirstRollover: number;
        denialsAfterFirstRollover: number;
        bucketSummaries: Array<{
            dayBucketStartMs: number;
            dayBucketEndMs: number;
            denialCount: number;
            dailyLossDenials: number;
            firstDailyLossBlockAt: number | null;
        }>;
    };
    unresolvedAging: {
        oldestOpenPositionAgeMs: number | null;
        newestOpenPositionAgeMs: number | null;
        averageOpenPositionAgeMs: number | null;
        countsOlderThanThresholds: Record<string, number>;
        oldestUnresolvedByMarket: Array<{
            marketId: string;
            slug: string;
            openPositions: number;
            unresolvedLockedExposure: number;
            oldestOpenPositionAgeMs: number;
            missingTrustworthySettlementCount: number;
        }>;
    };
    settlementCoverage: {
        positionsResolvedByExplicitResolutionEvent: number;
        positionsResolvedByPlaceholderAssumption: number;
        positionsUnresolvedNoTrustworthySettlementPath: number;
        positionsUnresolvedMissingEndTime: number;
        provenanceBreakdown: Record<string, number>;
    };
    executionDamage: {
        openStrandedDamageCount: number;
        resolvedStrandedDamageCount: number;
        expiredStrandedDamageCount: number;
        totalOutstandingStrandedExposure: number;
        totalRecordedDamageNotional: number;
        totalStrandedNotionalByType: Record<StrandedDamageType, number>;
        outstandingStrandedExposureByType: Record<StrandedDamageType, number>;
        oldestOpenStrandedDamageAgeMs: number | null;
        strandedDamageByOriginatingTerminalState: Record<string, number>;
        stateCounts: Record<StrandedDamageState, number>;
    };
    executionStateSummary: {
        attemptsByTerminalState: Record<string, number>;
        transitionReasonCounts: Record<string, number>;
        averagePhaseDurationsMs: {
            detect_to_queue: number | null;
            queue_to_leg_a: number | null;
            leg_a_to_leg_b: number | null;
            detect_to_terminal: number | null;
        };
        expiredAttempts: number;
        invalidatedAttempts: number;
        partialFillTerminalStates: number;
        strandedDamageByTerminalState: Record<string, number>;
    };
    settlementModeUsed: string;
    recordedExplicitResolutionEvents: number;
    resolutionEventProvenanceBreakdown: Record<string, number>;
    trustworthyResolutionEvents: number;
    untrustworthyResolutionEvents: number;
    positionsResolvedByExplicitResolutionEvent: number;
    positionsResolvedByPlaceholderAssumption: number;
    unresolvedPositions: number;
    unresolvedLockedExposure: number;
    positionsMissingTrustworthySettlementData: number;
    lockedExposureMissingTrustworthySettlementData: number;
    positions: Array<{
        id: string;
        state: SimulatedPositionState;
        marketId: string;
        slug: string;
        size: number;
        entryTotalAllInPerUnit: number;
        lockedNotional: number;
        openedAt: number;
        resolvedAt: number | null;
        realizedPnl: number | null;
        settlementMode: "placeholder_end_time_full_set_assumption" | "explicit_recorded_resolution_event";
        settlementTrustworthy: boolean;
    }>;
    strandedDamageRecords: StrandedDamageRecord[];
};

export type PaperTraderRuntimeBaselineCapture = {
    provenance: "future_runtime_internal_baseline_capture";
    sourceLabel: string;
    capturedAtMs: number;
    account: {
        snapshot: import("../live/types").InternalAccountBaselineSnapshot | null;
        available: boolean;
        reason: "unavailable_runtime_account_state";
    };
    rawSourceMetadata: Record<string, unknown> | null;
};

export type RecordedResolutionEvent = {
    marketId: string;
    resolvedAtMs: number;
    settlementStatus: "resolved";
    settlementMode: "explicit_recorded_resolution_event";
    payoutPerUnit: number;
    provenance: ResolutionEventProvenance;
    sourceLabel: ResolutionEventSourceLabel;
    trustworthy: boolean;
    rawSourceMetadata: Record<string, unknown> | null;
};

export type RecordedEvent =
    | {
        type: "session_start";
        ts: number;
        mode: "scan" | "paper";
        config: Record<string, unknown>;
    }
    | {
        type: "market_metadata";
        ts: number;
        market: BinaryMarket;
    }
    | {
        type: "ws_market";
        ts: number;
        payload: unknown;
    }
    | {
        type: "book_top";
        ts: number;
        tokenId: string;
        top: TopOfBook;
    }
    | {
        type: "opportunity";
        ts: number;
        opportunity: Opportunity;
    }
    | {
        type: "sim_fill";
        ts: number;
        fill: SimulatedFill;
    }
    | {
        type: "position_open";
        ts: number;
        position: SimulatedPosition;
    }
    | {
        type: "position_resolve";
        ts: number;
        position: SimulatedPosition;
    }
    | {
        type: "resolution_event";
        ts: number;
        resolution: RecordedResolutionEvent;
    };
