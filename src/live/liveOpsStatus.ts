import fs from "node:fs";
import path from "node:path";
import { loadLiveOrderPilotConfig } from "../config/liveOrderPilot";
import { LiveOrderPilotResult } from "./types";
import { LivePostSubmitVerificationResult } from "./livePostSubmitVerification";
import { readLatestPilotSessionManifest, listPilotSessionManifestPaths } from "./pilotSession";

type LiveOpsArtifactMeta = {
    filePath: string | null;
    mtimeMs: number | null;
};

export type LiveOpsStatusSnapshot = {
    sessions: {
        latest: {
            pilotSessionId: string;
            manifestPath: string;
            mtimeMs: number;
            currentTerminalState: string;
            attachmentStatus: {
                verificationAttached: boolean;
                reconciliationAttached: boolean;
            };
            missingArtifacts: string[];
            externalOrderId: string | null;
            marketId: string | null;
            assetId: string | null;
            latestBundleManifestPath: string | null;
            bundleExportCount: number;
        } | null;
        count: number;
        countsByGap: {
            missingVerification: number;
            missingReconciliation: number;
            fullyLinked: number;
        };
        latestBundle: {
            bundleManifestPath: string;
            exportedAtMs: number;
            missingArtifactTypes: string[];
        } | null;
    };
    pilot: {
        latest: (LiveOrderPilotResult & LiveOpsArtifactMeta) | null;
        count: number;
    };
    verification: {
        latest: (LivePostSubmitVerificationResult & LiveOpsArtifactMeta) | null;
        count: number;
    };
};

function safeReadDir(dirPath: string): string[] {
    try {
        return fs.readdirSync(dirPath);
    } catch {
        return [];
    }
}

function latestJsonArtifact<T>(args: {
    dirPath: string;
    fileSuffix: string;
}): { latest: (T & LiveOpsArtifactMeta) | null; count: number } {
    const entries = safeReadDir(args.dirPath)
        .filter((name) => name.endsWith(args.fileSuffix))
        .map((name) => {
            const filePath = path.resolve(args.dirPath, name);
            try {
                const stat = fs.statSync(filePath);
                if (!stat.isFile()) return null;
                return { filePath, mtimeMs: stat.mtimeMs };
            } catch {
                return null;
            }
        })
        .filter((item): item is { filePath: string; mtimeMs: number } => item !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const latestEntry = entries[0] ?? null;
    if (!latestEntry) {
        return { latest: null, count: 0 };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(latestEntry.filePath, "utf8")) as T;
        return {
            latest: {
                ...parsed,
                filePath: latestEntry.filePath,
                mtimeMs: latestEntry.mtimeMs,
            },
            count: entries.length,
        };
    } catch {
        return { latest: null, count: entries.length };
    }
}

export function readLiveOpsStatusSnapshot(): LiveOpsStatusSnapshot {
    const pilotConfig = loadLiveOrderPilotConfig();
    const pilot = latestJsonArtifact<LiveOrderPilotResult>({
        dirPath: pilotConfig.resultDir,
        fileSuffix: ".result.json",
    });
    const verification = latestJsonArtifact<LivePostSubmitVerificationResult>({
        dirPath: pilotConfig.resultDir,
        fileSuffix: ".verify.json",
    });
    const sessionEntries = listPilotSessionManifestPaths(pilotConfig.resultDir);
    const latestSession = readLatestPilotSessionManifest(pilotConfig.resultDir);
    const countsByGap = sessionEntries.reduce((acc, item) => {
        try {
            const manifest = JSON.parse(fs.readFileSync(item.manifestPath, "utf8")) as {
                attachmentStatus?: { verificationAttached?: boolean; reconciliationAttached?: boolean };
            };
            const verificationAttached = Boolean(manifest.attachmentStatus?.verificationAttached);
            const reconciliationAttached = Boolean(manifest.attachmentStatus?.reconciliationAttached);
            if (!verificationAttached) acc.missingVerification += 1;
            if (!reconciliationAttached) acc.missingReconciliation += 1;
            if (verificationAttached && reconciliationAttached) acc.fullyLinked += 1;
        } catch {
            acc.missingVerification += 1;
            acc.missingReconciliation += 1;
        }
        return acc;
    }, {
        missingVerification: 0,
        missingReconciliation: 0,
        fullyLinked: 0,
    });
    return {
        sessions: {
            latest: latestSession
                ? {
                    pilotSessionId: latestSession.manifest.pilotSessionId,
                    manifestPath: latestSession.manifestPath,
                    mtimeMs: latestSession.mtimeMs,
                    currentTerminalState: latestSession.manifest.currentTerminalState,
                    attachmentStatus: latestSession.manifest.attachmentStatus,
                    missingArtifacts: latestSession.manifest.missingArtifacts,
                    externalOrderId: latestSession.manifest.externalOrderId,
                    marketId: latestSession.manifest.marketId,
                    assetId: latestSession.manifest.assetId,
                    latestBundleManifestPath: latestSession.manifest.latestBundleManifestPath ?? null,
                    bundleExportCount: (latestSession.manifest.bundleExports ?? []).length,
                }
                : null,
            count: sessionEntries.length,
            countsByGap,
            latestBundle: latestSession?.manifest.latestBundleManifestPath
                ? {
                    bundleManifestPath: latestSession.manifest.latestBundleManifestPath,
                    exportedAtMs: ((latestSession.manifest.bundleExports ?? []).slice(-1)[0]?.exportedAtMs ?? null) ?? latestSession.mtimeMs,
                    missingArtifactTypes: ((latestSession.manifest.bundleExports ?? []).slice(-1)[0]?.missingArtifactTypes ?? []),
                }
                : null,
        },
        pilot,
        verification,
    };
}
