import { assertReadOnlyVenueSafety, loadReadOnlyVenueConfig } from "../config/readOnlyVenue";
import { runLivePostSubmitVerification } from "../live/livePostSubmitVerification";
import { logger } from "../logger";

function getArgValue(flag: string) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] ?? null;
}

async function main() {
    const config = loadReadOnlyVenueConfig();
    assertReadOnlyVenueSafety(config);
    const pilotResultPath = getArgValue("--pilot-result");
    if (!pilotResultPath) {
        throw new Error("--pilot-result is required");
    }
    const internalOrderBaselinePath = getArgValue("--order-baseline");
    const internalAccountBaselinePath = getArgValue("--account-baseline");
    const outputPath = getArgValue("--output");

    logger.info({
        msg: "starting one-shot post-submit verification",
        source: config.readOnlyLogLabel,
        readOnlyMode: config.mode,
        liveExecutionEnabled: config.liveExecutionEnabled,
        executionKillSwitch: config.executionKillSwitch,
        pilotResultPath,
        internalOrderBaselinePath,
        internalAccountBaselinePath,
        outputPath,
    });

    if (!config.enabled) {
        logger.info({
            msg: "one-shot post-submit verification disabled",
            source: config.readOnlyLogLabel,
            readOnlyVenueEnabled: config.enabled,
        });
        return;
    }

    const result = await runLivePostSubmitVerification({
        readOnlyVenueConfig: config,
        inputs: {
            pilotResultPath,
            internalOrderBaselinePath,
            internalAccountBaselinePath,
            outputPath,
        },
    });

    logger.info({
        msg: "one-shot post-submit verification complete",
        source: config.readOnlyLogLabel,
        externalOrderIdFound: result.externalOrderIdFound,
        matchingOrderSnapshotCount: result.matchingOrderSnapshotCount,
        matchingTradeSnapshotCount: result.matchingTradeSnapshotCount,
        orderReconciliationMatchedPilotBaseline: result.orderReconciliationMatchedPilotBaseline,
        accountPartialCoverageOnly: result.accountPartialCoverageOnly,
        limitationCounts: result.limitationCounts,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    logger.error({
        msg: "one-shot post-submit verification failed",
        source: "live_verify_once",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
