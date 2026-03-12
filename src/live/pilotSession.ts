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

export function defaultPilotSessionBundleDir(args: {
    resultDir: string;
    pilotSessionId: string;
}) {
    return path.resolve(args.resultDir, "sessions", args.pilotSessionId);
}

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
    return path.resolve(defaultPilotSessionBundleDir(args), "session-manifest.json");
}

export function defaultPilotResultPath(args: {
    resultDir: string;
    pilotSessionId: string;
}) {
    return path.resolve(defaultPilotSessionBundleDir(args), "pilot-result.json");
}

export function defaultPilotOrderBaselinePath(args: {
    resultDir: string;
    pilotSessionId: string;
}) {
    return path.resolve(defaultPilotSessionBundleDir(args), "internal-baseline.orders.json");
}

export function defaultPilotVerificationPath(args: {
    resultDir: string;
    pilotSessionId: string;
}) {
    return path.resolve(defaultPilotSessionBundleDir(args), "verification-result.json");
}

export function defaultPilotReconciliationPath(args: {
    resultDir: string;
    pilotSessionId: string;
}) {
    return path.resolve(defaultPilotSessionBundleDir(args), "reconciliation-result.json");
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
    manifestPath: string;
    sessionBundleDir: string;
    submissionParameters: {
        side: "buy" | "sell";
        price: number;
        size: number;
        tickSize: string;
        timeInForce: "GTC";
    };
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
        sessionId: args.pilotSessionId,
        pilotSessionId: args.pilotSessionId,
        sessionManifestPath: path.resolve(args.manifestPath),
        sessionBundleDir: path.resolve(args.sessionBundleDir),
        sourceLabel: args.sourceLabel,
        timestamp: args.createdAtMs,
        createdAtMs: args.createdAtMs,
        updatedAtMs: args.createdAtMs,
        executionAttemptId: args.executionAttemptId,
        market: args.marketId,
        marketId: args.marketId,
        asset: args.assetId,
        assetId: args.assetId,
        externalOrderId: args.externalOrderId,
        submissionParameters: args.submissionParameters,
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
    const nextArtifacts = [...manifest.artifacts, args.artifact];
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
        sessionManifestPath: manifest.sessionManifestPath ?? path.resolve(args.manifestPath),
        externalOrderId: args.externalOrderId ?? manifest.externalOrderId,
        marketId: args.marketId ?? manifest.marketId,
        market: args.marketId ?? manifest.marketId ?? manifest.market,
        assetId: args.assetId ?? manifest.assetId,
        asset: args.assetId ?? manifest.assetId ?? manifest.asset,
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
        sessionBundleDir: manifest.sessionBundleDir ?? null,
        currentTerminalState: manifest.currentTerminalState,
        externalOrderId: manifest.externalOrderId,
        submissionParameters: manifest.submissionParameters,
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
    const canonicalPath = defaultPilotSessionManifestPath({
        resultDir: args.resultDir,
        pilotSessionId: args.pilotSessionIdOrPath,
    });
    if (fs.existsSync(canonicalPath)) return canonicalPath;
    return defaultPilotSessionManifestPath({
        resultDir: args.resultDir,
        pilotSessionId: args.pilotSessionIdOrPath,
    });
}

export function listPilotSessionManifestPaths(resultDir: string): PilotSessionManifestMeta[] {
    try {
        const sessionsDir = path.resolve(resultDir, "sessions");
        return fs.readdirSync(sessionsDir)
            .map((name) => path.resolve(sessionsDir, name, "session-manifest.json"))
            .map((manifestPath) => {
                try {
                    const stat = fs.statSync(manifestPath);
                    return stat.isFile() ? { manifestPath, mtimeMs: stat.mtimeMs } : null;
                } catch {
                    return null;
                }
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
