import {
    ExecutionRequest,
    LiveOrderAckSnapshot,
    LiveOrderSubmissionRequest,
    LiveOrderSubmissionResult,
    LiveSubmissionGuardReason,
    LiveSubmissionGuardResult,
    LiveSubmissionMode,
    LiveSubmissionSummary,
} from "./types";

export type LiveSubmissionConfig = {
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    liveSubmissionMode: LiveSubmissionMode;
    allowlistedMarkets: string[];
    allowlistedAssets: string[];
    maxOrderSize: number;
    requiredEnvironmentConfirmation: string | null;
    providedEnvironmentConfirmation: string | null;
};

export function buildLiveOrderSubmissionRequests(request: ExecutionRequest): LiveOrderSubmissionRequest[] {
    return request.legs.map((leg) => ({
        executionAttemptId: request.executionAttemptId,
        correlationId: request.correlationId,
        marketId: request.marketId,
        slug: request.slug,
        legId: leg.legId,
        tokenId: leg.tokenId,
        binarySide: leg.binarySide,
        side: leg.side,
        limitPrice: leg.limitPrice,
        size: leg.size,
        timeInForce: leg.timeInForce,
        createdAtMs: request.createdAtMs,
        source: request.source,
    }));
}

export function evaluateLiveSubmissionGuard(args: {
    request: LiveOrderSubmissionRequest;
    config: LiveSubmissionConfig;
    allowedModes?: LiveSubmissionMode[];
}): LiveSubmissionGuardResult {
    const { request, config } = args;
    const allowedModes = args.allowedModes ?? ["future_live_clob_guarded"];
    const reasonCodes: LiveSubmissionGuardReason[] = [];

    if (!config.liveExecutionEnabled) reasonCodes.push("live_execution_disabled");
    if (config.executionKillSwitch) reasonCodes.push("execution_kill_switch_enabled");
    if (!allowedModes.includes(config.liveSubmissionMode)) reasonCodes.push("live_submission_mode_not_selected");
    if (config.maxOrderSize <= 0) reasonCodes.push("max_order_size_cap_missing");
    if (config.maxOrderSize > 0 && request.size > config.maxOrderSize) reasonCodes.push("order_size_above_cap");
    if (
        config.allowlistedMarkets.length > 0
        && !config.allowlistedMarkets.includes(request.marketId)
    ) {
        reasonCodes.push("market_not_allowlisted");
    }
    if (
        config.allowlistedAssets.length > 0
        && !config.allowlistedAssets.includes(request.tokenId)
    ) {
        reasonCodes.push("asset_not_allowlisted");
    }
    if (
        config.requiredEnvironmentConfirmation
        && config.requiredEnvironmentConfirmation !== config.providedEnvironmentConfirmation
    ) {
        reasonCodes.push("environment_confirmation_missing");
    }

    return {
        allow: reasonCodes.length === 0,
        reasonCodes,
        details: {
            liveExecutionEnabled: config.liveExecutionEnabled,
            executionKillSwitch: config.executionKillSwitch,
            liveSubmissionMode: config.liveSubmissionMode,
            maxOrderSize: config.maxOrderSize,
            requiredEnvironmentConfirmation: config.requiredEnvironmentConfirmation,
            providedEnvironmentConfirmation: config.providedEnvironmentConfirmation,
            allowlistedMarkets: [...config.allowlistedMarkets],
            allowlistedAssets: [...config.allowlistedAssets],
            attemptedMarketId: request.marketId,
            attemptedAssetId: request.tokenId,
            attemptedSize: request.size,
        },
    };
}

export function buildDeniedLiveSubmissionResult(args: {
    executionAttemptId: string;
    submissionMode: LiveSubmissionMode;
    guard: LiveSubmissionGuardResult;
    requests: LiveOrderSubmissionRequest[];
}): LiveOrderSubmissionResult {
    const firstReason = args.guard.reasonCodes[0] ?? "live_submission_not_implemented_in_phase";
    const deniedAcks: LiveOrderAckSnapshot[] = args.requests.map((request) => ({
        executionAttemptId: request.executionAttemptId,
        legId: request.legId,
        tokenId: request.tokenId,
        status: args.guard.allow ? "not_submitted" : "guard_denied",
        reasonCode: firstReason,
        message: args.guard.allow
            ? "live submission scaffolding remains deny-only in this phase"
            : `live submission guard denied request: ${args.guard.reasonCodes.join(",")}`,
        createdAtMs: request.createdAtMs,
    }));

    return {
        executionAttemptId: args.executionAttemptId,
        submissionMode: args.submissionMode,
        accepted: false,
        submissionStatus: args.guard.allow ? "denied_not_implemented" : "denied_by_guard",
        guard: args.guard.allow
            ? {
                ...args.guard,
                allow: false,
                reasonCodes: ["live_submission_not_implemented_in_phase"],
            }
            : args.guard,
        deniedAcks,
        message: args.guard.allow
            ? "live submission scaffolding is not implemented for real order submission in this phase"
            : `live submission denied by guard: ${args.guard.reasonCodes.join(",")}`,
    };
}

export class LiveSubmissionScaffoldStore {
    private attemptsConstructed = 0;
    private deniedSubmissionCount = 0;
    private readonly guardFailureCounts = new Map<string, number>();

    record(result: LiveOrderSubmissionResult) {
        this.attemptsConstructed += 1;
        this.deniedSubmissionCount += 1;
        for (const reasonCode of result.guard.reasonCodes) {
            this.guardFailureCounts.set(reasonCode, (this.guardFailureCounts.get(reasonCode) ?? 0) + 1);
        }
    }

    getSummary(config: LiveSubmissionConfig): LiveSubmissionSummary {
        return {
            attemptsConstructed: this.attemptsConstructed,
            deniedSubmissionCount: this.deniedSubmissionCount,
            guardFailureCounts: Object.fromEntries(this.guardFailureCounts.entries()),
            configuredSafetyPosture: {
                liveExecutionEnabled: config.liveExecutionEnabled,
                executionKillSwitch: config.executionKillSwitch,
                liveSubmissionMode: config.liveSubmissionMode,
                maxOrderSize: config.maxOrderSize,
                allowlistedMarkets: [...config.allowlistedMarkets],
                allowlistedAssets: [...config.allowlistedAssets],
                requiredEnvironmentConfirmationConfigured: Boolean(config.requiredEnvironmentConfirmation),
            },
        };
    }
}
