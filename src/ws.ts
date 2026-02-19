// src/ws.ts
import WebSocket from "ws";
import { logger } from "./logger";

export type WSFactory = () => WebSocket;

export type WSManagerOpts = {
    name: string;
    makeSocket: WSFactory;
    onOpen?: (ws: WebSocket) => void;
    onMessage?: (data: WebSocket.RawData) => void;
    onClose?: (code: number, reason: Buffer) => void;
    onError?: (err: unknown) => void;

    // Backoff settings
    baseDelayMs?: number;   // default 500
    maxDelayMs?: number;    // default 15000
    jitterPct?: number;     // default 0.25
};

export class WSManager {
    private ws: WebSocket | null = null;
    private stopped = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private attempt = 0;

    constructor(private opts: WSManagerOpts) {}

    start() {
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;

        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch {}
        }
        this.ws = null;
    }

    get socket() {
        return this.ws;
    }

    private connect() {
        if (this.stopped) return;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.attempt += 1;
        logger.info({ attempt: this.attempt }, `Connecting ${this.opts.name}`);

        const ws = this.opts.makeSocket();
        this.ws = ws;

        ws.on("open", () => {
            this.attempt = 0; // reset backoff on success
            logger.info(`${this.opts.name} connected`);
            this.opts.onOpen?.(ws);
        });

        ws.on("message", (data) => {
            this.opts.onMessage?.(data);
        });

        ws.on("close", (code, reason) => {
            logger.warn({ code, reason: reason?.toString?.() }, `${this.opts.name} closed`);
            this.opts.onClose?.(code, reason);
            this.ws = null;
            this.scheduleReconnect();
        });

        ws.on("error", (err) => {
            logger.warn({ err }, `${this.opts.name} error`);
            this.opts.onError?.(err);
            // usually followed by close, but just in case:
        });
    }

    private scheduleReconnect() {
        if (this.stopped) return;
        if (this.reconnectTimer) return; // prevent stampede

        const base = this.opts.baseDelayMs ?? 500;
        const max = this.opts.maxDelayMs ?? 15000;
        const jitterPct = this.opts.jitterPct ?? 0.25;

        // exponential backoff with cap
        const exp = Math.min(max, base * Math.pow(2, Math.max(0, this.attempt - 1)));
        const jitter = exp * jitterPct * (Math.random() * 2 - 1); // +/- jitterPct
        const delay = Math.max(0, Math.round(exp + jitter));

        logger.info({ delayMs: delay }, `Reconnecting ${this.opts.name}`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }
}
