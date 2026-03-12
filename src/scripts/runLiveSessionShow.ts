import { loadLiveOrderPilotConfig } from "../config/liveOrderPilot";
import {
    readLatestPilotSessionManifest,
    readPilotSessionManifest,
    resolvePilotSessionManifestPath,
    summarizePilotSessionManifest,
} from "../live/pilotSession";
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
    if (!sessionArg) {
        const pilotConfig = loadLiveOrderPilotConfig();
        const latestSession = readLatestPilotSessionManifest(pilotConfig.resultDir);
        if (!latestSession) {
            throw new Error("no pilot session manifests found");
        }
        const summary = summarizePilotSessionManifest(latestSession.manifest);
        logger.info({
            msg: "loaded latest pilot session manifest",
            source: pilotConfig.logLabel,
            pilotSessionId: latestSession.manifest.pilotSessionId,
            manifestPath: latestSession.manifestPath,
            currentTerminalState: latestSession.manifest.currentTerminalState,
            attachmentStatus: latestSession.manifest.attachmentStatus,
            missingArtifacts: latestSession.manifest.missingArtifacts,
        });
        process.stdout.write(`${JSON.stringify({ ...summary, manifestPath: latestSession.manifestPath }, null, 2)}\n`);
        return;
    }
    const pilotConfig = loadLiveOrderPilotConfig();
    const manifestPath = resolvePilotSessionManifestPath({
        pilotSessionIdOrPath: sessionArg,
        resultDir: pilotConfig.resultDir,
    });
    const manifest = readPilotSessionManifest(manifestPath);
    const summary = summarizePilotSessionManifest(manifest);

    logger.info({
        msg: "loaded pilot session manifest",
        source: pilotConfig.logLabel,
        pilotSessionId: manifest.pilotSessionId,
        manifestPath,
        currentTerminalState: manifest.currentTerminalState,
        attachmentStatus: manifest.attachmentStatus,
        missingArtifacts: manifest.missingArtifacts,
    });

    process.stdout.write(`${JSON.stringify({ ...summary, manifestPath }, null, 2)}\n`);
}

main().catch((error) => {
    logger.error({
        msg: "pilot session show failed",
        source: "pilot_session_show",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
