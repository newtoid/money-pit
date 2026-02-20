import WebSocket from "ws";
import { logger } from "./logger";

export type SpotSnapshot = {
    connected: boolean;
    price: number | null;
    updatedAt: number | null;
    reconnects: number;
    messages: number;
    lastError: string | null;
};

type SpotFeedOpts = {
    url?: string;
    productId?: string;
    onPrice?: (price: number) => void;
};

export class SpotFeed {
    private readonly url: string;
    private readonly productId: string;
    private readonly onPrice?: (price: number) => void;
    private ws: WebSocket | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private backoffMs = 500;
    private snapshot: SpotSnapshot = {
        connected: false,
        price: null,
        updatedAt: null,
        reconnects: 0,
        messages: 0,
        lastError: null,
    };

    constructor(opts?: SpotFeedOpts) {
        this.url = opts?.url ?? process.env.SPOT_WS_URL ?? "wss://ws-feed.exchange.coinbase.com";
        this.productId = opts?.productId ?? process.env.SPOT_PRODUCT_ID ?? "BTC-USD";
        this.onPrice = opts?.onPrice;
    }

    start() {
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        if (this.ws) this.ws.close();
        this.ws = null;
    }

    getSnapshot(): SpotSnapshot {
        return { ...this.snapshot };
    }

    private connect() {
        if (this.stopped) return;
        this.ws = new WebSocket(this.url);

        this.ws.on("open", () => {
            this.snapshot.connected = true;
            this.snapshot.lastError = null;
            this.backoffMs = 500;
            this.ws?.send(JSON.stringify({
                type: "subscribe",
                channels: [{ name: "ticker", product_ids: [this.productId] }],
            }));
            logger.info({ url: this.url, productId: this.productId }, "Spot feed connected");
        });

        this.ws.on("message", (data) => {
            this.snapshot.messages += 1;
            try {
                const msg = JSON.parse(data.toString("utf8"));
                if (msg?.type !== "ticker") return;
                const price = Number(msg?.price);
                if (!Number.isFinite(price) || price <= 0) return;
                this.snapshot.price = price;
                this.snapshot.updatedAt = Date.now();
                this.onPrice?.(price);
            } catch {
                // ignore non-json
            }
        });

        this.ws.on("error", (err) => {
            this.snapshot.lastError = err instanceof Error ? err.message : String(err);
            logger.warn({ err: this.snapshot.lastError }, "Spot feed error");
        });

        this.ws.on("close", () => {
            this.snapshot.connected = false;
            if (this.stopped) return;
            this.snapshot.reconnects += 1;
            const delay = this.backoffMs;
            this.backoffMs = Math.min(10_000, this.backoffMs * 2);
            this.reconnectTimer = setTimeout(() => this.connect(), delay);
        });
    }
}

