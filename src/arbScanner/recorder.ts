import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";
import {
    BinaryMarket,
    Opportunity,
    RecordedEvent,
    RecordedResolutionEvent,
    SimulatedFill,
    SimulatedPosition,
    TopOfBook,
} from "./types";

type RecorderOpts = {
    enabled: boolean;
    dir?: string;
    sessionName?: string;
};

function safeFilePart(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

export class ArbRecorder {
    private readonly enabled: boolean;
    private readonly dir: string;
    private readonly filePath: string | null;
    private stream: fs.WriteStream | null = null;

    constructor(opts: RecorderOpts) {
        this.enabled = opts.enabled;
        this.dir = path.resolve(process.cwd(), opts.dir ?? "data/recordings");
        const sessionName = safeFilePart(opts.sessionName ?? `arb-${new Date().toISOString()}`);
        this.filePath = this.enabled ? path.join(this.dir, `${sessionName}.jsonl`) : null;

        if (this.enabled && this.filePath) {
            fs.mkdirSync(this.dir, { recursive: true });
            this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
            logger.info({ path: this.filePath }, "Arbitrage recorder active");
        }
    }

    append(event: RecordedEvent) {
        if (!this.enabled || !this.stream) return;
        this.stream.write(`${JSON.stringify(event)}\n`);
    }

    recordSessionStart(mode: "scan" | "paper", config: Record<string, unknown>) {
        this.append({
            type: "session_start",
            ts: Date.now(),
            mode,
            config,
        });
    }

    recordMarkets(markets: BinaryMarket[]) {
        const ts = Date.now();
        for (const market of markets) {
            this.append({ type: "market_metadata", ts, market });
        }
    }

    recordWsMessage(payload: unknown, ts: number) {
        this.append({ type: "ws_market", ts, payload });
    }

    recordBookTop(tokenId: string, top: TopOfBook, ts = top.updatedAt) {
        this.append({ type: "book_top", ts, tokenId, top });
    }

    recordOpportunity(opportunity: Opportunity) {
        this.append({ type: "opportunity", ts: opportunity.observedAt, opportunity });
    }

    recordSimFill(fill: SimulatedFill) {
        this.append({ type: "sim_fill", ts: fill.ts, fill });
    }

    recordPositionOpen(position: SimulatedPosition) {
        this.append({ type: "position_open", ts: position.openedAt, position });
    }

    recordPositionResolve(position: SimulatedPosition) {
        this.append({ type: "position_resolve", ts: position.resolvedAt ?? Date.now(), position });
    }

    recordResolutionEvent(resolution: RecordedResolutionEvent) {
        this.append({ type: "resolution_event", ts: resolution.resolvedAtMs, resolution });
    }

    getStatus() {
        return {
            enabled: this.enabled,
            filePath: this.filePath,
        };
    }

    stop() {
        this.stream?.end();
        this.stream = null;
    }
}
