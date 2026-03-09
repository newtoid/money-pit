import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

type SnapshotRecord = {
    ts: number;
    marketId: string;
    slug: string;
    spotPrice: number;
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
};

type SnapshotRecorderOpts = {
    enabled?: boolean;
    dir?: string;
    minIntervalMs?: number;
};

function sanitizeFilePart(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160);
}

export class SnapshotRecorder {
    private readonly enabled: boolean;
    private readonly dir: string;
    private readonly minIntervalMs: number;
    private currentKey = "";
    private currentPath = "";
    private stream: fs.WriteStream | null = null;
    private lastWrittenAt = 0;

    constructor(opts?: SnapshotRecorderOpts) {
        this.enabled = opts?.enabled ?? false;
        this.dir = path.resolve(process.cwd(), opts?.dir ?? "data/snapshots");
        this.minIntervalMs = Math.max(0, opts?.minIntervalMs ?? 250);
    }

    record(snapshot: SnapshotRecord) {
        if (!this.enabled) return;
        if (!Number.isFinite(snapshot.spotPrice) || snapshot.spotPrice <= 0) return;
        if (!Number.isFinite(snapshot.yesBid) || !Number.isFinite(snapshot.yesAsk)) return;
        if (!Number.isFinite(snapshot.noBid) || !Number.isFinite(snapshot.noAsk)) return;

        const now = snapshot.ts;
        if (this.minIntervalMs > 0 && now - this.lastWrittenAt < this.minIntervalMs) return;

        const key = `${snapshot.marketId}:${snapshot.slug}`;
        if (key !== this.currentKey) {
            this.rotate(snapshot.marketId, snapshot.slug);
        }

        this.stream?.write(`${JSON.stringify(snapshot)}\n`);
        this.lastWrittenAt = now;
    }

    stop() {
        this.stream?.end();
        this.stream = null;
        this.currentKey = "";
        this.currentPath = "";
        this.lastWrittenAt = 0;
    }

    getStatus() {
        return {
            enabled: this.enabled,
            dir: this.dir,
            currentPath: this.currentPath || null,
            currentKey: this.currentKey || null,
            minIntervalMs: this.minIntervalMs,
            lastWrittenAt: this.lastWrittenAt || null,
        };
    }

    private rotate(marketId: string, slug: string) {
        this.stop();
        fs.mkdirSync(this.dir, { recursive: true });
        const fileName = `${sanitizeFilePart(slug || marketId)}.jsonl`;
        this.currentPath = path.join(this.dir, fileName);
        this.stream = fs.createWriteStream(this.currentPath, { flags: "a" });
        this.currentKey = `${marketId}:${slug}`;
        logger.info({ path: this.currentPath, marketId, slug }, "Snapshot recording active");
    }
}
