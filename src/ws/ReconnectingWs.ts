// src/ws/ReconnectingWs.ts
import WebSocket from "ws";
import { logger } from "../logger";

type ReconnectingWsOpts = {
    url: string;
    name: string;
    onOpen?: () => void;
    onMessage?: (data: WebSocket.RawData) => void;
    onClose?: (code: number, reason: Buffer) => void;
    onError?: (err: unknown) => void;
    headers?: Record<string, string>;
    reconnectMinDelayMs?: number;
    reconnectMaxDelayMs?: number;

    // Optional: if you want to tune timeouts later
    handshakeTimeoutMs?: number;
};

export class ReconnectingWs {
    private ws: WebSocket | null = null;
    private stopped = true;
    private attempt = 0;

    private readonly url: string;
    private readonly name: string;
    private readonly onOpen?: () => void;
    private readonly onMessage?: (data: WebSocket.RawData) => void;
    private readonly onClose?: (code: number, reason: Buffer) => void;
    private readonly onError?: (err: unknown) => void;
    private readonly headers?: Record<string, string>;
    private readonly minDelay: number;
    private readonly maxDelay: number;
    private readonly handshakeTimeoutMs: number;

    // If we detect “hard” rejection, cool down to avoid rate-limiting ourselves
    private coolDownUntil = 0;

    constructor(opts: ReconnectingWsOpts) {
        this.url = opts.url;
        this.name = opts.name;
        this.onOpen = opts.onOpen;
        this.onMessage = opts.onMessage;
        this.onClose = opts.onClose;
        this.onError = opts.onError;
        this.headers = opts.headers;
        this.minDelay = opts.reconnectMinDelayMs ?? 400;
        this.maxDelay = opts.reconnectMaxDelayMs ?? 5000;
        this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 8000;
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.attempt = 0;
        this.coolDownUntil = 0;
        this.connect();
    }

    stop() {
        this.stopped = true;
        try {
            this.ws?.close(1000, "shutdown");
        } catch {}
        this.ws = null;
    }

    sendJson(obj: unknown) {
        const text = JSON.stringify(obj);
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(text);
    }

    private connect() {
        if (this.stopped) return;

        const now = Date.now();
        if (this.coolDownUntil > now) {
            const waitMs = this.coolDownUntil - now;
            logger.warn({ waitMs }, `${this.name} WS cooldown active; delaying reconnect`);
            setTimeout(() => this.connect(), waitMs);
            return;
        }

        this.attempt += 1;
        logger.info({ attempt: this.attempt, url: this.url }, `Connecting ${this.name} WS`);

        const ws = new WebSocket(this.url, {
            headers: this.headers,
            handshakeTimeout: this.handshakeTimeoutMs,
            perMessageDeflate: false,
        });
        this.ws = ws;

        ws.on("open", () => {
            logger.info(`${this.name} WS connected`);
            this.onOpen?.();
        });

        ws.on("message", (data) => this.onMessage?.(data));

        // CRITICAL: if the server rejects the upgrade with an HTTP status,
        // we can see it here (401/403/429 etc).
        ws.on("unexpected-response", (_req, res) => {
            const statusCode = res.statusCode ?? 0;
            const headers = res.headers ?? {};
            logger.error(
                {
                    statusCode,
                    headers,
                    url: this.url,
                },
                `${this.name} WS unexpected HTTP response during upgrade`,
            );

            // back off harder on likely “hard” rejections / throttling
            if (statusCode === 401 || statusCode === 403) {
                this.coolDownUntil = Date.now() + 30_000; // 30s
            }
            if (statusCode === 429) {
                this.coolDownUntil = Date.now() + 60_000; // 60s
            }
        });

        ws.on("close", (code, reason) => {
            // reason is a Buffer; log both string + raw hex (helpful when it’s non-utf8/empty)
            const reasonStr = reason?.toString?.("utf8") ?? "";
            const reasonHex = Buffer.isBuffer(reason) ? reason.toString("hex") : "";

            this.onClose?.(code, reason);

            if (this.stopped) return;

            logger.warn(
                {
                    code,
                    reason: reasonStr,
                    reasonHex,
                },
                `${this.name} WS closed`,
            );

            const delay = this.backoffDelayMs(code);
            logger.info({ delayMs: delay }, `Reconnecting ${this.name} WS`);
            setTimeout(() => this.connect(), delay);
        });

        ws.on("error", (err) => {
            this.onError?.(err);
            // error often precedes close; keep it visible
            logger.warn({ err }, `${this.name} WS error`);
        });
    }

    private backoffDelayMs(closeCode?: number) {
        // If we get abnormal closure quickly (1006), slow down a bit more to avoid hammering
        const multiplier = closeCode === 1006 ? 2.0 : 1.0;

        const base = Math.min(
            this.maxDelay,
            this.minDelay * Math.pow(1.4, Math.max(0, this.attempt - 1)),
        );
        const jitter = base * (0.2 * Math.random());
        return Math.floor((base + jitter) * multiplier);
    }
}
