import { DryRunStubExecutionAdapter } from "./dryRunStubAdapter";
import { ExecutionAdapter } from "./executionAdapter";
import { ReplaySimulatedExecutionAdapter } from "./replaySimulatedAdapter";
import { ExecutionMode } from "./types";
import { UnsupportedLiveExecutionAdapter } from "./unsupportedLiveAdapter";

export function createExecutionAdapter(args: {
    executionMode: ExecutionMode;
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
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
    });
}
