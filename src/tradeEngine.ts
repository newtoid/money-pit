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
    lastPlacedNoBid: number | null;
    lastPlacedNoAsk: number | null;
    lastQuoteAt: number;
    reconnects: number;
    marketMessages: number;
    userMessages: number;
    parsedBookUpdates: number;
    ignoredMarketMessages: number;
    currentYesPosition: number;
    currentNoPosition: number;
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
    clobClient: ClobClient | null;
    dryRun: boolean;
    tradingEnabled: boolean;
};

type LastQuote = {
    at: number;
    fairYes: number;
    yes: { bid: number; ask: number; skew: number };
    no: { bid: number; ask: number; skew: number };
    inventory: { yes: number; no: number };
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
            } catch {}
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
    private readonly inventoryTarget = getEnvNumber("INVENTORY_TARGET", 0);
    private readonly inventorySkewMax = Math.max(0, getEnvNumber("INVENTORY_SKEW_MAX", 0));
    private readonly inventorySkewStart = Math.min(0.99, Math.max(0, getEnvNumber("INVENTORY_SKEW_START", 0.3)));
    private readonly requoteTickThreshold = getEnvInt("REQUOTE_TICK_THRESHOLD", 1);
    private readonly minRequoteMs = getEnvInt("MIN_REQUOTE_MS", 4000);
    private readonly forceRequoteMs = Math.max(this.minRequoteMs, getEnvInt("FORCE_REQUOTE_MS", 15000));
    private readonly statusEveryMs = getEnvInt("STATUS_EVERY_MS", 30000);
    private readonly positionPollMs = Math.max(3000, getEnvInt("POSITION_POLL_MS", 8000));
    private readonly allowShortSell = env.ALLOW_SHORT_SELL;
    private readonly collateralRefreshMs = getEnvInt("COLLATERAL_REFRESH_MS", 20000);
    private readonly maxInventoryNotionalUsdc = env.MAX_INVENTORY_NOTIONAL_USDC;
    private readonly takeProfitEnabled = env.TAKE_PROFIT_ENABLED;
    private readonly takeProfitPct = env.TAKE_PROFIT_PCT;
    private readonly minOrderSize = Math.max(0, getEnvNumber("MIN_ORDER_SIZE", 5));
    private readonly minBuyNotionalUsdc = Math.max(0, getEnvNumber("MIN_BUY_NOTIONAL_USDC", 1));

    private readonly books = new Map<string, TopOfBook>();
    private readonly state: QuoteState = {
        lastPlacedBid: null,
        lastPlacedAsk: null,
        lastPlacedNoBid: null,
        lastPlacedNoAsk: null,
        lastQuoteAt: 0,
        reconnects: 0,
        marketMessages: 0,
        userMessages: 0,
        parsedBookUpdates: 0,
        ignoredMarketMessages: 0,
        currentYesPosition: 0,
        currentNoPosition: 0,
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
    private avgEntryPriceNo = 0;
    private realizedPnlYes = 0;
    private realizedPnlNo = 0;
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
    private readonly makerAddress: string | null;

    constructor(opts: EngineOpts) {
        this.marketId = opts.marketId;
        this.tokenIds = opts.tokenIds;
        this.yesTokenId = this.tokenIds[0] ?? "";
        this.noTokenId = this.tokenIds[1] ?? "";
        this.clobClient = opts.clobClient;
        this.dryRun = opts.dryRun;
        this.tradingEnabled = opts.tradingEnabled;
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
                        yesBid: this.state.lastPlacedBid,
                        yesAsk: this.state.lastPlacedAsk,
                        noBid: this.state.lastPlacedNoBid,
                        noAsk: this.state.lastPlacedNoAsk,
                        at: this.state.lastQuoteAt || null,
                    },
                    dryRun: this.dryRun,
            marketMessages: this.state.marketMessages,
                    userMessages: this.state.userMessages,
                    reconnects: this.state.reconnects,
                    parsedBookUpdates: this.state.parsedBookUpdates,
                    ignoredMarketMessages: this.state.ignoredMarketMessages,
                    currentYesPosition: this.state.currentYesPosition,
                    currentNoPosition: this.state.currentNoPosition,
                    quoteCycles: this.state.quoteCycles,
                    skippedInsufficientCollateral: this.state.skippedInsufficientCollateral,
                    orderErrors: this.state.orderErrors,
                    buyOrdersPlaced: this.state.buyOrdersPlaced,
                    sellOrdersPlaced: this.state.sellOrdersPlaced,
                    fills: this.state.fills,
                    realizedPnlYes: Number(this.realizedPnlYes.toFixed(4)),
                    realizedPnlNo: Number(this.realizedPnlNo.toFixed(4)),
                    unrealizedPnlYes: Number(this.unrealizedPnlYes().toFixed(4)),
                    unrealizedPnlNo: Number(this.unrealizedPnlNo().toFixed(4)),
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

    onUserMessage(_msg: unknown) {
        this.state.userMessages += 1;
        this.applyInventoryUpdateFromUserMessage(_msg);
    }

    onMarketMessage(msg: unknown) {
        this.state.marketMessages += 1;
        const events = Array.isArray(msg) ? msg : [msg];
        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const payload: any = event;
            let parsed = false;

            // Snapshot-style book messages.
            const tokenId = String(payload.asset_id ?? payload.assetId ?? payload.token_id ?? payload.tokenId ?? "");
            const hasBookArrays =
                Array.isArray(payload.bids)
                || Array.isArray(payload.asks)
                || Array.isArray(payload.buys)
                || Array.isArray(payload.sells);
            if (tokenId && this.tokenIds.includes(tokenId) && hasBookArrays) {
                const { bid, ask } = bestBidAsk(
                    payload.bids ?? payload.buys,
                    payload.asks ?? payload.sells,
                );
                this.books.set(tokenId, {
                    bid,
                    ask,
                    updatedAt: Date.now(),
                });
                this.state.parsedBookUpdates += 1;
                parsed = true;
                continue;
            }

            // Incremental book update messages.
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

            // Lightweight best bid/ask message.
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

    private currentFairYes(): number | null {
        const yes = this.books.get(this.yesTokenId);
        const no = this.books.get(this.noTokenId);
        if (!yes || !no) return null;
        if (yes.bid === null || yes.ask === null || no.bid === null || no.ask === null) return null;
        const yesMid = (yes.bid + yes.ask) / 2;
        const noMid = (no.bid + no.ask) / 2;
        // Complement-consistent fair value.
        return clampPrice((yesMid + (1 - noMid)) / 2);
    }

    private quoteFromFair(fairValue: number, inventory: number): { bid: number; ask: number; skew: number } {
        const skew = this.computeInventorySkew(inventory);
        const min = this.tickSize;
        const max = 1 - this.tickSize;
        const rawBid = clampToTickBounds(fairValue - this.halfSpread - skew, this.tickSize);
        const rawAsk = clampToTickBounds(fairValue + this.halfSpread - skew, this.tickSize);

        let bid = roundDownToTick(rawBid, this.tickSize);
        let ask = roundUpToTick(rawAsk, this.tickSize);

        bid = clampToTickBounds(bid, this.tickSize);
        ask = clampToTickBounds(ask, this.tickSize);

        if (ask <= bid) {
            if (bid + this.tickSize <= max) {
                ask = bid + this.tickSize;
            } else if (ask - this.tickSize >= min) {
                bid = ask - this.tickSize;
            } else {
                bid = min;
                ask = Math.min(max, min + this.tickSize);
            }
        }

        return {
            bid: Number(clampToTickBounds(bid, this.tickSize).toFixed(4)),
            ask: Number(clampToTickBounds(ask, this.tickSize).toFixed(4)),
            skew: Number(skew.toFixed(6)),
        };
    }

    private shouldRequote(next: {
        yesBid: number; yesAsk: number; noBid: number; noAsk: number;
    }) {
        const now = Date.now();
        if (
            this.state.lastPlacedBid === null
            || this.state.lastPlacedAsk === null
            || this.state.lastPlacedNoBid === null
            || this.state.lastPlacedNoAsk === null
        ) return true;
        if (now - this.state.lastQuoteAt < this.minRequoteMs) return false;
        if (now - this.state.lastQuoteAt >= this.forceRequoteMs) return true;
        const yesBidTicks = Math.abs(next.yesBid - this.state.lastPlacedBid) / this.tickSize;
        const yesAskTicks = Math.abs(next.yesAsk - this.state.lastPlacedAsk) / this.tickSize;
        const noBidTicks = Math.abs(next.noBid - this.state.lastPlacedNoBid) / this.tickSize;
        const noAskTicks = Math.abs(next.noAsk - this.state.lastPlacedNoAsk) / this.tickSize;
        return (
            yesBidTicks >= this.requoteTickThreshold
            || yesAskTicks >= this.requoteTickThreshold
            || noBidTicks >= this.requoteTickThreshold
            || noAskTicks >= this.requoteTickThreshold
        );
    }

    private async maybeQuote() {
        if (this.inFlight) return;
        const fairYes = this.currentFairYes();
        if (fairYes === null) return;
        this.state.quoteCycles += 1;

        const nextYes = this.quoteFromFair(fairYes, this.state.currentYesPosition);
        const nextNo = this.quoteFromFair(1 - fairYes, this.state.currentNoPosition);
        if (!this.shouldRequote({
            yesBid: nextYes.bid,
            yesAsk: nextYes.ask,
            noBid: nextNo.bid,
            noAsk: nextNo.ask,
        })) return;

        this.inFlight = true;
        try {
            const currentYes = this.state.currentYesPosition;
            const currentNo = this.state.currentNoPosition;

            let remainingNotional = Math.max(0, this.maxInventoryNotionalUsdc - this.inventoryNotionalUsdc());
            const yesRemainingByPosition = Math.max(0, this.maxPosition - currentYes);
            const noRemainingByPosition = Math.max(0, this.maxPosition - currentNo);
            let buyYesSize = Math.max(0, Math.min(this.orderSize, yesRemainingByPosition, nextYes.bid > 0 ? remainingNotional / nextYes.bid : 0));
            remainingNotional = Math.max(0, remainingNotional - (buyYesSize * nextYes.bid));
            let buyNoSize = Math.max(0, Math.min(this.orderSize, noRemainingByPosition, nextNo.bid > 0 ? remainingNotional / nextNo.bid : 0));

            let sellYesSize = this.allowShortSell ? this.orderSize : Math.max(0, Math.min(this.orderSize, currentYes));
            let sellNoSize = this.allowShortSell ? this.orderSize : Math.max(0, Math.min(this.orderSize, currentNo));

            const yesTakeProfit = this.takeProfitSignal(this.yesTokenId, currentYes, this.avgEntryPriceYes);
            const noTakeProfit = this.takeProfitSignal(this.noTokenId, currentNo, this.avgEntryPriceNo);

            let effectiveYesBid = nextYes.bid;
            let effectiveYesAsk = nextYes.ask;
            let effectiveNoBid = nextNo.bid;
            let effectiveNoAsk = nextNo.ask;

            if (yesTakeProfit.active) {
                buyYesSize = 0;
                effectiveYesAsk = yesTakeProfit.exitPrice;
            }
            if (noTakeProfit.active) {
                buyNoSize = 0;
                effectiveNoAsk = noTakeProfit.exitPrice;
            }
            buyYesSize = this.normalizeOrderSize(buyYesSize, effectiveYesBid, true);
            buyNoSize = this.normalizeOrderSize(buyNoSize, effectiveNoBid, true);
            sellYesSize = this.normalizeOrderSize(sellYesSize, effectiveYesAsk, false);
            sellNoSize = this.normalizeOrderSize(sellNoSize, effectiveNoAsk, false);

            if (this.dryRun || !this.tradingEnabled || !this.clobClient) {
                this.lastQuote = {
                    at: Date.now(),
                    fairYes,
                    yes: { bid: nextYes.bid, ask: nextYes.ask, skew: nextYes.skew },
                    no: { bid: nextNo.bid, ask: nextNo.ask, skew: nextNo.skew },
                    inventory: { yes: currentYes, no: currentNo },
                    mode: "dry_run",
                };
                logger.info(
                    {
                        marketId: this.marketId,
                        yesTokenId: this.yesTokenId,
                        noTokenId: this.noTokenId,
                        fairYes,
                        yesQuote: { bid: effectiveYesBid, ask: effectiveYesAsk, skew: nextYes.skew },
                        noQuote: { bid: effectiveNoBid, ask: effectiveNoAsk, skew: nextNo.skew },
                        orderSize: this.orderSize,
                        buyYesSize,
                        sellYesSize,
                        buyNoSize,
                        sellNoSize,
                        tradingEnabled: this.tradingEnabled,
                        inventory: { yes: currentYes, no: currentNo },
                        takeProfitActive: { yes: yesTakeProfit.active, no: noTakeProfit.active },
                    },
                    this.tradingEnabled ? "DRY_RUN quote decision" : "TRADING_DISABLED quote decision",
                );
            } else {
                const yesOpen = await this.clobClient.getOpenOrders({ asset_id: this.yesTokenId });
                const noOpen = await this.clobClient.getOpenOrders({ asset_id: this.noTokenId });
                const orderIds = [
                    ...(Array.isArray(yesOpen) ? yesOpen : []),
                    ...(Array.isArray(noOpen) ? noOpen : []),
                ].map((o: any) => String(o.id)).filter(Boolean);
                if (orderIds.length > 0) {
                    await this.clobClient.cancelOrders(orderIds);
                    logger.info({ count: orderIds.length }, "Canceled stale YES/NO orders");
                }

                await this.refreshCollateral();
                let availableRaw = this.collateral.balanceRaw < this.collateral.allowanceRaw
                    ? this.collateral.balanceRaw
                    : this.collateral.allowanceRaw;

                const placeBuy = async (tokenID: string, size: number, price: number) => {
                    if (size <= 0) return { placed: false, reason: "size_zero" };
                    const requiredBuyRaw = BigInt(Math.ceil(size * price * 1_000_000));
                    if (availableRaw < requiredBuyRaw) {
                        this.state.skippedInsufficientCollateral += 1;
                        return { placed: false, reason: "insufficient_collateral", requiredBuyRaw };
                    }
                    await this.clobClient!.createAndPostOrder(
                        { tokenID, side: Side.BUY, size, price },
                        { tickSize: String(this.tickSize) as any },
                        OrderType.GTC,
                    );
                    availableRaw -= requiredBuyRaw;
                    this.state.buyOrdersPlaced += 1;
                    return { placed: true as const };
                };
                const placeSell = async (tokenID: string, size: number, price: number) => {
                    if (size <= 0) return { placed: false, reason: "size_zero" };
                    await this.clobClient!.createAndPostOrder(
                        { tokenID, side: Side.SELL, size, price },
                        { tickSize: String(this.tickSize) as any },
                        OrderType.GTC,
                    );
                    this.state.sellOrdersPlaced += 1;
                    return { placed: true as const };
                };

                const yesBuyResult = await placeBuy(this.yesTokenId, buyYesSize, effectiveYesBid);
                const yesSellResult = await placeSell(this.yesTokenId, sellYesSize, effectiveYesAsk);
                const noBuyResult = await placeBuy(this.noTokenId, buyNoSize, effectiveNoBid);
                const noSellResult = await placeSell(this.noTokenId, sellNoSize, effectiveNoAsk);

                this.lastQuote = {
                    at: Date.now(),
                    fairYes,
                    yes: { bid: nextYes.bid, ask: nextYes.ask, skew: nextYes.skew },
                    no: { bid: nextNo.bid, ask: nextNo.ask, skew: nextNo.skew },
                    inventory: { yes: currentYes, no: currentNo },
                    mode: "live",
                };
                logger.info(
                    {
                        yesTokenId: this.yesTokenId,
                        noTokenId: this.noTokenId,
                        fairYes,
                        yesQuote: { bid: effectiveYesBid, ask: effectiveYesAsk, skew: nextYes.skew },
                        noQuote: { bid: effectiveNoBid, ask: effectiveNoAsk, skew: nextNo.skew },
                        orderSize: this.orderSize,
                        buyYesSize,
                        sellYesSize,
                        buyNoSize,
                        sellNoSize,
                        inventory: { yes: currentYes, no: currentNo },
                        yesBuyPlaced: yesBuyResult.placed,
                        yesSellPlaced: yesSellResult.placed,
                        noBuyPlaced: noBuyResult.placed,
                        noSellPlaced: noSellResult.placed,
                        takeProfitActive: { yes: yesTakeProfit.active, no: noTakeProfit.active },
                    },
                    "Posted YES/NO quote orders",
                );
            }

            this.state.lastPlacedBid = nextYes.bid;
            this.state.lastPlacedAsk = nextYes.ask;
            this.state.lastPlacedNoBid = nextNo.bid;
            this.state.lastPlacedNoAsk = nextNo.ask;
            this.state.lastQuoteAt = Date.now();
        } catch (err) {
            this.state.orderErrors += 1;
            logger.error({ err }, "Quote cycle failed");
        } finally {
            this.inFlight = false;
        }
    }

    private normalizeOrderSize(size: number, price: number, isBuy: boolean): number {
        if (!Number.isFinite(size) || size <= 0) return 0;
        let normalized = Math.floor(size * 100) / 100;
        if (normalized < this.minOrderSize) return 0;
        if (isBuy && normalized * price < this.minBuyNotionalUsdc) return 0;
        return normalized;
    }

    private computeInventorySkew(position: number): number {
        const inv = position - this.inventoryTarget;
        const invNorm = Math.max(-1, Math.min(1, inv / this.maxPosition));
        const excess = Math.max(0, Math.abs(invNorm) - this.inventorySkewStart) / (1 - this.inventorySkewStart);
        const skew = this.inventorySkewMax * excess * Math.sign(invNorm);
        return Number.isFinite(skew) ? skew : 0;
    }

    private applyInventoryUpdateFromUserMessage(msg: unknown) {
        const events = Array.isArray(msg) ? msg : [msg];
        let yesAbsolute: number | null = null;
        let noAbsolute: number | null = null;

        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const e: any = event;
            const tokenId = String(e.asset_id ?? e.assetId ?? e.token_id ?? e.tokenId ?? "");
            if (tokenId && tokenId !== this.yesTokenId && tokenId !== this.noTokenId) continue;

            const absValue =
                toNumber(e.position)
                ?? toNumber(e.current_position)
                ?? toNumber(e.net_position)
                ?? null;
            if (absValue !== null && tokenId === this.yesTokenId) {
                yesAbsolute = absValue;
                continue;
            }
            if (absValue !== null && tokenId === this.noTokenId) {
                noAbsolute = absValue;
                continue;
            }

        }

        const beforeYes = this.state.currentYesPosition;
        const beforeNo = this.state.currentNoPosition;
        if (yesAbsolute !== null) this.state.currentYesPosition = yesAbsolute;
        if (noAbsolute !== null) this.state.currentNoPosition = noAbsolute;

        if (this.state.currentYesPosition !== beforeYes || this.state.currentNoPosition !== beforeNo) {
            logger.info(
                {
                    before: { yes: beforeYes, no: beforeNo },
                    after: { yes: this.state.currentYesPosition, no: this.state.currentNoPosition },
                    skew: {
                        yes: this.computeInventorySkew(this.state.currentYesPosition),
                        no: this.computeInventorySkew(this.state.currentNoPosition),
                    },
                },
                "Inventory updated",
            );
        }

        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const e: any = event;
            const tokenId = String(e.asset_id ?? e.assetId ?? e.token_id ?? e.tokenId ?? "");
            if (tokenId !== this.yesTokenId && tokenId !== this.noTokenId) continue;
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
            this.onFill(tokenId, side as "BUY" | "SELL", size, price);
        }
    }

    private resolveMakerAddress(): string | null {
        if (env.TRADING_USE_SIGNER_AS_MAKER) {
            const pk = process.env.PRIVATE_KEY?.trim();
            if (pk) {
                try {
                    return new Wallet(pk).address;
                } catch {
                    return null;
                }
            }
            return null;
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
            if (!res.ok) {
                throw new Error(`positions HTTP ${res.status}`);
            }
            const rows = (await res.json()) as PositionRow[];
            if (!Array.isArray(rows)) return;

            const yesToken = String(this.yesTokenId);
            const noToken = String(this.noTokenId);
            let yesSize = 0;
            let yesAvg = 0;
            let noSize = 0;
            let noAvg = 0;
            for (const row of rows) {
                const asset = String(row?.asset ?? "");
                if (asset === yesToken) {
                    yesSize = toNumber(row?.size) ?? 0;
                    yesAvg = toNumber(row?.avgPrice) ?? 0;
                } else if (asset === noToken) {
                    noSize = toNumber(row?.size) ?? 0;
                    noAvg = toNumber(row?.avgPrice) ?? 0;
                }
            }

            const beforeYes = this.state.currentYesPosition;
            const beforeNo = this.state.currentNoPosition;
            this.state.currentYesPosition = yesSize;
            this.state.currentNoPosition = noSize;
            this.avgEntryPriceYes = yesSize > 0 && yesAvg > 0 ? yesAvg : 0;
            this.avgEntryPriceNo = noSize > 0 && noAvg > 0 ? noAvg : 0;

            if (beforeYes !== this.state.currentYesPosition || beforeNo !== this.state.currentNoPosition) {
                logger.info(
                    {
                        before: { yes: beforeYes, no: beforeNo },
                        after: { yes: this.state.currentYesPosition, no: this.state.currentNoPosition },
                        avgEntryPriceYes: Number(this.avgEntryPriceYes.toFixed(6)),
                        avgEntryPriceNo: Number(this.avgEntryPriceNo.toFixed(6)),
                        source: "data_api",
                        makerAddress: this.makerAddress,
                    },
                    "Inventory updated",
                );
            }
        } catch (err) {
            const now = Date.now();
            if (now - this.lastPositionPollErrorAt > 15_000) {
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
                this.books.set(tokenId, {
                    bid,
                    ask,
                    updatedAt: Date.now(),
                });
                this.state.parsedBookUpdates += 1;
            } catch {
                // best-effort fallback; websocket still primary source.
            }
        }
        void this.maybeQuote();
    }

    private async refreshCollateral() {
        if (!this.clobClient) return;
        if (Date.now() - this.collateral.updatedAt < this.collateralRefreshMs) return;
        try {
            const res = await this.clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
            const bal = BigInt(String((res as any)?.balance ?? "0"));
            const alw = parseRawAllowance(res);
            this.collateral.balanceRaw = bal;
            this.collateral.allowanceRaw = alw;
            this.collateral.updatedAt = Date.now();
            this.collateral.lastError = null;

            // If allowance is still zero, attempt a periodic sync/approval refresh.
            if (this.collateral.allowanceRaw === 0n) {
                const now = Date.now();
                if (now - this.lastAllowanceSyncAttemptAt > 60_000) {
                    this.lastAllowanceSyncAttemptAt = now;
                    try {
                        await this.clobClient.updateBalanceAllowance({ asset_type: "COLLATERAL" as any });
                        const retry = await this.clobClient.getBalanceAllowance({ asset_type: "COLLATERAL" as any });
                        this.collateral.balanceRaw = BigInt(String((retry as any)?.balance ?? "0"));
                        this.collateral.allowanceRaw = parseRawAllowance(retry);
                        this.collateral.updatedAt = Date.now();
                        logger.info(
                            {
                                balanceRaw: this.collateral.balanceRaw.toString(),
                                allowanceRaw: this.collateral.allowanceRaw.toString(),
                            },
                            "Collateral allowance sync attempted",
                        );
                    } catch (err) {
                        this.collateral.lastError = err instanceof Error ? err.message : String(err);
                    }
                }
            }
        } catch (err) {
            this.collateral.lastError = err instanceof Error ? err.message : String(err);
        }
    }

    private async canAffordBuy(requiredRaw: bigint): Promise<{ ok: boolean; availableRaw?: bigint; reason?: string }> {
        await this.refreshCollateral();
        if (this.collateral.lastError) {
            return { ok: false, reason: this.collateral.lastError };
        }
        const available = this.collateral.balanceRaw < this.collateral.allowanceRaw
            ? this.collateral.balanceRaw
            : this.collateral.allowanceRaw;
        return {
            ok: available >= requiredRaw,
            availableRaw: available,
            reason: available >= requiredRaw ? undefined : "balance_or_allowance_below_required",
        };
    }

    private onFill(tokenId: string, side: "BUY" | "SELL", size: number, price: number) {
        this.state.fills += 1;
        this.lastFill = { at: Date.now(), tokenId, side, size, price };
        const isYes = tokenId === this.yesTokenId;
        const pos = isYes ? this.state.currentYesPosition : this.state.currentNoPosition;
        const avgEntry = isYes ? this.avgEntryPriceYes : this.avgEntryPriceNo;

        if (side === "BUY") {
            const nextPos = pos + size;
            if (nextPos > 0) {
                const nextAvg = ((avgEntry * pos) + (price * size)) / nextPos;
                if (isYes) this.avgEntryPriceYes = nextAvg;
                else this.avgEntryPriceNo = nextAvg;
            }
            if (isYes) this.state.currentYesPosition = nextPos;
            else this.state.currentNoPosition = nextPos;
            return;
        }

        const closed = Math.min(Math.max(pos, 0), size);
        if (closed > 0) {
            const pnl = (price - avgEntry) * closed;
            if (isYes) this.realizedPnlYes += pnl;
            else this.realizedPnlNo += pnl;
        }
        const nextPos = pos - size;
        if (isYes) this.state.currentYesPosition = nextPos;
        else this.state.currentNoPosition = nextPos;
        if (nextPos <= 0) {
            if (isYes) this.avgEntryPriceYes = 0;
            else this.avgEntryPriceNo = 0;
        }
    }

    private unrealizedPnlYes() {
        const fair = this.currentFairYes();
        if (fair === null) return 0;
        if (this.state.currentYesPosition <= 0) return 0;
        return (fair - this.avgEntryPriceYes) * this.state.currentYesPosition;
    }

    private unrealizedPnlNo() {
        const fair = this.currentFairYes();
        if (fair === null) return 0;
        if (this.state.currentNoPosition <= 0) return 0;
        const fairNo = 1 - fair;
        return (fairNo - this.avgEntryPriceNo) * this.state.currentNoPosition;
    }

    private inventoryNotionalUsdc() {
        const yesNotional = this.state.currentYesPosition > 0 ? this.state.currentYesPosition * this.avgEntryPriceYes : 0;
        const noNotional = this.state.currentNoPosition > 0 ? this.state.currentNoPosition * this.avgEntryPriceNo : 0;
        return yesNotional + noNotional;
    }

    private takeProfitSignal(
        tokenId: string,
        position: number,
        avgEntryPrice: number,
    ): { active: boolean; exitPrice: number } {
        if (!this.takeProfitEnabled) return { active: false, exitPrice: 0 };
        if (position <= 0) return { active: false, exitPrice: 0 };
        const book = this.books.get(tokenId);
        const bestBid = book?.bid ?? null;
        if (bestBid === null || avgEntryPrice <= 0) return { active: false, exitPrice: 0 };
        const target = avgEntryPrice * (1 + this.takeProfitPct);
        if (bestBid < target) return { active: false, exitPrice: 0 };
        const exitPrice = clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
        return { active: true, exitPrice };
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
                yesBid: this.state.lastPlacedBid,
                yesAsk: this.state.lastPlacedAsk,
                noBid: this.state.lastPlacedNoBid,
                noAsk: this.state.lastPlacedNoAsk,
                at: this.state.lastQuoteAt || null,
            },
            lastQuote: this.lastQuote,
            currentYesPosition: this.state.currentYesPosition,
            currentNoPosition: this.state.currentNoPosition,
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
                realizedNo: Number(this.realizedPnlNo.toFixed(4)),
                unrealizedNo: Number(this.unrealizedPnlNo().toFixed(4)),
                netNo: Number((this.realizedPnlNo + this.unrealizedPnlNo()).toFixed(4)),
                avgEntryPriceYes: Number(this.avgEntryPriceYes.toFixed(6)),
                avgEntryPriceNo: Number(this.avgEntryPriceNo.toFixed(6)),
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
        };
    }
}
