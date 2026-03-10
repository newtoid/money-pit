import { DryRunStubExecutionAdapter } from "./dryRunStubAdapter";
import { ExecutionAdapter } from "./executionAdapter";
import { LiveSubmissionConfig } from "./liveSubmission";
import { ReplaySimulatedExecutionAdapter } from "./replaySimulatedAdapter";
import { ExecutionMode } from "./types";
import { UnsupportedLiveExecutionAdapter } from "./unsupportedLiveAdapter";

export function createExecutionAdapter(args: {
    executionMode: ExecutionMode;
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    liveSubmissionConfig?: LiveSubmissionConfig;
}): ExecutionAdapter {
    if (args.executionMode === "dry_run_stub") {
        return new DryRunStubExecutionAdapter({
            liveExecutionEnabled: args.liveExecutionEnabled,
            executionKillSwitch: args.executionKillSwitch,
        });
    }
    if (args.executionMode === "replay_simulated") {
        return new ReplaySimulatedExecutionAdapter({
            liveExecutionEnabled: args.liveExecutionEnabled,
            executionKillSwitch: args.executionKillSwitch,
        });
    }
    return new UnsupportedLiveExecutionAdapter({
        liveExecutionEnabled: args.liveExecutionEnabled,
        executionKillSwitch: args.executionKillSwitch,
        liveSubmissionConfig: args.liveSubmissionConfig ?? {
            liveExecutionEnabled: args.liveExecutionEnabled,
            executionKillSwitch: args.executionKillSwitch,
            liveSubmissionMode: "disabled",
            allowlistedMarkets: [],
            allowlistedAssets: [],
            maxOrderSize: 0,
            requiredEnvironmentConfirmation: null,
            providedEnvironmentConfirmation: null,
        },
    });
}
