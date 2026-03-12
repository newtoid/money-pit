import fs from "node:fs";
import path from "node:path";
import {
    LivePilotTerminalState,
    PilotSessionArtifactRef,
    PilotSessionBundleRef,
    PilotSessionArtifactType,
    PilotSessionCaptureResult,
    PilotSessionManifest,
} from "./types";

export type PilotSessionManifestMeta = {
    manifestPath: string;
    mtimeMs: number;
};

function missingArtifactsFromLatest(args: PilotSessionManifest["latestArtifactPaths"]) {
    const missing: string[] = [];
    if (!args.pilotResult) missing.push("pilot_result");
    if (!args.orderBaseline) missing.push("order_baseline");
    if (!args.verificationResult) missing.push("verification_result");
    return missing;
}

function setLatestArtifactPath(args: {
    latest: PilotSessionManifest["latestArtifactPaths"];
    artifactType: PilotSessionArtifactType;
    artifactPath: string;
}) {
    if (args.artifactType === "pilot_result") args.latest.pilotResult = args.artifactPath;
    if (args.artifactType === "order_baseline") args.latest.orderBaseline = args.artifactPath;
    if (args.artifactType === "verification_result") args.latest.verificationResult = args.artifactPath;
    if (args.artifactType === "reconciliation_result") args.latest.reconciliationResult = args.artifactPath;
}

export function createPilotSessionId(executionAttemptId: string) {
    return executionAttemptId;
}

export function defaultPilotSessionManifestPath(args: {
    resultDir: string;
    pilotSessionId: string;
}) {
    return path.resolve(args.resultDir, `${args.pilotSessionId}.session.json`);
}

export function createPilotSessionManifest(args: {
    pilotSessionId: string;
    executionAttemptId: string;
    marketId: string | null;
    assetId: string | null;
    externalOrderId: string | null;
    terminalState: LivePilotTerminalState;
    createdAtMs: number;
    sourceLabel: string;
    rawSourceMetadata?: Record<string, unknown> | null;
    artifacts: PilotSessionArtifactRef[];
}): PilotSessionManifest {
    const latestArtifactPaths: PilotSessionManifest["latestArtifactPaths"] = {
        pilotResult: null,
        orderBaseline: null,
        verificationResult: null,
        reconciliationResult: null,
    };
    for (const artifact of args.artifacts) {
        setLatestArtifactPath({
            latest: latestArtifactPaths,
            artifactType: artifact.artifactType,
            artifactPath: artifact.artifactPath,
        });
    }
    return {
        pilotSessionId: args.pilotSessionId,
        sourceLabel: args.sourceLabel,
        createdAtMs: args.createdAtMs,
        updatedAtMs: args.createdAtMs,
        executionAttemptId: args.executionAttemptId,
        marketId: args.marketId,
        assetId: args.assetId,
        externalOrderId: args.externalOrderId,
        currentTerminalState: args.terminalState,
        artifacts: [...args.artifacts],
        latestArtifactPaths,
        attachmentStatus: {
            verificationAttached: Boolean(latestArtifactPaths.verificationResult),
            reconciliationAttached: Boolean(latestArtifactPaths.reconciliationResult),
        },
        latestBundleManifestPath: null,
        bundleExports: [],
        missingArtifacts: missingArtifactsFromLatest(latestArtifactPaths),
        rawSourceMetadata: args.rawSourceMetadata ?? null,
    };
}

export function writePilotSessionManifest(args: {
    manifest: PilotSessionManifest;
    manifestPath: string;
}): PilotSessionCaptureResult {
    const manifestPath = path.resolve(args.manifestPath);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(args.manifest, null, 2)}\n`, "utf8");
    return {
        pilotSessionId: args.manifest.pilotSessionId,
        manifestPath,
        manifest: args.manifest,
    };
}

export function readPilotSessionManifest(manifestPath: string): PilotSessionManifest {
    return JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")) as PilotSessionManifest;
}

export function attachArtifactToPilotSession(args: {
    manifestPath: string;
    artifact: PilotSessionArtifactRef;
    externalOrderId?: string | null;
    marketId?: string | null;
    assetId?: string | null;
    terminalState?: PilotSessionManifest["currentTerminalState"];
}): PilotSessionCaptureResult {
    const manifest = readPilotSessionManifest(args.manifestPath);
    const nextArtifacts = manifest.artifacts.filter((item) => item.artifactType !== args.artifact.artifactType);
    nextArtifacts.push(args.artifact);
    const latestArtifactPaths = {
        ...manifest.latestArtifactPaths,
    };
    setLatestArtifactPath({
        latest: latestArtifactPaths,
        artifactType: args.artifact.artifactType,
        artifactPath: args.artifact.artifactPath,
    });
    const nextManifest: PilotSessionManifest = {
        ...manifest,
        updatedAtMs: args.artifact.attachedAtMs,
        externalOrderId: args.externalOrderId ?? manifest.externalOrderId,
        marketId: args.marketId ?? manifest.marketId,
        assetId: args.assetId ?? manifest.assetId,
        currentTerminalState: args.terminalState ?? manifest.currentTerminalState,
        artifacts: nextArtifacts.sort((a, b) => a.attachedAtMs - b.attachedAtMs),
        latestArtifactPaths,
        attachmentStatus: {
            verificationAttached: Boolean(latestArtifactPaths.verificationResult),
            reconciliationAttached: Boolean(latestArtifactPaths.reconciliationResult),
        },
        latestBundleManifestPath: manifest.latestBundleManifestPath ?? null,
        bundleExports: manifest.bundleExports ?? [],
        missingArtifacts: missingArtifactsFromLatest(latestArtifactPaths),
    };
    return writePilotSessionManifest({
        manifest: nextManifest,
        manifestPath: args.manifestPath,
    });
}

export function summarizePilotSessionManifest(manifest: PilotSessionManifest) {
    return {
        pilotSessionId: manifest.pilotSessionId,
        manifestPath: null as string | null,
        executionAttemptId: manifest.executionAttemptId,
        currentTerminalState: manifest.currentTerminalState,
        externalOrderId: manifest.externalOrderId,
        attachmentStatus: manifest.attachmentStatus,
        latestBundleManifestPath: manifest.latestBundleManifestPath ?? null,
        bundleExportCount: (manifest.bundleExports ?? []).length,
        latestArtifactPaths: manifest.latestArtifactPaths,
        missingArtifacts: manifest.missingArtifacts,
    };
}

export function recordPilotSessionBundleExport(args: {
    manifestPath: string;
    bundleRef: PilotSessionBundleRef;
}): PilotSessionCaptureResult {
    const manifest = readPilotSessionManifest(args.manifestPath);
    const nextBundleExports = (manifest.bundleExports ?? [])
        .filter((item) => item.bundleId !== args.bundleRef.bundleId)
        .concat(args.bundleRef)
        .sort((a, b) => a.exportedAtMs - b.exportedAtMs);
    const nextManifest: PilotSessionManifest = {
        ...manifest,
        updatedAtMs: args.bundleRef.exportedAtMs,
        latestBundleManifestPath: args.bundleRef.bundleManifestPath,
        bundleExports: nextBundleExports,
    };
    return writePilotSessionManifest({
        manifest: nextManifest,
        manifestPath: args.manifestPath,
    });
}

export function resolvePilotSessionManifestPath(args: {
    pilotSessionIdOrPath: string;
    resultDir: string;
}) {
    const explicitPath = path.resolve(args.pilotSessionIdOrPath);
    if (fs.existsSync(explicitPath)) return explicitPath;
    return defaultPilotSessionManifestPath({
        resultDir: args.resultDir,
        pilotSessionId: args.pilotSessionIdOrPath,
    });
}

export function listPilotSessionManifestPaths(resultDir: string): PilotSessionManifestMeta[] {
    try {
        return fs.readdirSync(resultDir)
            .filter((name) => name.endsWith(".session.json"))
            .map((name) => {
                const manifestPath = path.resolve(resultDir, name);
                const stat = fs.statSync(manifestPath);
                return stat.isFile()
                    ? { manifestPath, mtimeMs: stat.mtimeMs }
                    : null;
            })
            .filter((item): item is PilotSessionManifestMeta => item !== null)
            .sort((a, b) => b.mtimeMs - a.mtimeMs);
    } catch {
        return [];
    }
}

export function readLatestPilotSessionManifest(resultDir: string) {
    const entries = listPilotSessionManifestPaths(resultDir);
    const latest = entries[0];
    if (!latest) return null;
    return {
        manifest: readPilotSessionManifest(latest.manifestPath),
        manifestPath: latest.manifestPath,
        mtimeMs: latest.mtimeMs,
        count: entries.length,
    };
}
