import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { env } from "./config";
import { logger } from "./logger";

type PositionRow = {
    asset?: string | number;
    size?: string | number;
    avgPrice?: string | number;
    redeemable?: boolean;
    title?: string;
};

type DustSweeperOpts = {
    clobClient: ClobClient | null;
    getActiveTokenIds?: () => string[];
};

type DustSweeperSnapshot = {
    enabled: boolean;
    inFlight: boolean;
    cycles: number;
    scanned: number;
    attempted: number;
    succeeded: number;
    skipped: number;
    recoveredNotionalUsdc: number;
    discoveredDustPositions: number;
    discoveredDustNotionalUsdc: number;
    externalDustNotionalUsdc: number;
    lastRunAt: number | null;
    lastError: string | null;
    lastAction: string | null;
    makerAddress: string | null;
    skipReasons: Record<string, number>;
    recentSkips: Array<{
        at: number;
        tokenId: string;
        address: string;
        reason: string;
        size: number;
        bid: number | null;
    }>;
};

function toNum(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
    if (v === undefined) return fallback;
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
    return fallback;
}

function resolveMakerAddress(): string | null {
    if (env.TRADING_USE_SIGNER_AS_MAKER) {
        const pk = process.env.PRIVATE_KEY?.trim();
        if (!pk) return null;
        try {
            return new Wallet(pk).address;
        } catch {
            return null;
        }
    }
    return (
        env.TRADING_FUNDER_ADDRESS
        ?? process.env.POLYMARKET_FUNDER_ADDRESS
        ?? process.env.POLYMARKET_FUNDER
        ?? process.env.CLOB_FUNDER
        ?? null
    )?.trim() || null;
}

async function getBestBid(tokenId: string): Promise<number | null> {
    const res = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
    if (!res.ok) return null;
    const body = await res.json() as any;
    const bids = Array.isArray(body?.bids) ? body.bids : [];
    let best = 0;
    for (const b of bids) {
        const p = toNum(Array.isArray(b) ? b[0] : b?.price);
        if (p > best) best = p;
    }
    return best > 0 ? best : null;
}

export class DustSweeper {
    private readonly clobClient: ClobClient | null;
    private readonly getActiveTokenIds: () => string[];
    private readonly enabled: boolean;
    private readonly intervalMs: number;
    private readonly maxPerCycle: number;
    private readonly minOrderSize: number;
    private readonly minBid: number;
    private readonly maxCycleNotional: number;
    private readonly allowShort: boolean;
    private readonly makerAddress: string | null;
    private readonly scanAddresses: string[];
    private timer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private snapshot: DustSweeperSnapshot;

    constructor(opts: DustSweeperOpts) {
        this.clobClient = opts.clobClient;
        this.getActiveTokenIds = opts.getActiveTokenIds ?? (() => []);
        this.enabled = parseBool(process.env.DUST_SWEEPER_ENABLED, false) && !env.DRY_RUN;
        this.intervalMs = Math.max(15000, Number(process.env.DUST_SWEEPER_INTERVAL_MS ?? "60000"));
        this.maxPerCycle = Math.max(1, Number(process.env.DUST_SWEEPER_MAX_PER_CYCLE ?? "1"));
        this.minOrderSize = Math.max(1, Number(process.env.MIN_ORDER_SIZE ?? "5"));
        this.minBid = Math.max(0.001, Number(process.env.DUST_SWEEPER_MIN_BID ?? "0.03"));
        this.maxCycleNotional = Math.max(0.5, Number(process.env.DUST_SWEEPER_MAX_NOTIONAL_USDC ?? "3"));
        this.allowShort = parseBool(process.env.DUST_SWEEPER_ALLOW_SHORT, true);
        this.makerAddress = resolveMakerAddress();
        this.scanAddresses = (() => {
            const base = [this.makerAddress].filter((x): x is string => Boolean(x));
            const raw = process.env.DUST_SWEEPER_ADDRESSES;
            if (!raw) return base;
            const parsed = raw.split(",").map((s) => s.trim()).filter(Boolean);
            return Array.from(new Set([...base, ...parsed]));
        })();

        this.snapshot = {
            enabled: this.enabled,
            inFlight: false,
            cycles: 0,
            scanned: 0,
            attempted: 0,
            succeeded: 0,
            skipped: 0,
            recoveredNotionalUsdc: 0,
            discoveredDustPositions: 0,
            discoveredDustNotionalUsdc: 0,
            externalDustNotionalUsdc: 0,
            lastRunAt: null,
            lastError: null,
            lastAction: null,
            makerAddress: this.makerAddress,
            skipReasons: {},
            recentSkips: [],
        };
    }

    start() {
        if (!this.enabled) return;
        if (!this.clobClient || !this.makerAddress) {
            logger.warn("Dust sweeper enabled but clob client or maker address missing; disabling sweeper");
            return;
        }
        logger.info(
            {
                intervalMs: this.intervalMs,
                maxPerCycle: this.maxPerCycle,
                minOrderSize: this.minOrderSize,
                maxCycleNotional: this.maxCycleNotional,
                allowShort: this.allowShort,
            },
            "Dust sweeper enabled",
        );
        this.timer = setInterval(() => {
            void this.runCycle();
        }, this.intervalMs);
        void this.runCycle();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    getSnapshot(): DustSweeperSnapshot {
        return { ...this.snapshot, inFlight: this.inFlight };
    }

    private recordSkip(reason: string, ctx: {
        tokenId: string;
        address: string;
        size: number;
        bid?: number | null;
    }) {
        this.snapshot.skipped += 1;
        this.snapshot.skipReasons[reason] = (this.snapshot.skipReasons[reason] ?? 0) + 1;
        this.snapshot.recentSkips.unshift({
            at: Date.now(),
            tokenId: ctx.tokenId,
            address: ctx.address,
            reason,
            size: ctx.size,
            bid: ctx.bid ?? null,
        });
        if (this.snapshot.recentSkips.length > 12) this.snapshot.recentSkips.length = 12;
    }

    private async runCycle() {
        if (this.inFlight || !this.clobClient || !this.makerAddress) return;
        this.inFlight = true;
        this.snapshot.inFlight = true;
        this.snapshot.cycles += 1;
        this.snapshot.lastRunAt = Date.now();
        this.snapshot.lastError = null;

        try {
            const active = new Set(this.getActiveTokenIds().map(String));
            this.snapshot.discoveredDustPositions = 0;
            this.snapshot.discoveredDustNotionalUsdc = 0;
            this.snapshot.externalDustNotionalUsdc = 0;

            let actions = 0;
            let notionalUsed = 0;
            for (const address of this.scanAddresses) {
                const res = await fetch(`https://data-api.polymarket.com/positions?user=${encodeURIComponent(address)}&sizeThreshold=0`);
                if (!res.ok) continue;
                const rows = (await res.json()) as PositionRow[];
                if (!Array.isArray(rows)) continue;

                for (const row of rows) {
                    if (actions >= this.maxPerCycle) break;
                    const tokenId = String(row?.asset ?? "");
                    const size = toNum(row?.size);
                    if (!tokenId || size <= 0) continue;
                    if (active.has(tokenId)) continue; // don't interfere with active maker market
                    if (row?.redeemable) continue; // handled by claims later
                    this.snapshot.scanned += 1;

                    let targetSellSize = 0;
                    if (size >= this.minOrderSize) {
                        targetSellSize = Math.floor(size * 100) / 100;
                    } else if (this.allowShort) {
                        targetSellSize = this.minOrderSize;
                    } else {
                        this.recordSkip("size_below_min_and_short_disabled", {
                            tokenId,
                            address,
                            size,
                        });
                        continue;
                    }

                    const bid = await getBestBid(tokenId);
                    if (bid === null || bid < this.minBid) {
                        this.recordSkip("bid_below_min_or_missing", {
                            tokenId,
                            address,
                            size,
                            bid,
                        });
                        continue;
                    }
                    const estNotional = targetSellSize * bid;
                    this.snapshot.discoveredDustPositions += 1;
                    this.snapshot.discoveredDustNotionalUsdc += estNotional;
                    if (this.makerAddress && address.toLowerCase() !== this.makerAddress.toLowerCase()) {
                        this.snapshot.externalDustNotionalUsdc += estNotional;
                        this.recordSkip("external_address_discovery_only", {
                            tokenId,
                            address,
                            size,
                            bid,
                        });
                        continue; // can discover, but cannot trade dust on other addresses with this signer
                    }

                    if (notionalUsed + estNotional > this.maxCycleNotional) {
                        this.recordSkip("cycle_notional_cap", {
                            tokenId,
                            address,
                            size,
                            bid,
                        });
                        continue;
                    }

                    try {
                        await this.clobClient.createAndPostOrder(
                            { tokenID: tokenId, side: Side.SELL, size: targetSellSize, price: bid },
                            { tickSize: String(0.01) as any },
                            OrderType.GTC,
                        );
                        actions += 1;
                        notionalUsed += estNotional;
                        this.snapshot.attempted += 1;
                        this.snapshot.succeeded += 1;
                        this.snapshot.recoveredNotionalUsdc += estNotional;
                        this.snapshot.lastAction = `SELL ${targetSellSize} ${tokenId.slice(0, 8)}... @ ${bid}`;
                        logger.info(
                            { address, tokenId, size, targetSellSize, bid, estNotional, title: row?.title ?? null },
                            "Dust sweep sell posted",
                        );
                    } catch (err) {
                        this.snapshot.attempted += 1;
                        this.recordSkip("order_post_failed", {
                            tokenId,
                            address,
                            size,
                            bid,
                        });
                        logger.warn(
                            { address, tokenId, size, targetSellSize, bid, err: err instanceof Error ? err.message : String(err) },
                            "Dust sweep sell failed",
                        );
                    }
                }
            }
        } catch (err) {
            this.snapshot.lastError = err instanceof Error ? err.message : String(err);
        } finally {
            this.inFlight = false;
            this.snapshot.inFlight = false;
        }
    }
}
