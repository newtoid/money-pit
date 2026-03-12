import { loadLiveOrderPilotConfig } from "../config/liveOrderPilot";
import { readPilotSessionManifest, resolvePilotSessionManifestPath, summarizePilotSessionManifest } from "../live/pilotSession";
import { logger } from "../logger";

function getArgValue(flag: string) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] ?? null;
}

async function main() {
    const sessionArg = getArgValue("--session");
    if (!sessionArg) {
        throw new Error("--session is required");
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
