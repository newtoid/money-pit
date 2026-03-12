import fs from "node:fs";
import path from "node:path";
import { loadLiveOrderPilotConfig } from "../config/liveOrderPilot";
import { LiveOrderPilotResult } from "./types";
import { LivePostSubmitVerificationResult } from "./livePostSubmitVerification";

type LiveOpsArtifactMeta = {
    filePath: string | null;
    mtimeMs: number | null;
};

export type LiveOpsStatusSnapshot = {
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
    return {
        pilot,
        verification,
    };
}
