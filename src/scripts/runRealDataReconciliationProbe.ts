import { assertReadOnlyVenueSafety, loadReadOnlyVenueConfig } from "../config/readOnlyVenue";
import { loadRealDataReconciliationConfig } from "../config/realDataReconciliation";
import { runRealDataReconciliationProbe } from "../live/realDataReconciliationProbe";
import {
    attachArtifactToPilotSession,
    defaultPilotReconciliationPath,
    readPilotSessionManifest,
    resolvePilotSessionManifestPath,
} from "../live/pilotSession";
import { loadLiveOrderPilotConfig } from "../config/liveOrderPilot";
import { logger } from "../logger";

function getArgValue(flag: string) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] ?? null;
}

async function main() {
    const readOnlyVenueConfig = loadReadOnlyVenueConfig();
    const probeConfig = loadRealDataReconciliationConfig();
    const baselinePathArg = getArgValue("--baseline");
    const orderBaselinePathArg = getArgValue("--order-baseline");
    const accountBaselinePathArg = getArgValue("--account-baseline");
    const outputPathArg = getArgValue("--output");
    const pilotSessionArg = getArgValue("--pilot-session");
    const livePilotConfig = loadLiveOrderPilotConfig();
    const pilotSessionManifestPath = pilotSessionArg
        ? resolvePilotSessionManifestPath({
            pilotSessionIdOrPath: pilotSessionArg,
            resultDir: livePilotConfig.resultDir,
        })
        : null;
    const pilotSessionManifest = pilotSessionManifestPath ? readPilotSessionManifest(pilotSessionManifestPath) : null;
    const derivedOrderBaselinePath = pilotSessionManifest?.latestArtifactPaths.orderBaseline ?? null;
    const effectiveOutputPath = outputPathArg ?? (
        pilotSessionManifest
            ? defaultPilotReconciliationPath({
                resultDir: livePilotConfig.resultDir,
                pilotSessionId: pilotSessionManifest.pilotSessionId,
            })
            : probeConfig.outputPath
    );
    assertReadOnlyVenueSafety(readOnlyVenueConfig);

    logger.info({
        msg: "starting real-data reconciliation probe",
        source: readOnlyVenueConfig.readOnlyLogLabel,
        readOnlyMode: readOnlyVenueConfig.mode,
        liveExecutionEnabled: readOnlyVenueConfig.liveExecutionEnabled,
        executionKillSwitch: readOnlyVenueConfig.executionKillSwitch,
        readOnlyVenueEnabled: readOnlyVenueConfig.enabled,
        probeEnabled: probeConfig.enabled,
        outputPath: effectiveOutputPath,
        baselinePath: baselinePathArg ?? probeConfig.baselinePath,
        runtimeCapturePath: probeConfig.runtimeCapturePath,
        internalOrderSnapshotPath: orderBaselinePathArg ?? derivedOrderBaselinePath ?? probeConfig.internalOrderSnapshotPath,
        internalAccountSnapshotPath: accountBaselinePathArg ?? probeConfig.internalAccountSnapshotPath,
        pilotSessionManifestPath,
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
        probeConfig: {
            enabled: probeConfig.enabled,
            outputPath: effectiveOutputPath,
            baselinePath: baselinePathArg ?? probeConfig.baselinePath,
            runtimeCapturePath: probeConfig.runtimeCapturePath,
            internalOrderSnapshotPath: orderBaselinePathArg ?? derivedOrderBaselinePath ?? probeConfig.internalOrderSnapshotPath,
            internalAccountSnapshotPath: accountBaselinePathArg ?? probeConfig.internalAccountSnapshotPath,
        },
        pilotSessionId: pilotSessionManifest?.pilotSessionId ?? null,
        pilotSessionManifestPath,
    });

    if (pilotSessionManifestPath && effectiveOutputPath) {
        attachArtifactToPilotSession({
            manifestPath: pilotSessionManifestPath,
            artifact: {
                artifactType: "reconciliation_result",
                artifactPath: effectiveOutputPath,
                attachedAtMs: result.capturedAtMs,
                status: "present",
                provenance: "real_data_reconciliation_output",
                notes: [
                    `order_issues=${Object.keys(result.orderReconciliation?.issueCountsByType ?? {}).length}`,
                    `balance_issues=${Object.keys(result.balanceReconciliation?.issueCountsByType ?? {}).length}`,
                ],
            },
            terminalState: "reconciliation_recorded",
        });
    }

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
        pilotSessionId: result.pilotSessionId,
        pilotSessionManifestPath: result.pilotSessionManifestPath,
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
