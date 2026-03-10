export const ABSOLUTE_PILOT_MAX_ORDER_SIZE = 0.1;

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

function envStringList(name: string): string[] {
    const raw = envString(name);
    if (!raw) return [];
    return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

export type LiveOrderPilotConfig = {
    enabled: boolean;
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    liveSubmissionMode: "disabled" | "future_live_clob_guarded" | "one_shot_live_pilot";
    allowlistedMarkets: string[];
    allowlistedAssets: string[];
    maxOrderSize: number;
    absoluteMaxOrderSize: number;
    requiredConfirmation: string | null;
    resultDir: string;
    baselineDir: string;
    logLabel: string;
};

export function loadLiveOrderPilotConfig(): LiveOrderPilotConfig {
    const mode = envString("LIVE_SUBMISSION_MODE");
    return {
        enabled: envBool("LIVE_ORDER_PILOT_ENABLED", false),
        liveExecutionEnabled: envBool("LIVE_EXECUTION_ENABLED", false),
        executionKillSwitch: envBool("EXECUTION_KILL_SWITCH", true),
        liveSubmissionMode:
            mode === "one_shot_live_pilot"
                ? "one_shot_live_pilot"
                : mode === "future_live_clob_guarded"
                    ? "future_live_clob_guarded"
                    : "disabled",
        allowlistedMarkets: envStringList("LIVE_ORDER_PILOT_ALLOWLIST_MARKETS"),
        allowlistedAssets: envStringList("LIVE_ORDER_PILOT_ALLOWLIST_ASSETS"),
        maxOrderSize: Math.max(0, envNumber("LIVE_ORDER_PILOT_MAX_ORDER_SIZE", ABSOLUTE_PILOT_MAX_ORDER_SIZE)),
        absoluteMaxOrderSize: ABSOLUTE_PILOT_MAX_ORDER_SIZE,
        requiredConfirmation: envString("LIVE_ORDER_PILOT_CONFIRMATION_VALUE"),
        resultDir: envString("LIVE_ORDER_PILOT_RESULT_DIR") ?? "data/pilots",
        baselineDir: envString("LIVE_ORDER_PILOT_BASELINE_DIR") ?? "data/baselines",
        logLabel: envString("LIVE_ORDER_PILOT_LOG_LABEL") ?? "live_order_pilot",
    };
}
