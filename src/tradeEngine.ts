import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { env } from "./config";
import { logger } from "./logger";

type TopOfBook = {
    bid: number | null;
    ask: number | null;
    updatedAt: number;
};

type QuoteState = {
    lastPlacedBid: number | null;
    lastPlacedAsk: number | null;
    lastQuoteAt: number;
    reconnects: number;
    marketMessages: number;
    userMessages: number;
    parsedBookUpdates: number;
    ignoredMarketMessages: number;
    currentYesPosition: number;
    quoteCycles: number;
    skippedInsufficientCollateral: number;
    orderErrors: number;
    buyOrdersPlaced: number;
    sellOrdersPlaced: number;
    fills: number;
};

type EngineOpts = {
    marketId: string;
    tokenIds: string[];
    marketEndUnixSec?: number | null;
    clobClient: ClobClient | null;
    dryRun: boolean;
    tradingEnabled: boolean;
};

type LastQuote = {
    at: number;
    fairYes: number;
    bid: number;
    ask: number;
    skew: number;
    lagSkew: number;
    lagBps: number | null;
    lagMode: "bullish_yes" | "bearish_yes" | "neutral";
    inventory: number;
    mode: "dry_run" | "live";
} | null;

type CollateralState = {
    balanceRaw: bigint;
    allowanceRaw: bigint;
    updatedAt: number;
    lastError: string | null;
};

type PositionRow = {
    asset?: string | number;
    size?: string | number;
    avgPrice?: string | number;
};

function toNumber(v: unknown): number | null {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n;
}

function parseRawAllowance(payload: any): bigint {
    const direct = payload?.allowance ?? payload?.maxOrderSize ?? payload?.max_size;
    if (direct !== undefined && direct !== null) {
        try {
            return BigInt(String(direct));
        } catch {
            return 0n;
        }
    }
    const allowances = payload?.allowances;
    if (allowances && typeof allowances === "object") {
        let best = 0n;
        for (const v of Object.values(allowances)) {
            try {
                const n = BigInt(String(v));
                if (n > best) best = n;
            } catch {
                // ignore malformed value
            }
        }
        return best;
    }
    return 0n;
}

function parseLevels(raw: unknown): Array<{ price: number; size: number }> {
    if (!Array.isArray(raw)) return [];
    const levels: Array<{ price: number; size: number }> = [];
    for (const level of raw) {
        if (Array.isArray(level) && level.length >= 2) {
            const p = toNumber(level[0]);
            const s = toNumber(level[1]);
            if (p !== null && s !== null) levels.push({ price: p, size: s });
            continue;
        }
        if (level && typeof level === "object") {
            const p = toNumber((level as any).price);
            const s = toNumber((level as any).size);
            if (p !== null && s !== null) levels.push({ price: p, size: s });
        }
    }
    return levels;
}

function bestBidAsk(rawBids: unknown, rawAsks: unknown): { bid: number | null; ask: number | null } {
    const bids = parseLevels(rawBids).sort((a, b) => b.price - a.price);
    const asks = parseLevels(rawAsks).sort((a, b) => a.price - b.price);
    return {
        bid: bids[0]?.price ?? null,
        ask: asks[0]?.price ?? null,
    };
}

function clampPrice(price: number) {
    return Math.max(0.001, Math.min(0.999, price));
}

function clampToTickBounds(price: number, tick: number) {
    const min = tick;
    const max = 1 - tick;
    return Math.max(min, Math.min(max, price));
}

function roundDownToTick(price: number, tick: number) {
    return Math.floor(price / tick) * tick;
}

function roundUpToTick(price: number, tick: number) {
    return Math.ceil(price / tick) * tick;
}

function getEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return v;
}

function getEnvInt(name: string, fallback: number): number {
    const raw = process.env[name];
    const v = Number(raw);
    if (!Number.isFinite(v)) return fallback;
    return Math.floor(v);
}

function getEnvBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const v = String(raw).trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(v)) return true;
    if (["false", "0", "no", "n", "off"].includes(v)) return false;
    return fallback;
}

export class TradeEngine {
    private readonly marketId: string;
    private readonly tokenIds: string[];
    private readonly yesTokenId: string;
    private readonly noTokenId: string;
    private readonly clobClient: ClobClient | null;
    private readonly dryRun: boolean;
    private readonly tradingEnabled: boolean;

    private readonly tickSize = getEnvNumber("TICK_SIZE", 0.01);
    private readonly halfSpread = getEnvNumber("HALF_SPREAD", 0.01);
    private readonly orderSize = getEnvNumber("ORDER_SIZE", 5);
    private readonly maxPosition = Math.max(1, getEnvNumber("MAX_POSITION", 100));
    private readonly requoteTickThreshold = getEnvInt("REQUOTE_TICK_THRESHOLD", 1);
    private readonly minRequoteMs = getEnvInt("MIN_REQUOTE_MS", 3000);
    private readonly forceRequoteMs = Math.max(this.minRequoteMs, getEnvInt("FORCE_REQUOTE_MS", 8000));
    private readonly statusEveryMs = getEnvInt("STATUS_EVERY_MS", 30000);
    private readonly positionPollMs = Math.max(3000, getEnvInt("POSITION_POLL_MS", 8000));
    private readonly allowShortSell = env.ALLOW_SHORT_SELL;
    private readonly collateralRefreshMs = getEnvInt("COLLATERAL_REFRESH_MS", 20000);
    private readonly maxInventoryNotionalUsdc = env.MAX_INVENTORY_NOTIONAL_USDC;
    private readonly takeProfitEnabled = env.TAKE_PROFIT_ENABLED;
    private readonly takeProfitPct = env.TAKE_PROFIT_PCT;
    private readonly minOrderSize = Math.max(0, getEnvNumber("MIN_ORDER_SIZE", 5));
    private readonly minBuyNotionalUsdc = Math.max(0, getEnvNumber("MIN_BUY_NOTIONAL_USDC", 1));
    private readonly dustRecoveryEnabled = getEnvBool("DUST_RECOVERY_ENABLED", true);
    private readonly noNewOrdersBeforeEndSec = Math.max(0, getEnvInt("NO_NEW_ORDERS_BEFORE_END", 30));
    private readonly cancelAllBeforeEndSec = Math.max(0, getEnvInt("CANCEL_ALL_BEFORE_END", 15));
    private readonly lagArbEnabled = getEnvBool("LAG_ARB_ENABLED", true);
    private readonly lagEnterBps = Math.max(0, getEnvNumber("LAG_ENTER_BPS", 4));
    private readonly lagExitBps = Math.max(0, getEnvNumber("LAG_EXIT_BPS", 2));
    private readonly lagMaxSkew = Math.max(0, getEnvNumber("MAX_LAG_SKEW", 0.01));
    private readonly lagSizeMult = Math.max(1, getEnvNumber("LAG_SIZE_MULT", 1.25));
    private readonly lagStaleMs = Math.max(500, getEnvInt("LAG_STALE_MS", 2500));
    private readonly lagDisableBeforeEndSec = Math.max(0, getEnvInt("LAG_DISABLE_BEFORE_END_SEC", 35));
    private readonly signalK = Math.max(1, getEnvNumber("SIGNAL_K", 60));

    private readonly books = new Map<string, TopOfBook>();
    private readonly state: QuoteState = {
        lastPlacedBid: null,
        lastPlacedAsk: null,
        lastQuoteAt: 0,
        reconnects: 0,
        marketMessages: 0,
        userMessages: 0,
        parsedBookUpdates: 0,
        ignoredMarketMessages: 0,
        currentYesPosition: 0,
        quoteCycles: 0,
        skippedInsufficientCollateral: 0,
        orderErrors: 0,
        buyOrdersPlaced: 0,
        sellOrdersPlaced: 0,
        fills: 0,
    };

    private statusTimer: NodeJS.Timeout | null = null;
    private bookPollTimer: NodeJS.Timeout | null = null;
    private positionPollTimer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private lastQuote: LastQuote = null;
    private avgEntryPriceYes = 0;
    private realizedPnlYes = 0;
    private lastFill: { at: number; tokenId: string; side: string; size: number; price: number } | null = null;
    private lastInsufficientCollateralLogAt = 0;
    private collateral: CollateralState = {
        balanceRaw: 0n,
        allowanceRaw: 0n,
        updatedAt: 0,
        lastError: null,
    };
    private lastAllowanceSyncAttemptAt = 0;
    private lastPositionPollErrorAt = 0;
    private lastCancelAllAt = 0;
    private readonly makerAddress: string | null;
    private readonly marketEndUnixSec: number | null;
    private spotMoveBps: number | null = null;
    private spotUpdatedAt: number | null = null;
    private spotConnected = false;
    private lagRegime: -1 | 0 | 1 = 0;

    constructor(opts: EngineOpts) {
        this.marketId = opts.marketId;
        this.tokenIds = opts.tokenIds;
        this.yesTokenId = this.tokenIds[0] ?? "";
        this.noTokenId = this.tokenIds[1] ?? "";
        this.clobClient = opts.clobClient;
        this.dryRun = opts.dryRun;
        this.tradingEnabled = opts.tradingEnabled;
        this.marketEndUnixSec = opts.marketEndUnixSec ?? null;
        this.makerAddress = this.resolveMakerAddress();
    }

    start() {
        if (!this.yesTokenId || !this.noTokenId) {
            logger.error({ tokenIds: this.tokenIds }, "Trade engine disabled: expected two token IDs");
            return;
        }

        this.statusTimer = setInterval(() => {
            const yes = this.books.get(this.yesTokenId);
            const no = this.books.get(this.noTokenId);
            logger.info(
                {
                    marketId: this.marketId,
                    yesTokenId: this.yesTokenId,
                    noTokenId: this.noTokenId,
                    yesTop: yes ? { bid: yes.bid, ask: yes.ask } : null,
                    noTop: no ? { bid: no.bid, ask: no.ask } : null,
                    lastPlaced: {
                        bid: this.state.lastPlacedBid,
                        ask: this.state.lastPlacedAsk,
                        at: this.state.lastQuoteAt || null,
                    },
                    dryRun: this.dryRun,
                    marketMessages: this.state.marketMessages,
                    userMessages: this.state.userMessages,
                    reconnects: this.state.reconnects,
                    parsedBookUpdates: this.state.parsedBookUpdates,
                    ignoredMarketMessages: this.state.ignoredMarketMessages,
                    currentYesPosition: this.state.currentYesPosition,
                    quoteCycles: this.state.quoteCycles,
                    skippedInsufficientCollateral: this.state.skippedInsufficientCollateral,
                    orderErrors: this.state.orderErrors,
                    buyOrdersPlaced: this.state.buyOrdersPlaced,
                    sellOrdersPlaced: this.state.sellOrdersPlaced,
                    fills: this.state.fills,
                    realizedPnlYes: Number(this.realizedPnlYes.toFixed(4)),
                    unrealizedPnlYes: Number(this.unrealizedPnlYes().toFixed(4)),
                    inventoryNotionalUsdc: Number(this.inventoryNotionalUsdc().toFixed(4)),
                    collateral: {
                        balanceRaw: this.collateral.balanceRaw.toString(),
                        allowanceRaw: this.collateral.allowanceRaw.toString(),
                        updatedAt: this.collateral.updatedAt || null,
                        lastError: this.collateral.lastError,
                    },
                },
                "Engine status",
            );
        }, this.statusEveryMs);

        this.bookPollTimer = setInterval(() => {
            void this.refreshBooksFromRest();
        }, 10_000);

        this.positionPollTimer = setInterval(() => {
            void this.refreshPositionFromDataApi();
        }, this.positionPollMs);

        void this.refreshPositionFromDataApi();
    }

    stop() {
        if (this.statusTimer) clearInterval(this.statusTimer);
        this.statusTimer = null;
        if (this.bookPollTimer) clearInterval(this.bookPollTimer);
        this.bookPollTimer = null;
        if (this.positionPollTimer) clearInterval(this.positionPollTimer);
        this.positionPollTimer = null;
    }

    onReconnect() {
        this.state.reconnects += 1;
    }

    onUserMessage(msg: unknown) {
        this.state.userMessages += 1;
        this.applyInventoryUpdateFromUserMessage(msg);
    }

    onMarketMessage(msg: unknown) {
        this.state.marketMessages += 1;
        const events = Array.isArray(msg) ? msg : [msg];
        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const payload: any = event;
            let parsed = false;

            const tokenId = String(payload.asset_id ?? payload.assetId ?? payload.token_id ?? payload.tokenId ?? "");
            const hasBookArrays =
                Array.isArray(payload.bids)
                || Array.isArray(payload.asks)
                || Array.isArray(payload.buys)
                || Array.isArray(payload.sells);
            if (tokenId && this.tokenIds.includes(tokenId) && hasBookArrays) {
                const { bid, ask } = bestBidAsk(payload.bids ?? payload.buys, payload.asks ?? payload.sells);
                this.books.set(tokenId, { bid, ask, updatedAt: Date.now() });
                this.state.parsedBookUpdates += 1;
                parsed = true;
                continue;
            }

            const changes = Array.isArray(payload.price_changes) ? payload.price_changes : [];
            for (const ch of changes) {
                const changeTokenId = String(ch?.asset_id ?? "");
                if (!changeTokenId || !this.tokenIds.includes(changeTokenId)) continue;
                const bestBid = toNumber(ch?.best_bid);
                const bestAsk = toNumber(ch?.best_ask);
                const current = this.books.get(changeTokenId);
                this.books.set(changeTokenId, {
                    bid: bestBid ?? current?.bid ?? null,
                    ask: bestAsk ?? current?.ask ?? null,
                    updatedAt: Date.now(),
                });
                this.state.parsedBookUpdates += 1;
                parsed = true;
            }

            if (payload.event_type === "best_bid_ask") {
                const bbaTokenId = String(payload.asset_id ?? "");
                if (!bbaTokenId || !this.tokenIds.includes(bbaTokenId)) continue;
                const bestBid = toNumber(payload.best_bid);
                const bestAsk = toNumber(payload.best_ask);
                const current = this.books.get(bbaTokenId);
                this.books.set(bbaTokenId, {
                    bid: bestBid ?? current?.bid ?? null,
                    ask: bestAsk ?? current?.ask ?? null,
                    updatedAt: Date.now(),
                });
                this.state.parsedBookUpdates += 1;
                parsed = true;
            }

            if (!parsed) {
                this.state.ignoredMarketMessages += 1;
                if (this.state.ignoredMarketMessages <= 5) {
                    logger.info(
                        {
                            keys: Object.keys(payload),
                            eventType: payload.event_type ?? null,
                            market: payload.market ?? null,
                        },
                        "Ignored market message shape",
                    );
                }
            }
        }

        void this.maybeQuote();
    }

    updateSpotSignal(snapshot: {
        spotMoveBps: number | null;
        updatedAt: number | null;
        connected: boolean;
    }) {
        this.spotMoveBps = snapshot.spotMoveBps;
        this.spotUpdatedAt = snapshot.updatedAt;
        this.spotConnected = snapshot.connected;
    }

    private currentFairYes(): number | null {
        const yes = this.books.get(this.yesTokenId);
        const no = this.books.get(this.noTokenId);
        if (!yes || !no) return null;
        if (yes.bid === null || yes.ask === null || no.bid === null || no.ask === null) return null;
        const yesMid = (yes.bid + yes.ask) / 2;
        const noMid = (no.bid + no.ask) / 2;
        return clampPrice((yesMid + (1 - noMid)) / 2);
    }

    private quoteFromFair(fairYes: number, skew: number): { bid: number; ask: number; skew: number } {
        const rawBid = clampToTickBounds(fairYes - this.halfSpread + skew, this.tickSize);
        const rawAsk = clampToTickBounds(fairYes + this.halfSpread + skew, this.tickSize);

        let bid = roundDownToTick(rawBid, this.tickSize);
        let ask = roundUpToTick(rawAsk, this.tickSize);

        bid = clampToTickBounds(bid, this.tickSize);
        ask = clampToTickBounds(ask, this.tickSize);

        if (ask <= bid) {
            ask = clampToTickBounds(bid + this.tickSize, this.tickSize);
        }

        return {
            bid: Number(bid.toFixed(4)),
            ask: Number(ask.toFixed(4)),
            skew: Number(skew.toFixed(4)),
        };
    }

    private computeLagDecision(fairYes: number, secondsToEnd: number | null): {
        lagSkew: number;
        lagBps: number | null;
        lagMode: "bullish_yes" | "bearish_yes" | "neutral";
        buyMult: number;
        sellMult: number;
        reason: string;
    } {
        if (!this.lagArbEnabled) {
            this.lagRegime = 0;
            return { lagSkew: 0, lagBps: null, lagMode: "neutral", buyMult: 1, sellMult: 1, reason: "disabled" };
        }
        if (secondsToEnd !== null && secondsToEnd <= this.lagDisableBeforeEndSec) {
            this.lagRegime = 0;
            return { lagSkew: 0, lagBps: null, lagMode: "neutral", buyMult: 1, sellMult: 1, reason: "near_market_end" };
        }
        if (!this.spotConnected || this.spotMoveBps === null || !this.spotUpdatedAt) {
            this.lagRegime = 0;
            return { lagSkew: 0, lagBps: null, lagMode: "neutral", buyMult: 1, sellMult: 1, reason: "spot_unavailable" };
        }
        if (Date.now() - this.spotUpdatedAt > this.lagStaleMs) {
            this.lagRegime = 0;
            return { lagSkew: 0, lagBps: null, lagMode: "neutral", buyMult: 1, sellMult: 1, reason: "spot_stale" };
        }

        const polyImpliedMoveBps = ((fairYes - 0.5) / this.signalK) * 10000;
        const lagBps = this.spotMoveBps - polyImpliedMoveBps;

        if (lagBps >= this.lagEnterBps) this.lagRegime = 1;
        else if (lagBps <= -this.lagEnterBps) this.lagRegime = -1;
        else if (this.lagRegime === 1 && lagBps <= this.lagExitBps) this.lagRegime = 0;
        else if (this.lagRegime === -1 && lagBps >= -this.lagExitBps) this.lagRegime = 0;

        if (this.lagRegime === 0) {
            return { lagSkew: 0, lagBps, lagMode: "neutral", buyMult: 1, sellMult: 1, reason: "inside_hysteresis" };
        }

        const amplitude = Math.min(1, Math.max(0, (Math.abs(lagBps) - this.lagExitBps) / Math.max(1, this.lagEnterBps)));
        const lagSkew = this.lagMaxSkew * amplitude * this.lagRegime;
        return {
            lagSkew,
            lagBps,
            lagMode: this.lagRegime > 0 ? "bullish_yes" : "bearish_yes",
            buyMult: this.lagRegime > 0 ? this.lagSizeMult : 1,
            sellMult: this.lagRegime < 0 ? this.lagSizeMult : 1,
            reason: "active",
        };
    }

    private shouldRequote(nextBid: number, nextAsk: number) {
        const now = Date.now();
        if (this.state.lastPlacedBid === null || this.state.lastPlacedAsk === null) return true;
        if (now - this.state.lastQuoteAt < this.minRequoteMs) return false;
        if (now - this.state.lastQuoteAt >= this.forceRequoteMs) return true;
        const bidTicks = Math.abs(nextBid - this.state.lastPlacedBid) / this.tickSize;
        const askTicks = Math.abs(nextAsk - this.state.lastPlacedAsk) / this.tickSize;
        return bidTicks >= this.requoteTickThreshold || askTicks >= this.requoteTickThreshold;
    }

    private normalizeOrderSize(size: number, price: number, isBuy: boolean): number {
        if (!Number.isFinite(size) || size <= 0) return 0;
        const normalized = Math.floor(size * 100) / 100;
        if (normalized < this.minOrderSize) return 0;
        if (isBuy && normalized * price < this.minBuyNotionalUsdc) return 0;
        return normalized;
    }

    private async maybeQuote() {
        if (this.inFlight) return;
        const fairYes = this.currentFairYes();
        if (fairYes === null) return;
        this.state.quoteCycles += 1;

        const secondsToEnd = this.secondsToMarketEnd();
        if (
            secondsToEnd !== null
            && this.cancelAllBeforeEndSec > 0
            && secondsToEnd <= this.cancelAllBeforeEndSec
        ) {
            const now = Date.now();
            if (now - this.lastCancelAllAt >= 3000) {
                this.lastCancelAllAt = now;
                await this.cancelAllYesOrders();
                logger.info(
                    { marketId: this.marketId, secondsToEnd, cancelAllBeforeEndSec: this.cancelAllBeforeEndSec },
                    "Canceled all orders near market end",
                );
            }
            return;
        }
        if (
            secondsToEnd !== null
            && this.noNewOrdersBeforeEndSec > 0
            && secondsToEnd <= this.noNewOrdersBeforeEndSec
        ) {
            return;
        }

        const lag = this.computeLagDecision(fairYes, secondsToEnd);
        const next = this.quoteFromFair(fairYes, lag.lagSkew);
        if (!this.shouldRequote(next.bid, next.ask)) return;

        this.inFlight = true;
        try {
            const currentPos = this.state.currentYesPosition;
            const remainingByPosition = Math.max(0, this.maxPosition - currentPos);
            const remainingNotional = Math.max(0, this.maxInventoryNotionalUsdc - this.inventoryNotionalUsdc());
            const remainingByNotional = next.bid > 0 ? remainingNotional / next.bid : 0;

            let buySize = Math.max(0, Math.min(this.orderSize * lag.buyMult, remainingByPosition, remainingByNotional));
            let sellSize = Math.max(0, Math.min(this.orderSize * lag.sellMult, currentPos));

            const profitableExit = this.takeProfitSignal();
            let effectiveBid = next.bid;
            let effectiveAsk = next.ask;
            let dustRecoveryShortSell = false;

            if (profitableExit.active) {
                buySize = 0;
                effectiveAsk = profitableExit.exitPrice;
                // On take-profit, prioritize flattening inventory quickly.
                sellSize = Math.max(0, currentPos);
                // Dust recovery: if inventory is positive but below venue min size,
                // optionally send a minimum-size TP exit (can transiently go short).
                if (
                    this.allowShortSell
                    && this.dustRecoveryEnabled
                    && currentPos > 0
                    && currentPos < this.minOrderSize
                ) {
                    sellSize = this.minOrderSize;
                    dustRecoveryShortSell = true;
                }
            }

            // Avoid creating unsellable "dust" below min order size on non-TP exits.
            if (!this.allowShortSell && !profitableExit.active) {
                const remainder = Math.max(0, currentPos - sellSize);
                if (remainder > 0 && remainder < this.minOrderSize && currentPos >= this.minOrderSize) {
                    sellSize = currentPos;
                }
            }

            buySize = this.normalizeOrderSize(buySize, effectiveBid, true);
            sellSize = this.normalizeOrderSize(sellSize, effectiveAsk, false);

            if (this.dryRun || !this.tradingEnabled || !this.clobClient) {
                this.lastQuote = {
                    at: Date.now(),
                    fairYes,
                    bid: next.bid,
                    ask: next.ask,
                    skew: next.skew,
                    lagSkew: lag.lagSkew,
                    lagBps: lag.lagBps,
                    lagMode: lag.lagMode,
                    inventory: this.state.currentYesPosition,
                    mode: "dry_run",
                };
                logger.info(
                    {
                        marketId: this.marketId,
                        yesTokenId: this.yesTokenId,
                        fairYes,
                        quote: { bid: effectiveBid, ask: effectiveAsk, skew: next.skew },
                        lag: {
                            enabled: this.lagArbEnabled,
                            mode: lag.lagMode,
                            bps: lag.lagBps,
                            skew: lag.lagSkew,
                            reason: lag.reason,
                        },
                        orderSize: this.orderSize,
                        buySize,
                        sellSize,
                        tradingEnabled: this.tradingEnabled,
                        inventory: this.state.currentYesPosition,
                        takeProfitEnabled: this.takeProfitEnabled,
                        takeProfitActive: profitableExit.active,
                        takeProfitReason: profitableExit.reason,
                    },
                    this.tradingEnabled ? "DRY_RUN quote decision" : "TRADING_DISABLED quote decision",
                );
            } else {
                await this.cancelAllYesOrders();

                await this.refreshCollateral();
                const availableRaw = this.collateral.balanceRaw < this.collateral.allowanceRaw
                    ? this.collateral.balanceRaw
                    : this.collateral.allowanceRaw;

                let buyPlaced = false;
                let sellPlaced = false;
                let buySkippedReason: string | null = null;
                let sellSkippedReason: string | null = null;

                if (buySize > 0) {
                    const requiredBuyRaw = BigInt(Math.ceil(effectiveBid * buySize * 1_000_000));
                    if (availableRaw >= requiredBuyRaw) {
                        await this.clobClient.createAndPostOrder(
                            {
                                tokenID: this.yesTokenId,
                                side: Side.BUY,
                                size: buySize,
                                price: effectiveBid,
                            },
                            { tickSize: String(this.tickSize) as any },
                            OrderType.GTC,
                        );
                        buyPlaced = true;
                        this.state.buyOrdersPlaced += 1;
                    } else {
                        buySkippedReason = "insufficient_collateral";
                        this.state.skippedInsufficientCollateral += 1;
                        const now = Date.now();
                        if (now - this.lastInsufficientCollateralLogAt > 5000) {
                            logger.warn(
                                {
                                    requiredBuyRaw: requiredBuyRaw.toString(),
                                    availableRaw: availableRaw.toString(),
                                    skippedCount: this.state.skippedInsufficientCollateral,
                                },
                                "Skipping BUY quote: insufficient collateral/allowance",
                            );
                            this.lastInsufficientCollateralLogAt = now;
                        }
                    }
                } else {
                    buySkippedReason = "size_below_constraints_or_risk_cap";
                }

                if (sellSize > 0) {
                    await this.clobClient.createAndPostOrder(
                        {
                            tokenID: this.yesTokenId,
                            side: Side.SELL,
                            size: sellSize,
                            price: effectiveAsk,
                        },
                        { tickSize: String(this.tickSize) as any },
                        OrderType.GTC,
                    );
                    sellPlaced = true;
                    this.state.sellOrdersPlaced += 1;
                } else {
                    if (profitableExit.active && currentPos > 0 && currentPos < this.minOrderSize) {
                        sellSkippedReason = "tp_inventory_below_min_order_size";
                    } else {
                        sellSkippedReason = "insufficient_yes_inventory";
                    }
                }

                this.lastQuote = {
                    at: Date.now(),
                    fairYes,
                    bid: next.bid,
                    ask: next.ask,
                    skew: next.skew,
                    lagSkew: lag.lagSkew,
                    lagBps: lag.lagBps,
                    lagMode: lag.lagMode,
                    inventory: this.state.currentYesPosition,
                    mode: "live",
                };
                logger.info(
                    {
                        yesTokenId: this.yesTokenId,
                        fairYes,
                        quote: { bid: effectiveBid, ask: effectiveAsk, skew: next.skew },
                        lag: {
                            enabled: this.lagArbEnabled,
                            mode: lag.lagMode,
                            bps: lag.lagBps,
                            skew: lag.lagSkew,
                            reason: lag.reason,
                        },
                        orderSize: this.orderSize,
                        buySize,
                        sellSize,
                        inventory: this.state.currentYesPosition,
                        buyPlaced,
                        sellPlaced,
                        takeProfitEnabled: this.takeProfitEnabled,
                        takeProfitActive: profitableExit.active,
                        takeProfitReason: profitableExit.reason,
                        dustRecoveryShortSell,
                        buySkippedReason,
                        sellSkippedReason,
                    },
                    "Posted YES quote orders",
                );
            }

            this.state.lastPlacedBid = next.bid;
            this.state.lastPlacedAsk = next.ask;
            this.state.lastQuoteAt = Date.now();
        } catch (err) {
            this.state.orderErrors += 1;
            logger.error({ err }, "Quote cycle failed");
        } finally {
            this.inFlight = false;
        }
    }

    private applyInventoryUpdateFromUserMessage(msg: unknown) {
        const events = Array.isArray(msg) ? msg : [msg];
        let absolute: number | null = null;

        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const e: any = event;
            const tokenId = String(e.asset_id ?? e.assetId ?? e.token_id ?? e.tokenId ?? "");
            if (tokenId && tokenId !== this.yesTokenId) continue;

            const absValue =
                toNumber(e.position)
                ?? toNumber(e.current_position)
                ?? toNumber(e.net_position)
                ?? null;
            if (absValue !== null && tokenId === this.yesTokenId) {
                absolute = absValue;
            }
        }

        if (absolute !== null) {
            this.state.currentYesPosition = absolute;
        }

        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const e: any = event;
            const tokenId = String(e.asset_id ?? e.assetId ?? e.token_id ?? e.tokenId ?? "");
            if (tokenId && tokenId !== this.yesTokenId) continue;
            const side = String(e.side ?? "").toUpperCase();
            const price = toNumber(e.price);
            const size = toNumber(e.size) ?? toNumber(e.matched_size) ?? toNumber(e.amount);
            const eventType = String(e.event_type ?? e.type ?? "").toLowerCase();
            const isFillLike =
                eventType.includes("trade")
                || eventType.includes("fill")
                || eventType.includes("match");
            if (!isFillLike || price === null || size === null || size <= 0) continue;
            if (side !== "BUY" && side !== "SELL") continue;
            this.onFill(side as "BUY" | "SELL", size, price);
        }
    }

    private resolveMakerAddress(): string | null {
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

    private async refreshPositionFromDataApi() {
        if (!this.tradingEnabled) return;
        if (!this.makerAddress || !this.yesTokenId) return;
        try {
            const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(this.makerAddress)}&sizeThreshold=0`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`positions HTTP ${res.status}`);
            const rows = (await res.json()) as PositionRow[];
            if (!Array.isArray(rows)) return;

            const yesToken = String(this.yesTokenId);
            let size = 0;
            let avg = 0;
            for (const row of rows) {
                if (String(row?.asset ?? "") !== yesToken) continue;
                size = toNumber(row?.size) ?? 0;
                avg = toNumber(row?.avgPrice) ?? 0;
                break;
            }

            this.state.currentYesPosition = size;
            this.avgEntryPriceYes = size > 0 && avg > 0 ? avg : 0;
        } catch (err) {
            const now = Date.now();
            if (now - this.lastPositionPollErrorAt > 15000) {
                logger.warn(
                    {
                        err: err instanceof Error ? err.message : String(err),
                        makerAddress: this.makerAddress,
                    },
                    "Position poll failed",
                );
                this.lastPositionPollErrorAt = now;
            }
        } finally {
            void this.maybeQuote();
        }
    }

    private async refreshBooksFromRest() {
        const tokens = [this.yesTokenId, this.noTokenId].filter(Boolean);
        for (const tokenId of tokens) {
            try {
                const res = await fetch(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
                if (!res.ok) continue;
                const body = (await res.json()) as any;
                const { bid, ask } = bestBidAsk(body?.bids, body?.asks);
                if (bid === null && ask === null) continue;
                this.books.set(tokenId, { bid, ask, updatedAt: Date.now() });
                this.state.parsedBookUpdates += 1;
            } catch {
                // best effort
            }
        }
        void this.maybeQuote();
    }

    private async refreshCollateral() {
        if (!this.clobClient) return;
        if (Date.now() - this.collateral.updatedAt < this.collateralRefreshMs) return;
        try {
            const res = await this.clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
            this.collateral.balanceRaw = BigInt(String((res as any)?.balance ?? "0"));
            this.collateral.allowanceRaw = parseRawAllowance(res);
            this.collateral.updatedAt = Date.now();
            this.collateral.lastError = null;

            if (this.collateral.allowanceRaw === 0n) {
                const now = Date.now();
                if (now - this.lastAllowanceSyncAttemptAt > 60000) {
                    this.lastAllowanceSyncAttemptAt = now;
                    try {
                        await this.clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" as any });
                    } catch (err) {
                        this.collateral.lastError = err instanceof Error ? err.message : String(err);
                    }
                }
            }
        } catch (err) {
            this.collateral.lastError = err instanceof Error ? err.message : String(err);
        }
    }

    private onFill(side: "BUY" | "SELL", size: number, price: number) {
        this.state.fills += 1;
        this.lastFill = { at: Date.now(), tokenId: this.yesTokenId, side, size, price };

        if (side === "BUY") {
            const pos = this.state.currentYesPosition;
            const nextPos = pos + size;
            if (nextPos > 0) {
                this.avgEntryPriceYes = ((this.avgEntryPriceYes * pos) + (price * size)) / nextPos;
            }
            this.state.currentYesPosition = nextPos;
            return;
        }

        const pos = this.state.currentYesPosition;
        const closed = Math.min(Math.max(pos, 0), size);
        if (closed > 0) {
            this.realizedPnlYes += (price - this.avgEntryPriceYes) * closed;
        }
        const nextPos = pos - size;
        this.state.currentYesPosition = nextPos;
        if (nextPos <= 0) {
            this.avgEntryPriceYes = 0;
        }
    }

    private unrealizedPnlYes() {
        const fair = this.currentFairYes();
        if (fair === null) return 0;
        if (this.state.currentYesPosition <= 0) return 0;
        return (fair - this.avgEntryPriceYes) * this.state.currentYesPosition;
    }

    private inventoryNotionalUsdc() {
        if (this.state.currentYesPosition <= 0) return 0;
        return this.state.currentYesPosition * this.avgEntryPriceYes;
    }

    private takeProfitSignal(): { active: boolean; exitPrice: number; reason: string } {
        if (!this.takeProfitEnabled) return { active: false, exitPrice: 0, reason: "disabled" };
        if (this.state.currentYesPosition <= 0) return { active: false, exitPrice: 0, reason: "no_inventory" };
        const yes = this.books.get(this.yesTokenId);
        const bestBid = yes?.bid ?? null;
        if (bestBid === null || this.avgEntryPriceYes <= 0) return { active: false, exitPrice: 0, reason: "missing_bid_or_entry" };
        const target = this.avgEntryPriceYes * (1 + this.takeProfitPct);
        if (bestBid < target) return { active: false, exitPrice: 0, reason: "target_not_reached" };
        const exitPrice = clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
        return { active: true, exitPrice, reason: "triggered" };
    }

    private secondsToMarketEnd(): number | null {
        if (!this.marketEndUnixSec || !Number.isFinite(this.marketEndUnixSec)) return null;
        return Math.floor(this.marketEndUnixSec - Date.now() / 1000);
    }

    private async cancelAllYesOrders() {
        if (!this.clobClient) return;
        const open = await this.clobClient.getOpenOrders({ asset_id: this.yesTokenId });
        const orderIds = Array.isArray(open) ? open.map((o: any) => String(o.id)).filter(Boolean) : [];
        if (orderIds.length > 0) {
            await this.clobClient.cancelOrders(orderIds);
        }
    }

    getSnapshot() {
        const yes = this.books.get(this.yesTokenId);
        const no = this.books.get(this.noTokenId);
        return {
            marketId: this.marketId,
            yesTokenId: this.yesTokenId,
            noTokenId: this.noTokenId,
            yesTop: yes ? { bid: yes.bid, ask: yes.ask, updatedAt: yes.updatedAt } : null,
            noTop: no ? { bid: no.bid, ask: no.ask, updatedAt: no.updatedAt } : null,
            lastPlaced: {
                bid: this.state.lastPlacedBid,
                ask: this.state.lastPlacedAsk,
                at: this.state.lastQuoteAt || null,
            },
            lastQuote: this.lastQuote,
            currentYesPosition: this.state.currentYesPosition,
            counters: {
                reconnects: this.state.reconnects,
                marketMessages: this.state.marketMessages,
                userMessages: this.state.userMessages,
                parsedBookUpdates: this.state.parsedBookUpdates,
                ignoredMarketMessages: this.state.ignoredMarketMessages,
                quoteCycles: this.state.quoteCycles,
                skippedInsufficientCollateral: this.state.skippedInsufficientCollateral,
                orderErrors: this.state.orderErrors,
                buyOrdersPlaced: this.state.buyOrdersPlaced,
                sellOrdersPlaced: this.state.sellOrdersPlaced,
                fills: this.state.fills,
            },
            pnl: {
                realizedYes: Number(this.realizedPnlYes.toFixed(4)),
                unrealizedYes: Number(this.unrealizedPnlYes().toFixed(4)),
                netYes: Number((this.realizedPnlYes + this.unrealizedPnlYes()).toFixed(4)),
                avgEntryPriceYes: Number(this.avgEntryPriceYes.toFixed(6)),
                inventoryNotionalUsdc: Number(this.inventoryNotionalUsdc().toFixed(4)),
                lastFill: this.lastFill,
            },
            collateral: {
                balanceRaw: this.collateral.balanceRaw.toString(),
                allowanceRaw: this.collateral.allowanceRaw.toString(),
                updatedAt: this.collateral.updatedAt || null,
                lastError: this.collateral.lastError,
            },
            dryRun: this.dryRun,
            tradingEnabled: this.tradingEnabled,
            lagArb: {
                enabled: this.lagArbEnabled,
                regime: this.lagRegime,
                spotMoveBps: this.spotMoveBps,
                spotUpdatedAt: this.spotUpdatedAt,
                spotConnected: this.spotConnected,
                enterBps: this.lagEnterBps,
                exitBps: this.lagExitBps,
                maxSkew: this.lagMaxSkew,
                sizeMult: this.lagSizeMult,
            },
        };
    }
}
