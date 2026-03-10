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

function envNumber(name: string, fallback: number): number {
    const raw = envString(name);
    if (raw === null) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStringList(raw: string | null): string[] {
    if (!raw) return [];
    return raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

export type ReadOnlyVenueConfig = {
    enabled: boolean;
    mode: "authenticated_clob_read_only";
    host: string;
    chainId: number;
    readOnlyLogLabel: string;
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    privateKey: string | null;
    apiKey: string | null;
    apiSecret: string | null;
    apiPassphrase: string | null;
    fetchOpenOrders: boolean;
    fetchTrades: boolean;
    fetchAccountBalances: boolean;
    openOrdersMarket: string | null;
    openOrdersAssetId: string | null;
    tradesMarket: string | null;
    tradesAssetId: string | null;
    balanceTokenIds: string[];
};

export function loadReadOnlyVenueConfig(): ReadOnlyVenueConfig {
    return {
        enabled: envBool("READ_ONLY_VENUE_ENABLED", false),
        mode: "authenticated_clob_read_only",
        host: envString("READ_ONLY_VENUE_HOST") ?? "https://clob.polymarket.com",
        chainId: Math.max(1, Math.floor(envNumber("READ_ONLY_VENUE_CHAIN_ID", 137))),
        readOnlyLogLabel: envString("READ_ONLY_VENUE_LOG_LABEL") ?? "read_only_venue",
        liveExecutionEnabled: envBool("LIVE_EXECUTION_ENABLED", false),
        executionKillSwitch: envBool("EXECUTION_KILL_SWITCH", true),
        privateKey: envString("READ_ONLY_VENUE_PRIVATE_KEY") ?? envString("PRIVATE_KEY"),
        apiKey: envString("READ_ONLY_VENUE_API_KEY") ?? envString("POLYMARKET_CLOB_API_KEY"),
        apiSecret: envString("READ_ONLY_VENUE_API_SECRET") ?? envString("POLYMARKET_CLOB_SECRET"),
        apiPassphrase: envString("READ_ONLY_VENUE_API_PASSPHRASE") ?? envString("POLYMARKET_CLOB_PASSPHRASE"),
        fetchOpenOrders: envBool("READ_ONLY_VENUE_FETCH_OPEN_ORDERS", true),
        fetchTrades: envBool("READ_ONLY_VENUE_FETCH_TRADES", true),
        fetchAccountBalances: envBool("READ_ONLY_VENUE_FETCH_ACCOUNT_BALANCES", true),
        openOrdersMarket: envString("READ_ONLY_VENUE_OPEN_ORDERS_MARKET"),
        openOrdersAssetId: envString("READ_ONLY_VENUE_OPEN_ORDERS_ASSET_ID"),
        tradesMarket: envString("READ_ONLY_VENUE_TRADES_MARKET"),
        tradesAssetId: envString("READ_ONLY_VENUE_TRADES_ASSET_ID"),
        balanceTokenIds: normalizeStringList(envString("READ_ONLY_VENUE_BALANCE_TOKEN_IDS")),
    };
}

export function assertReadOnlyVenueSafety(config: ReadOnlyVenueConfig) {
    if (config.liveExecutionEnabled) {
        throw new Error("read-only venue integration requires LIVE_EXECUTION_ENABLED=false");
    }
    if (!config.executionKillSwitch) {
        throw new Error("read-only venue integration requires EXECUTION_KILL_SWITCH=true");
    }
}
