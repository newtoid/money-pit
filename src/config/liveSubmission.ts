import { LiveSubmissionConfig } from "../live/liveSubmission";

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

export function loadLiveSubmissionConfig(): LiveSubmissionConfig {
    const mode = envString("LIVE_SUBMISSION_MODE");
    return {
        liveExecutionEnabled: envBool("LIVE_EXECUTION_ENABLED", false),
        executionKillSwitch: envBool("EXECUTION_KILL_SWITCH", true),
        liveSubmissionMode: mode === "future_live_clob_guarded" ? "future_live_clob_guarded" : "disabled",
        allowlistedMarkets: envStringList("LIVE_SUBMISSION_ALLOWLIST_MARKETS"),
        allowlistedAssets: envStringList("LIVE_SUBMISSION_ALLOWLIST_ASSETS"),
        maxOrderSize: Math.max(0, envNumber("LIVE_SUBMISSION_MAX_ORDER_SIZE", 0)),
        requiredEnvironmentConfirmation: envString("LIVE_SUBMISSION_REQUIRED_CONFIRMATION"),
        providedEnvironmentConfirmation: envString("LIVE_SUBMISSION_CONFIRMATION"),
    };
}
