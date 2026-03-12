import path from "node:path";
import { loadLiveOrderPilotConfig } from "../config/liveOrderPilot";
import { exportPilotSessionBundle, defaultPilotSessionBundleRootDir } from "../live/pilotSessionBundle";
import { readLatestPilotSessionManifest, resolvePilotSessionManifestPath } from "../live/pilotSession";
import { logger } from "../logger";

function getArgValue(flag: string) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] ?? null;
}

async function main() {
    const sessionArg = getArgValue("--session");
    const latest = process.argv.includes("--latest");
    if (!sessionArg && !latest) {
        throw new Error("--session or --latest is required");
    }

    const pilotConfig = loadLiveOrderPilotConfig();
    const bundleRootDir = path.resolve(getArgValue("--output-dir") ?? defaultPilotSessionBundleRootDir(pilotConfig.resultDir));
    const manifestPath = sessionArg
        ? resolvePilotSessionManifestPath({
            pilotSessionIdOrPath: sessionArg,
            resultDir: pilotConfig.resultDir,
        })
        : (() => {
            const latestSession = readLatestPilotSessionManifest(pilotConfig.resultDir);
            if (!latestSession) {
                throw new Error("no pilot session manifests found");
            }
            return latestSession.manifestPath;
        })();

    logger.info({
        msg: "starting pilot session bundle export",
        source: pilotConfig.logLabel,
        manifestPath,
        bundleRootDir,
    });

    const result = exportPilotSessionBundle({
        manifestPath,
        bundleRootDir,
    });

    logger.info({
        msg: "pilot session bundle export complete",
        source: pilotConfig.logLabel,
        pilotSessionId: result.pilotSessionId,
        bundleId: result.bundleId,
        bundleDir: result.bundleDir,
        bundleManifestPath: result.bundleManifestPath,
        missingArtifactTypes: result.bundleManifest.missingArtifactTypes,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    logger.error({
        msg: "pilot session bundle export failed",
        source: "pilot_session_export",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
