import { assertReadOnlyVenueSafety, loadReadOnlyVenueConfig } from "../config/readOnlyVenue";
import { loadRealDataReconciliationConfig } from "../config/realDataReconciliation";
import { runRealDataReconciliationProbe } from "../live/realDataReconciliationProbe";
import { logger } from "../logger";

async function main() {
    const readOnlyVenueConfig = loadReadOnlyVenueConfig();
    const probeConfig = loadRealDataReconciliationConfig();
    assertReadOnlyVenueSafety(readOnlyVenueConfig);

    logger.info({
        msg: "starting real-data reconciliation probe",
        source: readOnlyVenueConfig.readOnlyLogLabel,
        readOnlyMode: readOnlyVenueConfig.mode,
        liveExecutionEnabled: readOnlyVenueConfig.liveExecutionEnabled,
        executionKillSwitch: readOnlyVenueConfig.executionKillSwitch,
        readOnlyVenueEnabled: readOnlyVenueConfig.enabled,
        probeEnabled: probeConfig.enabled,
        outputPath: probeConfig.outputPath,
        internalOrderSnapshotPath: probeConfig.internalOrderSnapshotPath,
        internalAccountSnapshotPath: probeConfig.internalAccountSnapshotPath,
    });

    if (!readOnlyVenueConfig.enabled || !probeConfig.enabled) {
        logger.info({
            msg: "real-data reconciliation probe disabled",
            source: readOnlyVenueConfig.readOnlyLogLabel,
            readOnlyVenueEnabled: readOnlyVenueConfig.enabled,
            probeEnabled: probeConfig.enabled,
        });
        return;
    }

    const result = await runRealDataReconciliationProbe({
        readOnlyVenueConfig,
        probeConfig,
    });

    logger.info({
        msg: "real-data reconciliation probe complete",
        source: readOnlyVenueConfig.readOnlyLogLabel,
        fetchSummary: result.fetch.summary,
        orderIssueCounts: result.orderReconciliation?.issueCountsByType ?? {},
        orderMatchCounts: result.orderReconciliation?.matchCountsByRule ?? {},
        orderUnmatchedCounts: result.orderReconciliation?.unmatchedCountsByReason ?? {},
        orderCoverage: result.orderReconciliation?.comparisonCoverageCounts ?? {},
        balanceIssueCounts: result.balanceReconciliation?.issueCountsByType ?? {},
        balanceCoverage: result.balanceReconciliation?.comparisonCoverageCounts ?? {},
        limitationCounts: result.limitationCounts,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    logger.error({
        msg: "real-data reconciliation probe failed",
        source: "read_only_venue",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
