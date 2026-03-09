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
    tradeSize: number;
    simSlippagePerLeg: number;
    simPartialFillRatio: number;
    simRequireFullFill: boolean;
    simRequireKnownSize: boolean;
    paperMaxTradesPerMarket: number;
    replayLatencyMs: number;
    killSwitchEnabled: boolean;
    riskMaxNotionalPerTrade: number;
    riskMaxConcurrentExposure: number;
    riskPerMarketExposureCap: number;
    riskNoTradeBeforeResolutionSec: number;
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

function normalizeSet(raw: string | null): Set<string> {
    if (!raw) return new Set<string>();
    return new Set(
        raw.split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
    );
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
        tradeSize: Math.max(0.01, envNumber("TRADE_SIZE", 5)),
        simSlippagePerLeg: Math.max(0, envNumber("SIM_SLIPPAGE_PER_LEG", 0)),
        simPartialFillRatio: Math.max(0, Math.min(1, envNumber("SIM_PARTIAL_FILL_RATIO", 1))),
        simRequireFullFill: envBool("SIM_REQUIRE_FULL_FILL", true),
        simRequireKnownSize: envBool("SIM_REQUIRE_KNOWN_SIZE", true),
        paperMaxTradesPerMarket: Math.max(1, Math.floor(envNumber("PAPER_MAX_TRADES_PER_MARKET", 1))),
        replayLatencyMs: Math.max(0, Math.floor(envNumber("REPLAY_LATENCY_MS", 0))),
        killSwitchEnabled: envBool("KILL_SWITCH_ENABLED", false),
        riskMaxNotionalPerTrade: Math.max(0, envNumber("RISK_MAX_NOTIONAL_PER_TRADE", 25)),
        riskMaxConcurrentExposure: Math.max(0, envNumber("RISK_MAX_CONCURRENT_EXPOSURE", 100)),
        riskPerMarketExposureCap: Math.max(0, envNumber("RISK_PER_MARKET_EXPOSURE_CAP", 25)),
        riskNoTradeBeforeResolutionSec: Math.max(0, Math.floor(envNumber("RISK_NO_TRADE_BEFORE_RESOLUTION_SEC", 60))),
    };
}
