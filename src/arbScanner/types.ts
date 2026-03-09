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
    requireFullFill: boolean;
    requireKnownSize: boolean;
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
    resolutionSource: "market_end_full_set_assumption" | "unresolved_missing_end_time";
};

export type PaperTraderState = {
    tradeAttempts: number;
    positionOpens: number;
    positionsResolved: number;
    wins: number;
    losses: number;
    averageEdge: number;
    realizedPnl: number;
    maxDrawdown: number;
    grossOpenNotional: number;
    unrealizedPnlMarkedToMarket: null;
    releasedExposure: number;
    denialCounts: Record<string, number>;
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
    }>;
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
    };
