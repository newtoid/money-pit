export type ArbScannerConfig = {
    maxMarkets: number;
    minEdge: number;
    costBuffer: number;
    quoteStaleMs: number;
    marketSlugFilter: string | null;
    eventSlugFilter: string | null;
    tagFilter: string | null;
    watchlistSlugs: Set<string>;
    gammaPageSize: number;
    gammaRequestTimeoutMs: number;
    opportunityLogMinMs: number;
    feeCostOverride: number | null;
    recorderEnabled: boolean;
    recorderDir: string;
    resolutionPollingEnabled: boolean;
    resolutionPollIntervalMs: number;
    resolutionRequestTimeoutMs: number;
    paperSummaryIntervalMs: number;
    strandedDamageReportingWindowMs: number;
    openPositionAgeThresholdsMs: number[];
    tradeSize: number;
    simSlippagePerLeg: number;
    simPartialFillRatio: number;
    simPartialFillMode: "none" | "probabilistic" | "liquidity_limited";
    simPartialFillProbability: number;
    simRequireFullFill: boolean;
    simRequireKnownSize: boolean;
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
    paperMaxTradesPerMarket: number;
    replayLatencyMs: number;
    killSwitchEnabled: boolean;
    riskMaxNotionalPerTrade: number;
    riskMaxConcurrentExposure: number;
    riskPerMarketExposureCap: number;
    riskNoTradeBeforeResolutionSec: number;
    riskMaxDailyLoss: number;
    riskDayUtcOffset: string;
    settlementAllowPlaceholderFallback: boolean;
    executionMode: "dry_run_stub" | "replay_simulated" | "future_live_clob";
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    liveSubmissionMode: "disabled" | "future_live_clob_guarded";
    liveSubmissionAllowlistedMarkets: string[];
    liveSubmissionAllowlistedAssets: string[];
    liveSubmissionMaxOrderSize: number;
    liveSubmissionRequiredConfirmation: string | null;
    liveSubmissionConfirmation: string | null;
    runtimeBaselineCaptureEnabled: boolean;
    runtimeBaselineCapturePath: string;
};

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function envString(name: string): string | null {
    const raw = process.env[name];
    if (!raw) return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function envBool(name: string, fallback: boolean): boolean {
    const raw = envString(name);
    if (raw === null) return fallback;
    if (["1", "true", "yes", "y", "on"].includes(raw.toLowerCase())) return true;
    if (["0", "false", "no", "n", "off"].includes(raw.toLowerCase())) return false;
    return fallback;
}

function envEnum<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
    const raw = envString(name);
    if (!raw) return fallback;
    return (allowed as readonly string[]).includes(raw) ? raw as T : fallback;
}

function normalizeSet(raw: string | null): Set<string> {
    if (!raw) return new Set<string>();
    return new Set(
        raw.split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
    );
}

function normalizeNumberList(raw: string | null, fallback: number[]): number[] {
    if (!raw) return fallback;
    const values = raw
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Math.floor(value));
    return values.length > 0 ? values : fallback;
}

export function loadArbScannerConfig(): ArbScannerConfig {
    return {
        maxMarkets: Math.max(1, Math.floor(envNumber("MAX_MARKETS", 100))),
        minEdge: envNumber("MIN_EDGE", 0.01),
        costBuffer: Math.max(0, envNumber("COST_BUFFER", 0)),
        quoteStaleMs: Math.max(250, Math.floor(envNumber("QUOTE_STALE_MS", 5000))),
        marketSlugFilter: envString("MARKET_SLUG_FILTER")?.toLowerCase() ?? null,
        eventSlugFilter: envString("EVENT_SLUG_FILTER")?.toLowerCase() ?? null,
        tagFilter: envString("TAG_FILTER")?.toLowerCase() ?? null,
        watchlistSlugs: normalizeSet(envString("WATCHLIST_SLUGS")),
        gammaPageSize: Math.max(1, Math.min(500, Math.floor(envNumber("GAMMA_PAGE_SIZE", 100)))),
        gammaRequestTimeoutMs: Math.max(1000, Math.floor(envNumber("GAMMA_REQUEST_TIMEOUT_MS", 10000))),
        opportunityLogMinMs: Math.max(0, Math.floor(envNumber("OPPORTUNITY_LOG_MIN_MS", 15000))),
        feeCostOverride: (() => {
            const raw = envString("FEE_COST_OVERRIDE");
            if (raw === null) return null;
            const value = Number(raw);
            return Number.isFinite(value) ? Math.max(0, value) : null;
        })(),
        recorderEnabled: envBool("ARB_RECORDER_ENABLED", false),
        recorderDir: envString("ARB_RECORDER_DIR") ?? "data/recordings",
        resolutionPollingEnabled: envBool("RESOLUTION_POLLING_ENABLED", true),
        resolutionPollIntervalMs: Math.max(1000, Math.floor(envNumber("RESOLUTION_POLL_INTERVAL_MS", 30000))),
        resolutionRequestTimeoutMs: Math.max(1000, Math.floor(envNumber("RESOLUTION_REQUEST_TIMEOUT_MS", 10000))),
        paperSummaryIntervalMs: Math.max(1000, Math.floor(envNumber("PAPER_SUMMARY_INTERVAL_MS", 60000))),
        strandedDamageReportingWindowMs: Math.max(0, Math.floor(envNumber("STRANDED_DAMAGE_REPORTING_WINDOW_MS", 0))),
        openPositionAgeThresholdsMs: normalizeNumberList(
            envString("OPEN_POSITION_AGE_THRESHOLDS_MS"),
            [60_000, 300_000, 900_000],
        ),
        tradeSize: Math.max(0.01, envNumber("TRADE_SIZE", 5)),
        simSlippagePerLeg: Math.max(0, envNumber("SIM_SLIPPAGE_PER_LEG", 0)),
        simPartialFillRatio: Math.max(0, Math.min(1, envNumber("SIM_PARTIAL_FILL_RATIO", 1))),
        simPartialFillMode: envEnum("PARTIAL_FILL_MODE", "none", ["none", "probabilistic", "liquidity_limited"] as const),
        simPartialFillProbability: Math.max(0, Math.min(1, envNumber("SIM_PARTIAL_FILL_PROBABILITY", 0.5))),
        simRequireFullFill: envBool("SIM_REQUIRE_FULL_FILL", true),
        simRequireKnownSize: envBool("SIM_REQUIRE_KNOWN_SIZE", true),
        executionLatencyMs: Math.max(0, Math.floor(envNumber("EXECUTION_LATENCY_MS", 0))),
        legExecutionDriftMs: Math.max(0, Math.floor(envNumber("LEG_EXECUTION_DRIFT_MS", 0))),
        orderbookStalenessToleranceMs: Math.max(0, Math.floor(envNumber("ORDERBOOK_STALENESS_TOLERANCE_MS", 5000))),
        maxBookLevelsToSimulate: Math.max(1, Math.floor(envNumber("MAX_BOOK_LEVELS_TO_SIMULATE", 5))),
        allowMultiLevelSweep: envBool("ALLOW_MULTI_LEVEL_SWEEP", true),
        depthSlippageBufferTicks: Math.max(0, Math.floor(envNumber("DEPTH_SLIPPAGE_BUFFER_TICKS", 0))),
        queuePriorityMode: envEnum(
            "QUEUE_PRIORITY_MODE",
            "optimistic_visible_depth",
            ["optimistic_visible_depth", "conservative_queue_haircut", "strict_top_priority_block"] as const,
        ),
        queueHaircutRatio: Math.max(0, Math.min(1, envNumber("QUEUE_HAIRCUT_RATIO", 0.5))),
        minVisibleSizeToAssumeFill: Math.max(0, envNumber("MIN_VISIBLE_SIZE_TO_ASSUME_FILL", 1)),
        maxQueuePenaltyLevels: Math.max(1, Math.floor(envNumber("MAX_QUEUE_PENALTY_LEVELS", 3))),
        paperMaxTradesPerMarket: Math.max(1, Math.floor(envNumber("PAPER_MAX_TRADES_PER_MARKET", 1))),
        replayLatencyMs: Math.max(0, Math.floor(envNumber("REPLAY_LATENCY_MS", 0))),
        killSwitchEnabled: envBool("KILL_SWITCH_ENABLED", false),
        riskMaxNotionalPerTrade: Math.max(0, envNumber("RISK_MAX_NOTIONAL_PER_TRADE", 25)),
        riskMaxConcurrentExposure: Math.max(0, envNumber("RISK_MAX_CONCURRENT_EXPOSURE", 100)),
        riskPerMarketExposureCap: Math.max(0, envNumber("RISK_PER_MARKET_EXPOSURE_CAP", 25)),
        riskNoTradeBeforeResolutionSec: Math.max(0, Math.floor(envNumber("RISK_NO_TRADE_BEFORE_RESOLUTION_SEC", 60))),
        riskMaxDailyLoss: Math.max(0, envNumber("RISK_MAX_DAILY_LOSS", 0)),
        riskDayUtcOffset: envString("RISK_DAY_UTC_OFFSET") ?? "+00:00",
        settlementAllowPlaceholderFallback: envBool("SETTLEMENT_ALLOW_PLACEHOLDER_FALLBACK", true),
        executionMode: envEnum("EXECUTION_MODE", "dry_run_stub", ["dry_run_stub", "replay_simulated", "future_live_clob"] as const),
        liveExecutionEnabled: envBool("LIVE_EXECUTION_ENABLED", false),
        executionKillSwitch: envBool("EXECUTION_KILL_SWITCH", true),
        liveSubmissionMode: envEnum("LIVE_SUBMISSION_MODE", "disabled", ["disabled", "future_live_clob_guarded"] as const),
        liveSubmissionAllowlistedMarkets: envString("LIVE_SUBMISSION_ALLOWLIST_MARKETS")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
        liveSubmissionAllowlistedAssets: envString("LIVE_SUBMISSION_ALLOWLIST_ASSETS")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
        liveSubmissionMaxOrderSize: Math.max(0, envNumber("LIVE_SUBMISSION_MAX_ORDER_SIZE", 0)),
        liveSubmissionRequiredConfirmation: envString("LIVE_SUBMISSION_REQUIRED_CONFIRMATION"),
        liveSubmissionConfirmation: envString("LIVE_SUBMISSION_CONFIRMATION"),
        runtimeBaselineCaptureEnabled: envBool("RUNTIME_BASELINE_CAPTURE_ENABLED", true),
        runtimeBaselineCapturePath: envString("RUNTIME_BASELINE_CAPTURE_PATH") ?? "data/baselines/runtime-baseline.capture.json",
    };
}
