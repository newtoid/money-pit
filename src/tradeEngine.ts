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
    currentNoPosition: number;
    quoteCycles: number;
    skippedInsufficientCollateral: number;
    orderErrors: number;
    buyOrdersPlaced: number;
    sellOrdersPlaced: number;
    fills: number;
    entryCount: number;
    completedRoundTrips: number;
    winningRoundTrips: number;
    losingRoundTrips: number;
};

type EngineOpts = {
    marketId: string;
    tokenIds: string[];
    marketStartUnixSec?: number | null;
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
    private readonly configuredTradingEnabled: boolean;

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
    private readonly hardTakeProfitPct = Math.max(0, getEnvNumber("HARD_TAKE_PROFIT_PCT", 0.5));
    private readonly minOrderSize = Math.max(0, getEnvNumber("MIN_ORDER_SIZE", 5));
    private readonly minBuyNotionalUsdc = Math.max(0, getEnvNumber("MIN_BUY_NOTIONAL_USDC", 1));
    private readonly dustRecoveryEnabled = getEnvBool("DUST_RECOVERY_ENABLED", true);
    private readonly noNewOrdersBeforeEndSec = Math.max(0, getEnvInt("NO_NEW_ORDERS_BEFORE_END", 30));
    private readonly cancelAllBeforeEndSec = Math.max(0, getEnvInt("CANCEL_ALL_BEFORE_END", 15));
    private readonly lagArbEnabled = getEnvBool("LAG_ARB_ENABLED", true);
    private readonly lagTradeMode: "bullish_only" | "bearish_only" | "both" = (() => {
        const raw = String(process.env.LAG_TRADE_MODE ?? "both").trim().toLowerCase();
        if (raw === "bullish_only" || raw === "bearish_only" || raw === "both") return raw;
        return "both";
    })();
    private readonly lagEnterBps = Math.max(0, getEnvNumber("LAG_ENTER_BPS", 4));
    private readonly lagExitBps = Math.max(0, getEnvNumber("LAG_EXIT_BPS", 2));
    private readonly lagMaxSkew = Math.max(0, getEnvNumber("MAX_LAG_SKEW", 0.01));
    private readonly lagSizeMult = Math.max(1, getEnvNumber("LAG_SIZE_MULT", 1.25));
    private readonly lagStaleMs = Math.max(500, getEnvInt("LAG_STALE_MS", 2500));
    private readonly lagDisableBeforeEndSec = Math.max(0, getEnvInt("LAG_DISABLE_BEFORE_END_SEC", 35));
    private readonly signalK = Math.max(1, getEnvNumber("SIGNAL_K", 60));
    private readonly buyWindowSec = Math.max(0, getEnvInt("BUY_WINDOW_SEC", 180));
    private readonly buyMinLagBps = Math.max(0, getEnvNumber("BUY_MIN_LAG_BPS", 6));
    private readonly entryEstimatedRoundTripCostBps = Math.max(0, getEnvNumber("ENTRY_ESTIMATED_ROUNDTRIP_COST_BPS", 12));
    private readonly entryExtraEdgeBufferBps = Math.max(0, getEnvNumber("ENTRY_EXTRA_EDGE_BUFFER_BPS", 2));
    private readonly entryMaxYesSpreadBps = Math.max(0, getEnvNumber("ENTRY_MAX_YES_SPREAD_BPS", 80));
    private readonly entryMaxYesSpreadTicks = Math.max(0, getEnvNumber("ENTRY_MAX_YES_SPREAD_TICKS", 0));
    private readonly spreadTickEpsilon = 1e-9;
    private readonly buyNoChaseWindowMs = Math.max(0, getEnvInt("BUY_NO_CHASE_WINDOW_MS", 4000));
    private readonly buyNoChaseMaxUpBps = Math.max(0, getEnvNumber("BUY_NO_CHASE_MAX_UP_BPS", 8));
    private readonly exitLayeredEnabled = getEnvBool("EXIT_LAYERED_ENABLED", true);
    private readonly exitAggressivePct = Math.max(0, Math.min(0.95, getEnvNumber("EXIT_AGGRESSIVE_PCT", 0.35)));
    private readonly exitAggressiveTicks = Math.max(0, getEnvInt("EXIT_AGGRESSIVE_TICKS", 1));
    private readonly exitFastUndercutTicks = Math.max(0, getEnvInt("EXIT_FAST_UNDERCUT_TICKS", 1));
    private readonly exitMinProfitTicks = Math.max(0, getEnvInt("EXIT_MIN_PROFIT_TICKS", 1));
    private readonly exitCatchupBufferBps = Math.max(0, getEnvNumber("EXIT_CATCHUP_BUFFER_BPS", 0));
    private readonly exitAllowProfitBeforeCatchup = getEnvBool("EXIT_ALLOW_PROFIT_BEFORE_CATCHUP", true);
    private readonly exitForceAfterHoldSec = Math.max(0, getEnvInt("EXIT_FORCE_AFTER_HOLD_SEC", 20));
    private readonly exitFailsafeAfterFails = Math.max(1, getEnvInt("EXIT_FAILSAFE_AFTER_FAILS", 3));
    private readonly exitFailsafeExtraTicks = Math.max(0, getEnvInt("EXIT_FAILSAFE_EXTRA_TICKS", 1));
    private readonly exitUseMarketOnSignal = getEnvBool("EXIT_USE_MARKET_ON_SIGNAL", true);
    private readonly maxLossPerMarketUsdc = Math.max(0, getEnvNumber("MAX_LOSS_PER_MARKET_USDC", 0));
    private readonly clobLedgerMinIntervalMs = Math.max(0, getEnvInt("CLOB_LEDGER_MIN_INTERVAL_MS", 1000));
    private readonly cancelAllMinIntervalMs = Math.max(0, getEnvInt("CANCEL_ALL_MIN_INTERVAL_MS", 1200));
    private readonly openOrdersRateLimitBackoffMs = Math.max(1000, getEnvInt("OPEN_ORDERS_RATE_LIMIT_BACKOFF_MS", 12000));
    private readonly decisionLogMinMs = Math.max(0, getEnvInt("DECISION_LOG_MIN_MS", 15000));
    private readonly forceFlattenEnabled = getEnvBool("FORCE_FLATTEN_ENABLED", true);
    private readonly forceFlattenBeforeEndSec = Math.max(0, getEnvInt("FORCE_FLATTEN_BEFORE_END_SEC", 40));
    private readonly forceFlattenHardDeadlineSec = Math.max(0, getEnvInt("FORCE_FLATTEN_HARD_DEADLINE_SEC", 5));
    private readonly forceFlattenAllowLoss = getEnvBool("FORCE_FLATTEN_ALLOW_LOSS", false);
    private readonly forceFlattenMode: "protect_price" | "guarantee_flat" = (
        String(process.env.FORCE_FLATTEN_MODE ?? "protect_price").trim().toLowerCase() === "guarantee_flat"
            ? "guarantee_flat"
            : "protect_price"
    );
    private readonly sessionMaxConsecutiveLosses = Math.max(0, getEnvInt("SESSION_MAX_CONSECUTIVE_LOSSES", 3));
    private readonly sessionMaxNetLossUsdc = Math.max(0, getEnvNumber("SESSION_MAX_NET_LOSS_USDC", 10));
    private readonly estimatedFeeBps = Math.max(0, getEnvNumber("ESTIMATED_FEE_BPS", 100));
    private readonly rollingExpectancyWindow = Math.max(1, getEnvInt("ROLLING_EXPECTANCY_WINDOW", 20));
    private readonly rollingExpectancyPauseBelowUsdc = getEnvNumber("ROLLING_EXPECTANCY_PAUSE_BELOW_USDC", -0.05);
    private readonly rollingExpectancyReduceSizeBelowUsdc = getEnvNumber("ROLLING_EXPECTANCY_REDUCE_SIZE_BELOW_USDC", 0);
    private readonly rollingExpectancyReduceSizeMult = Math.max(0.1, Math.min(1, getEnvNumber("ROLLING_EXPECTANCY_REDUCE_SIZE_MULT", 0.5)));
    private readonly venueMinOrderSize = Math.max(5, getEnvNumber("VENUE_MIN_ORDER_SIZE", 5));

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
        currentNoPosition: 0,
        quoteCycles: 0,
        skippedInsufficientCollateral: 0,
        orderErrors: 0,
        buyOrdersPlaced: 0,
        sellOrdersPlaced: 0,
        fills: 0,
        entryCount: 0,
        completedRoundTrips: 0,
        winningRoundTrips: 0,
        losingRoundTrips: 0,
    };

    private statusTimer: NodeJS.Timeout | null = null;
    private bookPollTimer: NodeJS.Timeout | null = null;
    private positionPollTimer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private lastQuote: LastQuote = null;
    private avgEntryPriceYes = 0;
    private avgEntryPriceNo = 0;
    private entrySpotMoveTargetBps: number | null = null;
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
    private lastOpenOrdersFetchAt = 0;
    private lastCancelAllCallAt = 0;
    private openOrdersRateLimitedUntil = 0;
    private openYesOrdersCache: any[] = [];
    private lastForceFlattenSyncWarnAt = 0;
    private lastForceFlattenLogAt = 0;
    private readonly lastDecisionLogAt = new Map<string, number>();
    private readonly lastDecisionLogFingerprint = new Map<string, string>();
    private readonly makerAddress: string | null;
    private readonly marketStartUnixSec: number | null;
    private readonly marketEndUnixSec: number | null;
    private spotMoveBps: number | null = null;
    private spotUpdatedAt: number | null = null;
    private spotConnected = false;
    private lagRegime: -1 | 0 | 1 = 0;
    private fairHistory: Array<{ at: number; fairYes: number }> = [];
    private lastLagBpsDecision: number | null = null;
    private activePositionOpenedAt: number | null = null;
    private realizedPnlAtPositionOpen = 0;
    private holdMsAccumulated = 0;
    private sumEntryLagBps = 0;
    private consecutiveExitFailures = 0;
    private consecutiveLosingRoundTrips = 0;
    private sessionNetAfterFeesUsdc = 0;
    private recentCycleNetAfterFeesUsdc: number[] = [];
    private lastCycleNetAfterFeesUsdc: number | null = null;
    private activeCycleBuyNotionalUsdc = 0;
    private activeCycleSellNotionalUsdc = 0;
    private runtimeTradingEnabled: boolean;

    constructor(opts: EngineOpts) {
        this.marketId = opts.marketId;
        this.tokenIds = opts.tokenIds;
        this.yesTokenId = this.tokenIds[0] ?? "";
        this.noTokenId = this.tokenIds[1] ?? "";
        this.clobClient = opts.clobClient;
        this.dryRun = opts.dryRun;
        this.configuredTradingEnabled = opts.tradingEnabled;
        this.runtimeTradingEnabled = opts.tradingEnabled;
        this.marketStartUnixSec = opts.marketStartUnixSec ?? null;
        this.marketEndUnixSec = opts.marketEndUnixSec ?? null;
        this.makerAddress = this.resolveMakerAddress();
    }

    setTradingEnabled(enabled: boolean) {
        this.runtimeTradingEnabled = enabled;
        if (!enabled) {
            void this.cancelAllYesOrders().catch((err) => {
                logger.warn({ err, marketId: this.marketId }, "Cancel-all on trading disable failed");
            });
        }
        void this.maybeQuote();
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
        // Directional mode: only apply lag-driven skew/sizing when BTC leads Polymarket (bullish regime).
        const bullishRegime = this.lagRegime > 0 ? 1 : 0;
        const lagSkew = this.lagMaxSkew * amplitude * bullishRegime;
        return {
            lagSkew,
            lagBps,
            lagMode: this.lagRegime > 0 ? "bullish_yes" : "bearish_yes",
            buyMult: this.lagRegime > 0 ? this.lagSizeMult : 1,
            sellMult: 1,
            reason: this.lagRegime > 0 ? "active_bullish" : "bearish_ignored",
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

    private currentYesSpreadBps(): number | null {
        const yes = this.books.get(this.yesTokenId);
        if (!yes || yes.bid === null || yes.ask === null) return null;
        const mid = (yes.bid + yes.ask) / 2;
        if (!Number.isFinite(mid) || mid <= 0) return null;
        const spread = yes.ask - yes.bid;
        if (!Number.isFinite(spread) || spread < 0) return null;
        return (spread / mid) * 10000;
    }

    private currentYesSpreadTicks(): number | null {
        const yes = this.books.get(this.yesTokenId);
        if (!yes || yes.bid === null || yes.ask === null) return null;
        const spread = yes.ask - yes.bid;
        if (!Number.isFinite(spread) || spread < 0 || this.tickSize <= 0) return null;
        return spread / this.tickSize;
    }

    private currentNoSpreadBps(): number | null {
        const no = this.books.get(this.noTokenId);
        if (!no || no.bid === null || no.ask === null) return null;
        const mid = (no.bid + no.ask) / 2;
        if (!Number.isFinite(mid) || mid <= 0) return null;
        const spread = no.ask - no.bid;
        if (!Number.isFinite(spread) || spread < 0) return null;
        return (spread / mid) * 10000;
    }

    private currentNoSpreadTicks(): number | null {
        const no = this.books.get(this.noTokenId);
        if (!no || no.bid === null || no.ask === null) return null;
        const spread = no.ask - no.bid;
        if (!Number.isFinite(spread) || spread < 0 || this.tickSize <= 0) return null;
        return spread / this.tickSize;
    }

    private rollingAvgCycleNetAfterFeesUsdc(): number | null {
        if (this.recentCycleNetAfterFeesUsdc.length === 0) return null;
        const sum = this.recentCycleNetAfterFeesUsdc.reduce((acc, x) => acc + x, 0);
        return sum / this.recentCycleNetAfterFeesUsdc.length;
    }

    private entryRiskMode(): { pauseBuys: boolean; sizeMult: number; reason: string | null; rollingAvg: number | null } {
        if (this.sessionMaxConsecutiveLosses > 0 && this.consecutiveLosingRoundTrips >= this.sessionMaxConsecutiveLosses) {
            return { pauseBuys: true, sizeMult: 0, reason: "session_consecutive_losses_cap", rollingAvg: this.rollingAvgCycleNetAfterFeesUsdc() };
        }
        if (this.sessionMaxNetLossUsdc > 0 && this.sessionNetAfterFeesUsdc <= -this.sessionMaxNetLossUsdc) {
            return { pauseBuys: true, sizeMult: 0, reason: "session_net_loss_cap", rollingAvg: this.rollingAvgCycleNetAfterFeesUsdc() };
        }
        const rollingAvg = this.rollingAvgCycleNetAfterFeesUsdc();
        if (rollingAvg !== null && rollingAvg <= this.rollingExpectancyPauseBelowUsdc) {
            return { pauseBuys: true, sizeMult: 0, reason: "rolling_expectancy_pause", rollingAvg };
        }
        if (rollingAvg !== null && rollingAvg <= this.rollingExpectancyReduceSizeBelowUsdc) {
            return { pauseBuys: false, sizeMult: this.rollingExpectancyReduceSizeMult, reason: "rolling_expectancy_reduce_size", rollingAvg };
        }
        return { pauseBuys: false, sizeMult: 1, reason: null, rollingAvg };
    }

    private shouldLogDecision(channel: string, fingerprint: string): boolean {
        const now = Date.now();
        const lastAt = this.lastDecisionLogAt.get(channel) ?? 0;
        const lastFingerprint = this.lastDecisionLogFingerprint.get(channel) ?? "";
        if (this.decisionLogMinMs <= 0) {
            this.lastDecisionLogAt.set(channel, now);
            this.lastDecisionLogFingerprint.set(channel, fingerprint);
            return true;
        }
        if (fingerprint !== lastFingerprint || now - lastAt >= this.decisionLogMinMs) {
            this.lastDecisionLogAt.set(channel, now);
            this.lastDecisionLogFingerprint.set(channel, fingerprint);
            return true;
        }
        return false;
    }

    private normalizeOrderSize(size: number, price: number, isBuy: boolean): number {
        if (!Number.isFinite(size) || size <= 0) return 0;
        const normalized = Math.floor(size * 100) / 100;
        const minSize = Math.max(this.minOrderSize, this.venueMinOrderSize);
        if (normalized < minSize) return 0;
        if (isBuy && normalized * price < this.minBuyNotionalUsdc) return 0;
        return normalized;
    }

    private async maybeQuote() {
        if (this.inFlight) return;
        const fairYes = this.currentFairYes();
        if (fairYes === null) return;
        this.state.quoteCycles += 1;

        const secondsSinceStart = this.secondsSinceMarketStart();
        const buyWindowActive = secondsSinceStart !== null && secondsSinceStart >= 0 && secondsSinceStart <= this.buyWindowSec;
        this.pushFairSample(fairYes);

        const secondsToEnd = this.secondsToMarketEnd();

        if (
            secondsToEnd !== null
            && this.cancelAllBeforeEndSec > 0
            && secondsToEnd <= this.cancelAllBeforeEndSec
        ) {
            if (
                this.forceFlattenEnabled
                && this.forceFlattenBeforeEndSec > 0
                && this.state.currentYesPosition > 0
            ) {
                try {
                    await this.forceFlattenNearEnd(fairYes, secondsToEnd);
                } catch (err) {
                    this.state.orderErrors += 1;
                    logger.error({ err, marketId: this.marketId, secondsToEnd }, "Force flatten cycle failed");
                }
                return;
            }
            const now = Date.now();
            if (now - this.lastCancelAllAt >= 3000) {
                this.lastCancelAllAt = now;
                let canceled = false;
                try {
                    await this.cancelAllYesOrders();
                    canceled = true;
                } catch (err) {
                    this.state.orderErrors += 1;
                    logger.error({ err, marketId: this.marketId, secondsToEnd }, "Cancel-all near end failed");
                }
                if (canceled) {
                    logger.info(
                        { marketId: this.marketId, secondsToEnd, cancelAllBeforeEndSec: this.cancelAllBeforeEndSec },
                        "Canceled all orders near market end",
                    );
                }
            }
            return;
        }
        if (
            secondsToEnd !== null
            && this.forceFlattenEnabled
            && this.forceFlattenBeforeEndSec > 0
            && secondsToEnd <= this.forceFlattenBeforeEndSec
        ) {
            try {
                await this.forceFlattenNearEnd(fairYes, secondsToEnd);
            } catch (err) {
                this.state.orderErrors += 1;
                logger.error({ err, marketId: this.marketId, secondsToEnd }, "Force flatten cycle failed");
            }
            return;
        }

        const noNewOrdersWindowActive = (
            secondsToEnd !== null
            && this.noNewOrdersBeforeEndSec > 0
            && secondsToEnd <= this.noNewOrdersBeforeEndSec
        );

        const lag = this.computeLagDecision(fairYes, secondsToEnd);
        this.lastLagBpsDecision = lag.lagBps;

        const bearishModeEnabled = this.lagTradeMode === "both" || this.lagTradeMode === "bearish_only";
        const bullishModeEnabled = this.lagTradeMode === "both" || this.lagTradeMode === "bullish_only";
        if (
            bearishModeEnabled
            && (lag.lagMode === "bearish_yes" || this.state.currentNoPosition > 0)
            && this.state.currentYesPosition <= 0
        ) {
            await this.maybeQuoteBearishNo(fairYes, lag, secondsSinceStart, secondsToEnd, noNewOrdersWindowActive);
            return;
        }
        if (!bullishModeEnabled && this.state.currentYesPosition <= 0) {
            return;
        }

        const next = this.quoteFromFair(fairYes, lag.lagSkew);
        const immediateExit = this.hardTakeProfitSignal().active || this.priceRiseExitSignal().active || this.takeProfitSignal().active;
        if (!immediateExit && !this.shouldRequote(next.bid, next.ask)) return;

        this.inFlight = true;
        try {
            const currentPos = this.state.currentYesPosition;
            const riskMode = this.entryRiskMode();
            const remainingByPosition = Math.max(0, this.maxPosition - currentPos);
            const remainingNotional = Math.max(0, this.maxInventoryNotionalUsdc - this.inventoryNotionalUsdc());
            const remainingByNotional = next.bid > 0 ? remainingNotional / next.bid : 0;

            let buySize = Math.max(0, Math.min(this.orderSize * lag.buyMult * riskMode.sizeMult, remainingByPosition, remainingByNotional));
            let sellSize = 0;

            const hardTakeProfitExit = this.hardTakeProfitSignal();
            const profitableExit = this.takeProfitSignal();
            const bullishTracker = lag.lagMode === "bullish_yes";
            const risingPriceExit = this.priceRiseExitSignal();
            const exitSignal = hardTakeProfitExit.active
                ? hardTakeProfitExit
                : (risingPriceExit.active ? risingPriceExit : profitableExit);
            const noChase = this.buyNoChaseSignal(fairYes);
            const requiredLagBps = this.buyMinLagBps + this.entryEstimatedRoundTripCostBps + this.entryExtraEdgeBufferBps;
            const lagStrongEnough = lag.lagBps !== null && lag.lagBps >= requiredLagBps;
            const maxLossBreached = this.maxLossPerMarketUsdc > 0
                && (this.realizedPnlYes + this.unrealizedPnlYes()) <= -this.maxLossPerMarketUsdc;
            const yesSpreadBps = this.currentYesSpreadBps();
            const yesSpreadTicks = this.currentYesSpreadTicks();
            const spreadTooWideBps = this.entryMaxYesSpreadBps > 0 && yesSpreadBps !== null && yesSpreadBps > this.entryMaxYesSpreadBps;
            const spreadTooWideTicks = this.entryMaxYesSpreadTicks > 0
                && yesSpreadTicks !== null
                && yesSpreadTicks > (this.entryMaxYesSpreadTicks + this.spreadTickEpsilon);
            const spreadTooWide = spreadTooWideBps || spreadTooWideTicks;
            let effectiveBid = next.bid;
            let effectiveAsk = next.ask;
            let dustRecoveryShortSell = false;
            let buyGateReason: string | null = null;
            let exitFailsafeActive = false;

            if (!bullishTracker) {
                // Directional mode: only buy when BTC tracker leads Polymarket.
                buySize = 0;
                buyGateReason = "lag_not_bullish";
            }
            if (!buyWindowActive) {
                // Allow exits all market, but only open new buys inside BUY_WINDOW_SEC.
                buySize = 0;
                buyGateReason = "outside_buy_window";
            }
            if (noNewOrdersWindowActive) {
                buySize = 0;
                buyGateReason = "inside_no_new_orders_window";
            }
            if (!lagStrongEnough) {
                buySize = 0;
                buyGateReason = "lag_below_fee_adjusted_min";
            }
            if (spreadTooWide) {
                buySize = 0;
                buyGateReason = "spread_too_wide_for_entry";
            }
            if (noChase.active) {
                buySize = 0;
                buyGateReason = noChase.reason;
            }
            if (maxLossBreached) {
                buySize = 0;
                buyGateReason = "max_loss_per_market_breached";
            }
            if (riskMode.pauseBuys) {
                buySize = 0;
                buyGateReason = riskMode.reason;
            }

            if (exitSignal.active) {
                buySize = 0;
                effectiveAsk = exitSignal.exitPrice;
                exitFailsafeActive = this.consecutiveExitFailures >= this.exitFailsafeAfterFails;
                if (exitFailsafeActive && this.exitFailsafeExtraTicks > 0) {
                    effectiveAsk = clampToTickBounds(
                        roundDownToTick(
                            effectiveAsk - (this.exitFailsafeExtraTicks * this.tickSize),
                            this.tickSize,
                        ),
                        this.tickSize,
                    );
                }
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

            buySize = this.normalizeOrderSize(buySize, effectiveBid, true);
            sellSize = this.normalizeOrderSize(sellSize, effectiveAsk, false);

            if (this.dryRun || !this.runtimeTradingEnabled || !this.clobClient) {
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
                const decisionFingerprint = JSON.stringify({
                    mode: this.runtimeTradingEnabled ? "dry_run" : "trading_disabled",
                    lagMode: lag.lagMode,
                    buySize,
                    sellSize,
                    buyGateReason,
                    takeProfitActive: exitSignal.active,
                    takeProfitReason: exitSignal.reason,
                    noChase: noChase.reason,
                });
                if (this.shouldLogDecision("yes_quote_decision", decisionFingerprint)) {
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
                            feeAdjustedEntry: {
                                requiredLagBps,
                                estRoundTripCostBps: this.entryEstimatedRoundTripCostBps,
                                extraEdgeBufferBps: this.entryExtraEdgeBufferBps,
                                yesSpreadBps,
                                yesSpreadTicks,
                                maxYesSpreadBps: this.entryMaxYesSpreadBps,
                                maxYesSpreadTicks: this.entryMaxYesSpreadTicks,
                            },
                            riskMode: {
                                reason: riskMode.reason,
                                rollingAvgCycleNetAfterFeesUsdc: riskMode.rollingAvg,
                                sizeMult: riskMode.sizeMult,
                            },
                            orderSize: this.orderSize,
                            buySize,
                            sellSize,
                            buyGateReason,
                            noChaseJumpBps: noChase.jumpBps,
                            tradingEnabled: this.runtimeTradingEnabled,
                            inventory: this.state.currentYesPosition,
                            takeProfitEnabled: this.takeProfitEnabled,
                            hardTakeProfitPct: this.hardTakeProfitPct,
                            takeProfitActive: exitSignal.active,
                            takeProfitReason: exitSignal.reason,
                        },
                        this.runtimeTradingEnabled ? "DRY_RUN quote decision" : "TRADING_DISABLED quote decision",
                    );
                }
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
                    buySkippedReason = buyGateReason ?? "size_below_constraints_or_risk_cap";
                }

                if (sellSize > 0) {
                    const synced = await this.syncPositionFromDataApi(false);
                        const openRows = await this.fetchOpenYesOrdersRows();
                    const reservedShares = this.sumOpenSellReservedShares(openRows);
                    const confirmedPos = Math.max(0, this.state.currentYesPosition - reservedShares);
                    if (!synced) {
                        sellSkippedReason = "position_sync_failed_using_cached_position";
                    }
                    sellSize = Math.min(sellSize, confirmedPos);
                    sellSize = this.normalizeOrderSize(sellSize, effectiveAsk, false);

                    if (sellSize > 0) {
                        try {
                            if (exitSignal.active && this.exitUseMarketOnSignal) {
                                await this.clobClient.createAndPostMarketOrder(
                                    {
                                        tokenID: this.yesTokenId,
                                        side: Side.SELL,
                                        amount: sellSize,
                                    },
                                    { tickSize: String(this.tickSize) as any },
                                    OrderType.FAK as any,
                                );
                                sellPlaced = true;
                                this.state.sellOrdersPlaced += 1;
                            } else if (exitSignal.active && this.exitLayeredEnabled && sellSize >= (this.minOrderSize * 2)) {
                                const aggressiveRawPrice = clampToTickBounds(
                                    effectiveAsk - (this.exitAggressiveTicks * this.tickSize),
                                    this.tickSize,
                                );
                                const aggressivePrice = clampToTickBounds(roundDownToTick(aggressiveRawPrice, this.tickSize), this.tickSize);
                                let aggressiveSize = this.normalizeOrderSize(sellSize * this.exitAggressivePct, aggressivePrice, false);
                                if (aggressiveSize > sellSize) aggressiveSize = sellSize;
                                let passiveSize = this.normalizeOrderSize(sellSize - aggressiveSize, effectiveAsk, false);
                                if (aggressiveSize <= 0 || passiveSize <= 0) {
                                    aggressiveSize = 0;
                                    passiveSize = sellSize;
                                }

                                if (aggressiveSize > 0) {
                                    await this.clobClient.createAndPostOrder(
                                        {
                                            tokenID: this.yesTokenId,
                                            side: Side.SELL,
                                            size: aggressiveSize,
                                            price: aggressivePrice,
                                        },
                                        { tickSize: String(this.tickSize) as any },
                                        OrderType.GTC,
                                    );
                                    sellPlaced = true;
                                    this.state.sellOrdersPlaced += 1;
                                }

                                if (passiveSize > 0) {
                                    await this.clobClient.createAndPostOrder(
                                        {
                                            tokenID: this.yesTokenId,
                                            side: Side.SELL,
                                            size: passiveSize,
                                            price: effectiveAsk,
                                        },
                                        { tickSize: String(this.tickSize) as any },
                                        OrderType.GTC,
                                    );
                                    sellPlaced = true;
                                    this.state.sellOrdersPlaced += 1;
                                }
                            } else {
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
                            }
                        } catch (err) {
                            if (!this.isInsufficientBalanceOrAllowanceError(err)) {
                                this.state.orderErrors += 1;
                                sellSkippedReason = "sell_post_failed";
                                logger.error(
                                    {
                                        marketId: this.marketId,
                                        yesTokenId: this.yesTokenId,
                                        attemptedSellSize: sellSize,
                                        err: err instanceof Error ? err.message : String(err),
                                    },
                                    "SELL post failed",
                                );
                            } else {
                                logger.warn(
                                    {
                                        marketId: this.marketId,
                                        yesTokenId: this.yesTokenId,
                                        attemptedSellSize: sellSize,
                                        inventoryBeforeRetry: this.state.currentYesPosition,
                                        err: err instanceof Error ? err.message : String(err),
                                    },
                                    "SELL rejected for balance/allowance; retrying after cancel+resync",
                                );
                                try {
                                    await this.cancelAllYesOrders();
                                } catch {
                                    // best effort
                                }
                                await this.syncPositionFromDataApi(false);
                                const retryRows = await this.fetchOpenYesOrdersRows();
                                const retryReservedShares = this.sumOpenSellReservedShares(retryRows);
                                const retryFreePos = Math.max(0, this.state.currentYesPosition - retryReservedShares);
                                const retrySize = this.normalizeOrderSize(Math.min(sellSize, retryFreePos), effectiveAsk, false);
                                if (retrySize > 0) {
                                    if (exitSignal.active && this.exitUseMarketOnSignal) {
                                        await this.clobClient.createAndPostMarketOrder(
                                            {
                                                tokenID: this.yesTokenId,
                                                side: Side.SELL,
                                                amount: retrySize,
                                            },
                                            { tickSize: String(this.tickSize) as any },
                                            OrderType.FAK as any,
                                        );
                                    } else {
                                        await this.clobClient.createAndPostOrder(
                                            {
                                                tokenID: this.yesTokenId,
                                                side: Side.SELL,
                                                size: retrySize,
                                                price: effectiveAsk,
                                            },
                                            { tickSize: String(this.tickSize) as any },
                                            OrderType.GTC,
                                        );
                                    }
                                    sellPlaced = true;
                                    this.state.sellOrdersPlaced += 1;
                                    sellSize = retrySize;
                                } else {
                                    sellSkippedReason = "insufficient_yes_inventory_after_sync";
                                }
                            }
                        }
                    } else {
                        sellSkippedReason = "insufficient_yes_inventory_after_sync";
                    }

                    if (sellPlaced && exitSignal.active) {
                        this.consecutiveExitFailures = 0;
                    } else if (exitSignal.active && currentPos > 0) {
                        this.consecutiveExitFailures += 1;
                    }
                } else {
                    if (exitSignal.active && currentPos > 0 && currentPos < this.minOrderSize) {
                        sellSkippedReason = "tp_inventory_below_min_order_size";
                    } else if (currentPos > 0) {
                        sellSkippedReason = "waiting_for_price_rise_exit";
                    } else {
                        sellSkippedReason = "insufficient_yes_inventory";
                    }
                    if (exitSignal.active && currentPos > 0) {
                        this.consecutiveExitFailures += 1;
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
                        feeAdjustedEntry: {
                            requiredLagBps,
                            estRoundTripCostBps: this.entryEstimatedRoundTripCostBps,
                            extraEdgeBufferBps: this.entryExtraEdgeBufferBps,
                            yesSpreadBps,
                            yesSpreadTicks,
                            maxYesSpreadBps: this.entryMaxYesSpreadBps,
                            maxYesSpreadTicks: this.entryMaxYesSpreadTicks,
                        },
                        riskMode: {
                            reason: riskMode.reason,
                            rollingAvgCycleNetAfterFeesUsdc: riskMode.rollingAvg,
                            sizeMult: riskMode.sizeMult,
                        },
                        orderSize: this.orderSize,
                        buySize,
                        sellSize,
                        buyGateReason,
                        noChaseJumpBps: noChase.jumpBps,
                        consecutiveExitFailures: this.consecutiveExitFailures,
                        exitFailsafeAfterFails: this.exitFailsafeAfterFails,
                        inventory: this.state.currentYesPosition,
                        buyPlaced,
                        sellPlaced,
                        takeProfitEnabled: this.takeProfitEnabled,
                        takeProfitActive: exitSignal.active,
                        takeProfitReason: exitSignal.reason,
                        exitUseMarketOnSignal: this.exitUseMarketOnSignal,
                        exitFailsafeActive,
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
            if (immediateExit) this.consecutiveExitFailures += 1;
            logger.error({ err }, "Quote cycle failed");
        } finally {
            this.inFlight = false;
        }
    }

    private applyInventoryUpdateFromUserMessage(msg: unknown) {
        const events = Array.isArray(msg) ? msg : [msg];
        let absoluteYes: number | null = null;
        let absoluteNo: number | null = null;

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
                absoluteYes = absValue;
            }
            if (absValue !== null && tokenId === this.noTokenId) {
                absoluteNo = absValue;
            }
        }

        if (absoluteYes !== null) this.state.currentYesPosition = absoluteYes;
        if (absoluteNo !== null) this.state.currentNoPosition = absoluteNo;

        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const e: any = event;
            const tokenId = String(e.asset_id ?? e.assetId ?? e.token_id ?? e.tokenId ?? "");
            if (tokenId && tokenId !== this.yesTokenId && tokenId !== this.noTokenId) continue;
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
            if (tokenId === this.yesTokenId) {
                this.onFill(side as "BUY" | "SELL", size, price);
            } else if (tokenId === this.noTokenId) {
                this.onFillNo(side as "BUY" | "SELL", size, price);
            }
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

    private isInsufficientBalanceOrAllowanceError(err: unknown): boolean {
        const e: any = err as any;
        const msg = String(e?.message ?? "").toLowerCase();
        const dataMsg = String(e?.response?.data?.error ?? e?.response?.data ?? "").toLowerCase();
        return msg.includes("not enough balance / allowance") || dataMsg.includes("not enough balance / allowance");
    }

    private async syncPositionFromDataApi(triggerRequote: boolean): Promise<boolean> {
        if (!this.makerAddress || !this.yesTokenId) return false;
        try {
            const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(this.makerAddress)}&sizeThreshold=0`;
            const res = await fetch(url);
            if (!res.ok) {
                const now = Date.now();
                if (now - this.lastPositionPollErrorAt > 15000) {
                    logger.warn(
                        {
                            status: res.status,
                            makerAddress: this.makerAddress,
                        },
                        "Position poll failed (non-200)",
                    );
                    this.lastPositionPollErrorAt = now;
                }
                return false;
            }
            const rows = (await res.json()) as PositionRow[];
            if (!Array.isArray(rows)) return false;

            const yesToken = String(this.yesTokenId);
            const noToken = String(this.noTokenId);
            let size = 0;
            let avg = 0;
            let noSize = 0;
            let noAvg = 0;
            for (const row of rows) {
                const asset = String(row?.asset ?? "");
                if (asset === yesToken) {
                    size = toNumber(row?.size) ?? 0;
                    avg = toNumber(row?.avgPrice) ?? 0;
                } else if (asset === noToken) {
                    noSize = toNumber(row?.size) ?? 0;
                    noAvg = toNumber(row?.avgPrice) ?? 0;
                }
            }

            this.state.currentYesPosition = size;
            this.avgEntryPriceYes = size > 0 && avg > 0 ? avg : 0;
            this.state.currentNoPosition = noSize;
            this.avgEntryPriceNo = noSize > 0 && noAvg > 0 ? noAvg : 0;
            return true;
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
            return false;
        } finally {
            if (triggerRequote) void this.maybeQuote();
        }
        return false;
    }

    private async refreshPositionFromDataApi() {
        await this.syncPositionFromDataApi(true);
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
            this.activeCycleBuyNotionalUsdc += (size * price);
            const pos = this.state.currentYesPosition;
            const nextPos = pos + size;
            if (pos <= 0 && nextPos > 0) {
                this.state.entryCount += 1;
                this.activePositionOpenedAt = Date.now();
                this.realizedPnlAtPositionOpen = this.realizedPnlYes;
                if (this.lastLagBpsDecision !== null) this.sumEntryLagBps += this.lastLagBpsDecision;
            }
            if (nextPos > 0) {
                this.avgEntryPriceYes = ((this.avgEntryPriceYes * pos) + (price * size)) / nextPos;
                if (this.spotMoveBps !== null && Number.isFinite(this.spotMoveBps)) {
                    if (this.entrySpotMoveTargetBps === null || pos <= 0) {
                        this.entrySpotMoveTargetBps = this.spotMoveBps;
                    } else {
                        this.entrySpotMoveTargetBps =
                            ((this.entrySpotMoveTargetBps * pos) + (this.spotMoveBps * size)) / nextPos;
                    }
                }
            }
            this.state.currentYesPosition = nextPos;
            return;
        }

        const pos = this.state.currentYesPosition;
        this.activeCycleSellNotionalUsdc += (size * price);
        const closed = Math.min(Math.max(pos, 0), size);
        if (closed > 0) {
            this.realizedPnlYes += (price - this.avgEntryPriceYes) * closed;
        }
        const nextPos = pos - size;
        this.state.currentYesPosition = nextPos;
        if (nextPos <= 0) {
            if (pos > 0) {
                this.state.completedRoundTrips += 1;
                const cycleRealized = this.realizedPnlYes - this.realizedPnlAtPositionOpen;
                const cycleTurnover = this.activeCycleBuyNotionalUsdc + this.activeCycleSellNotionalUsdc;
                const cycleEstimatedFees = cycleTurnover * (this.estimatedFeeBps / 10000);
                const cycleNetAfterFees = cycleRealized - cycleEstimatedFees;
                this.pushCycleNetAfterFees(cycleNetAfterFees);
                if (cycleRealized > 0) this.state.winningRoundTrips += 1;
                else if (cycleRealized < 0) this.state.losingRoundTrips += 1;
                if (cycleNetAfterFees < 0) this.consecutiveLosingRoundTrips += 1;
                else this.consecutiveLosingRoundTrips = 0;
                if (this.activePositionOpenedAt) {
                    this.holdMsAccumulated += Math.max(0, Date.now() - this.activePositionOpenedAt);
                }
            }
            this.avgEntryPriceYes = 0;
            this.entrySpotMoveTargetBps = null;
            this.activeCycleBuyNotionalUsdc = 0;
            this.activeCycleSellNotionalUsdc = 0;
            this.activePositionOpenedAt = null;
            this.realizedPnlAtPositionOpen = this.realizedPnlYes;
        }
    }

    private onFillNo(side: "BUY" | "SELL", size: number, price: number) {
        if (side === "BUY") {
            const pos = this.state.currentNoPosition;
            const nextPos = pos + size;
            if (nextPos > 0) {
                this.avgEntryPriceNo = ((this.avgEntryPriceNo * pos) + (price * size)) / nextPos;
            }
            this.state.currentNoPosition = nextPos;
            return;
        }
        const nextPos = this.state.currentNoPosition - size;
        this.state.currentNoPosition = nextPos;
        if (nextPos <= 0) {
            this.avgEntryPriceNo = 0;
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

    private hardTakeProfitSignal(): { active: boolean; exitPrice: number; reason: string } {
        if (this.hardTakeProfitPct <= 0) return { active: false, exitPrice: 0, reason: "disabled" };
        if (this.state.currentYesPosition <= 0) return { active: false, exitPrice: 0, reason: "no_inventory" };
        const yes = this.books.get(this.yesTokenId);
        const bestBid = yes?.bid ?? null;
        if (bestBid === null || this.avgEntryPriceYes <= 0) return { active: false, exitPrice: 0, reason: "missing_bid_or_entry" };
        const hardTarget = this.avgEntryPriceYes * (1 + this.hardTakeProfitPct);
        if (bestBid < hardTarget) return { active: false, exitPrice: 0, reason: "hard_target_not_reached" };
        const exitPrice = clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
        return { active: true, exitPrice, reason: "hard_take_profit_triggered" };
    }

    private priceRiseExitSignal(): { active: boolean; exitPrice: number; reason: string } {
        if (this.state.currentYesPosition <= 0) return { active: false, exitPrice: 0, reason: "no_inventory" };
        const yes = this.books.get(this.yesTokenId);
        const bestBid = yes?.bid ?? null;
        if (bestBid === null || this.avgEntryPriceYes <= 0) return { active: false, exitPrice: 0, reason: "missing_bid_or_entry" };
        const minProfitTarget = clampToTickBounds(
            roundUpToTick(this.avgEntryPriceYes + (this.exitMinProfitTicks * this.tickSize), this.tickSize),
            this.tickSize,
        );
        if (this.entrySpotMoveTargetBps !== null) {
            const fairYes = this.currentFairYes();
            const polyPriceForCatchup = fairYes ?? bestBid;
            const polyImpliedMoveBps = ((polyPriceForCatchup - 0.5) / this.signalK) * 10000;
            if ((polyImpliedMoveBps + this.exitCatchupBufferBps) < this.entrySpotMoveTargetBps) {
                const holdSec = this.activePositionOpenedAt
                    ? Math.max(0, Math.floor((Date.now() - this.activePositionOpenedAt) / 1000))
                    : 0;
                if (this.exitAllowProfitBeforeCatchup && bestBid >= minProfitTarget) {
                    const exitPrice = clampToTickBounds(
                        Math.max(
                            minProfitTarget,
                            roundDownToTick(bestBid - (this.exitFastUndercutTicks * this.tickSize), this.tickSize),
                        ),
                        this.tickSize,
                    );
                    return { active: true, exitPrice, reason: "profit_before_full_catchup" };
                }
                if (this.exitForceAfterHoldSec > 0 && holdSec >= this.exitForceAfterHoldSec && bestBid >= minProfitTarget) {
                    const exitPrice = clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
                    return { active: true, exitPrice, reason: "forced_exit_after_hold_timeout" };
                }
                return { active: false, exitPrice: 0, reason: "waiting_for_polymarket_catchup" };
            }
        }
        if (bestBid < minProfitTarget) return { active: false, exitPrice: 0, reason: "price_not_risen" };
        const undercutCandidate = clampToTickBounds(
            roundDownToTick(bestBid - (this.exitFastUndercutTicks * this.tickSize), this.tickSize),
            this.tickSize,
        );
        const exitPrice = clampToTickBounds(
            Math.max(minProfitTarget, undercutCandidate),
            this.tickSize,
        );
        return { active: true, exitPrice, reason: "price_risen_after_bullish_tracker" };
    }

    private noTakeProfitSignal(): { active: boolean; exitPrice: number; reason: string } {
        if (!this.takeProfitEnabled) return { active: false, exitPrice: 0, reason: "disabled" };
        if (this.state.currentNoPosition <= 0) return { active: false, exitPrice: 0, reason: "no_inventory" };
        const no = this.books.get(this.noTokenId);
        const bestBid = no?.bid ?? null;
        if (bestBid === null || this.avgEntryPriceNo <= 0) return { active: false, exitPrice: 0, reason: "missing_bid_or_entry" };
        const target = this.avgEntryPriceNo * (1 + this.takeProfitPct);
        if (bestBid < target) return { active: false, exitPrice: 0, reason: "target_not_reached" };
        const exitPrice = clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
        return { active: true, exitPrice, reason: "triggered" };
    }

    private noHardTakeProfitSignal(): { active: boolean; exitPrice: number; reason: string } {
        if (this.hardTakeProfitPct <= 0) return { active: false, exitPrice: 0, reason: "disabled" };
        if (this.state.currentNoPosition <= 0) return { active: false, exitPrice: 0, reason: "no_inventory" };
        const no = this.books.get(this.noTokenId);
        const bestBid = no?.bid ?? null;
        if (bestBid === null || this.avgEntryPriceNo <= 0) return { active: false, exitPrice: 0, reason: "missing_bid_or_entry" };
        const hardTarget = this.avgEntryPriceNo * (1 + this.hardTakeProfitPct);
        if (bestBid < hardTarget) return { active: false, exitPrice: 0, reason: "hard_target_not_reached" };
        const exitPrice = clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
        return { active: true, exitPrice, reason: "hard_take_profit_triggered" };
    }

    private noPriceRiseExitSignal(): { active: boolean; exitPrice: number; reason: string } {
        if (this.state.currentNoPosition <= 0) return { active: false, exitPrice: 0, reason: "no_inventory" };
        const no = this.books.get(this.noTokenId);
        const bestBid = no?.bid ?? null;
        if (bestBid === null || this.avgEntryPriceNo <= 0) return { active: false, exitPrice: 0, reason: "missing_bid_or_entry" };
        const minProfitTarget = clampToTickBounds(
            roundUpToTick(this.avgEntryPriceNo + (this.exitMinProfitTicks * this.tickSize), this.tickSize),
            this.tickSize,
        );
        if (bestBid < minProfitTarget) return { active: false, exitPrice: 0, reason: "price_not_risen" };
        const undercutCandidate = clampToTickBounds(
            roundDownToTick(bestBid - (this.exitFastUndercutTicks * this.tickSize), this.tickSize),
            this.tickSize,
        );
        const exitPrice = clampToTickBounds(Math.max(minProfitTarget, undercutCandidate), this.tickSize);
        return { active: true, exitPrice, reason: "no_price_risen_after_bearish_tracker" };
    }

    private async maybeQuoteBearishNo(
        fairYes: number,
        lag: { lagBps: number | null; lagMode: "bullish_yes" | "bearish_yes" | "neutral" },
        secondsSinceStart: number | null,
        secondsToEnd: number | null,
        noNewOrdersWindowActive: boolean,
    ) {
        const no = this.books.get(this.noTokenId);
        if (!no || no.bid === null || no.ask === null) return;

        const noFair = clampPrice(1 - fairYes);
        const noBid = clampToTickBounds(roundDownToTick(no.bid, this.tickSize), this.tickSize);
        const noAsk = clampToTickBounds(roundUpToTick(no.ask, this.tickSize), this.tickSize);
        const buyWindowActive = secondsSinceStart !== null && secondsSinceStart >= 0 && secondsSinceStart <= this.buyWindowSec;
        const requiredLagBps = this.buyMinLagBps + this.entryEstimatedRoundTripCostBps + this.entryExtraEdgeBufferBps;
        const lagStrongEnough = lag.lagBps !== null && lag.lagBps <= -requiredLagBps;
        const spreadBps = this.currentNoSpreadBps();
        const spreadTicks = this.currentNoSpreadTicks();
        const spreadTooWideBps = this.entryMaxYesSpreadBps > 0 && spreadBps !== null && spreadBps > this.entryMaxYesSpreadBps;
        const spreadTooWideTicks = this.entryMaxYesSpreadTicks > 0
            && spreadTicks !== null
            && spreadTicks > (this.entryMaxYesSpreadTicks + this.spreadTickEpsilon);
        const spreadTooWide = spreadTooWideBps || spreadTooWideTicks;
        const currentNoPos = this.state.currentNoPosition;
        const remainingByPosition = Math.max(0, this.maxPosition - currentNoPos);
        const remainingNotional = Math.max(0, this.maxInventoryNotionalUsdc - (currentNoPos * this.avgEntryPriceNo));
        const remainingByNotional = noBid > 0 ? remainingNotional / noBid : 0;

        let buySize = Math.max(0, Math.min(this.orderSize, remainingByPosition, remainingByNotional));
        const hardExit = this.noHardTakeProfitSignal();
        const riseExit = this.noPriceRiseExitSignal();
        const tpExit = this.noTakeProfitSignal();
        const exitSignal = hardExit.active ? hardExit : (riseExit.active ? riseExit : tpExit);
        let sellSize = 0;
        let buyGateReason: string | null = null;

        if (!this.runtimeTradingEnabled || this.dryRun) {
            // continue sizing/logging in DRY_RUN
        }
        if (this.state.currentYesPosition > 0) {
            buySize = 0;
            buyGateReason = "holding_yes_inventory";
        }
        if (!buyWindowActive) {
            buySize = 0;
            buyGateReason = "outside_buy_window";
        }
        if (noNewOrdersWindowActive) {
            buySize = 0;
            buyGateReason = "inside_no_new_orders_window";
        }
        if (!lagStrongEnough) {
            buySize = 0;
            buyGateReason = "lag_below_fee_adjusted_min_bearish";
        }
        if (spreadTooWide) {
            buySize = 0;
            buyGateReason = "spread_too_wide_for_no_entry";
        }
        if (exitSignal.active) {
            buySize = 0;
            sellSize = Math.max(0, currentNoPos);
        }

        buySize = this.normalizeOrderSize(buySize, noBid, true);
        sellSize = this.normalizeOrderSize(sellSize, noAsk, false);

        if (this.dryRun || !this.runtimeTradingEnabled || !this.clobClient) {
            const decisionFingerprint = JSON.stringify({
                mode: this.runtimeTradingEnabled ? "dry_run" : "trading_disabled",
                req: Math.round(requiredLagBps),
                buySize,
                sellSize,
                buyGateReason,
                exitReason: exitSignal.reason,
            });
            if (this.shouldLogDecision("bearish_no_decision", decisionFingerprint)) {
                logger.info(
                    {
                        marketId: this.marketId,
                        noTokenId: this.noTokenId,
                        mode: this.runtimeTradingEnabled ? "dry_run" : "trading_disabled",
                        fairNo: noFair,
                        lagBps: lag.lagBps,
                        requiredLagBps,
                        buySize,
                        sellSize,
                        buyGateReason,
                        exitReason: exitSignal.reason,
                    },
                    "Bearish NO decision",
                );
            }
            return;
        }

        let buyPlaced = false;
        let sellPlaced = false;
        let buySkippedReason: string | null = null;
        let sellSkippedReason: string | null = null;

        if (buySize > 0) {
            await this.clobClient.createAndPostOrder(
                {
                    tokenID: this.noTokenId,
                    side: Side.BUY,
                    size: buySize,
                    price: noBid,
                },
                { tickSize: String(this.tickSize) as any },
                OrderType.GTC,
            );
            this.state.buyOrdersPlaced += 1;
            buyPlaced = true;
        } else {
            buySkippedReason = buyGateReason ?? "size_below_constraints_or_risk_cap";
        }
        if (sellSize > 0) {
            if (this.exitUseMarketOnSignal) {
                await this.clobClient.createAndPostMarketOrder(
                    {
                        tokenID: this.noTokenId,
                        side: Side.SELL,
                        amount: sellSize,
                    },
                    { tickSize: String(this.tickSize) as any },
                    OrderType.FAK as any,
                );
            } else {
                await this.clobClient.createAndPostOrder(
                    {
                        tokenID: this.noTokenId,
                        side: Side.SELL,
                        size: sellSize,
                        price: noAsk,
                    },
                    { tickSize: String(this.tickSize) as any },
                    OrderType.GTC,
                );
            }
            this.state.sellOrdersPlaced += 1;
            sellPlaced = true;
        } else {
            sellSkippedReason = exitSignal.active ? "no_no_inventory_to_exit" : "no_exit_signal";
        }

        logger.info(
            {
                noTokenId: this.noTokenId,
                fairNo: noFair,
                lag: {
                    mode: lag.lagMode,
                    bps: lag.lagBps,
                },
                feeAdjustedEntry: {
                    requiredLagBps,
                    estRoundTripCostBps: this.entryEstimatedRoundTripCostBps,
                    extraEdgeBufferBps: this.entryExtraEdgeBufferBps,
                    noSpreadBps: spreadBps,
                    noSpreadTicks: spreadTicks,
                    maxNoSpreadBps: this.entryMaxYesSpreadBps,
                    maxNoSpreadTicks: this.entryMaxYesSpreadTicks,
                },
                orderSize: this.orderSize,
                buySize,
                sellSize,
                buyGateReason,
                buyPlaced,
                sellPlaced,
                buySkippedReason,
                sellSkippedReason,
                inventoryNo: this.state.currentNoPosition,
                exitReason: exitSignal.reason,
            },
            "Posted NO quote orders",
        );
    }

    private pushFairSample(fairYes: number) {
        const now = Date.now();
        this.fairHistory.push({ at: now, fairYes });
        const keepMs = Math.max(this.buyNoChaseWindowMs * 2, 15000);
        const cutoff = now - keepMs;
        while (this.fairHistory.length > 0 && this.fairHistory[0].at < cutoff) {
            this.fairHistory.shift();
        }
        if (this.fairHistory.length > 300) {
            this.fairHistory = this.fairHistory.slice(-300);
        }
    }

    private buyNoChaseSignal(fairYes: number): { active: boolean; jumpBps: number | null; reason: string } {
        if (this.buyNoChaseWindowMs <= 0 || this.buyNoChaseMaxUpBps <= 0) {
            return { active: false, jumpBps: null, reason: "disabled" };
        }
        const now = Date.now();
        const cutoff = now - this.buyNoChaseWindowMs;
        const window = this.fairHistory.filter((x) => x.at >= cutoff);
        if (window.length < 2) return { active: false, jumpBps: null, reason: "insufficient_history" };
        let minFair = window[0].fairYes;
        for (const p of window) {
            if (p.fairYes < minFair) minFair = p.fairYes;
        }
        const jumpBps = (fairYes - minFair) * 10000;
        if (jumpBps > this.buyNoChaseMaxUpBps) {
            return { active: true, jumpBps, reason: "no_chase_recent_up_move" };
        }
        return { active: false, jumpBps, reason: "ok" };
    }

    private async forceFlattenNearEnd(fairYes: number, secondsToEnd: number) {
        const currentPos = this.state.currentYesPosition;
        if (currentPos <= 0) return;

        const yes = this.books.get(this.yesTokenId);
        const bestBid = yes?.bid ?? null;
        if (bestBid === null) return;

        const candidateExit = clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
        const breakEven = this.avgEntryPriceYes > 0 ? this.avgEntryPriceYes : null;
        const hardDeadlineActive = this.forceFlattenHardDeadlineSec > 0 && secondsToEnd <= this.forceFlattenHardDeadlineSec;
        const protectPrice = this.forceFlattenMode === "protect_price" && !this.forceFlattenAllowLoss;
        if (!hardDeadlineActive && protectPrice && breakEven !== null && candidateExit < breakEven) {
            const now = Date.now();
            if (now - this.lastForceFlattenLogAt > 3000) {
                logger.warn(
                    {
                        marketId: this.marketId,
                        yesTokenId: this.yesTokenId,
                        secondsToEnd,
                        currentPos,
                        avgEntryPriceYes: this.avgEntryPriceYes,
                        bestBid,
                        candidateExit,
                    },
                    "Force flatten skipped: would realize loss (FORCE_FLATTEN_ALLOW_LOSS=false)",
                );
                this.lastForceFlattenLogAt = now;
            }
            return;
        }

        const synced = await this.syncPositionFromDataApi(false);
        if (!synced) {
            const now = Date.now();
            if (now - this.lastForceFlattenSyncWarnAt > 15000) {
                logger.warn(
                    { marketId: this.marketId, yesTokenId: this.yesTokenId },
                    "Force-flatten position sync failed; using cached position",
                );
                this.lastForceFlattenSyncWarnAt = now;
            }
        }
        const openRows = await this.fetchOpenYesOrdersRows();
        const reservedShares = this.sumOpenSellReservedShares(openRows);
        const confirmedPos = Math.max(0, this.state.currentYesPosition - reservedShares);
        let sellSize = Math.min(currentPos, confirmedPos);
        let dustRecoveryShortSell = false;
        if (
            sellSize > 0
            && sellSize < this.minOrderSize
            && this.allowShortSell
            && this.dustRecoveryEnabled
        ) {
            sellSize = this.minOrderSize;
            dustRecoveryShortSell = true;
        }

        sellSize = this.normalizeOrderSize(sellSize, candidateExit, false);
        if (sellSize <= 0) return;

        if (this.dryRun || !this.runtimeTradingEnabled || !this.clobClient) {
            logger.info(
                {
                    marketId: this.marketId,
                    yesTokenId: this.yesTokenId,
                    fairYes,
                    secondsToEnd,
                    currentPos,
                    avgEntryPriceYes: this.avgEntryPriceYes,
                    exitPrice: candidateExit,
                    sellSize,
                    hardDeadlineActive,
                    forceFlattenMode: this.forceFlattenMode,
                    mode: this.runtimeTradingEnabled ? "dry_run" : "trading_disabled",
                    dustRecoveryShortSell,
                },
                "Force flatten near market end (simulation)",
            );
            return;
        }

        try {
            await this.cancelAllYesOrders();
        } catch (err) {
            logger.warn({ err, marketId: this.marketId }, "Cancel-all before force-flatten SELL failed; continuing with SELL");
        }
        try {
            if (hardDeadlineActive) {
                await this.clobClient.createAndPostMarketOrder(
                    {
                        tokenID: this.yesTokenId,
                        side: Side.SELL,
                        amount: sellSize,
                    },
                    { tickSize: String(this.tickSize) as any },
                    OrderType.FAK as any,
                );
            } else {
                await this.clobClient.createAndPostOrder(
                    {
                        tokenID: this.yesTokenId,
                        side: Side.SELL,
                        size: sellSize,
                        price: candidateExit,
                    },
                    { tickSize: String(this.tickSize) as any },
                    OrderType.GTC,
                );
            }
        } catch (err) {
            if (!this.isInsufficientBalanceOrAllowanceError(err)) throw err;
            logger.warn(
                {
                    marketId: this.marketId,
                    yesTokenId: this.yesTokenId,
                    attemptedSellSize: sellSize,
                    inventoryBeforeRetry: this.state.currentYesPosition,
                    err: err instanceof Error ? err.message : String(err),
                },
                "Force-flatten SELL rejected for balance/allowance; retrying after cancel+resync",
            );
            try {
                await this.cancelAllYesOrders();
            } catch {
                // best effort
            }
            await this.syncPositionFromDataApi(false);
            const retryRows = await this.fetchOpenYesOrdersRows();
            const retryReservedShares = this.sumOpenSellReservedShares(retryRows);
            const retryFreePos = Math.max(0, this.state.currentYesPosition - retryReservedShares);
            const retrySize = this.normalizeOrderSize(Math.min(sellSize, retryFreePos), candidateExit, false);
            if (retrySize <= 0) {
                logger.warn(
                    { marketId: this.marketId, yesTokenId: this.yesTokenId, position: this.state.currentYesPosition },
                    "Force-flatten retry skipped: no inventory after resync",
                );
                return;
            }
            if (hardDeadlineActive) {
                await this.clobClient.createAndPostMarketOrder(
                    {
                        tokenID: this.yesTokenId,
                        side: Side.SELL,
                        amount: retrySize,
                    },
                    { tickSize: String(this.tickSize) as any },
                    OrderType.FAK as any,
                );
            } else {
                await this.clobClient.createAndPostOrder(
                    {
                        tokenID: this.yesTokenId,
                        side: Side.SELL,
                        size: retrySize,
                        price: candidateExit,
                    },
                    { tickSize: String(this.tickSize) as any },
                    OrderType.GTC,
                );
            }
            sellSize = retrySize;
        }
        this.state.sellOrdersPlaced += 1;

        logger.info(
            {
                marketId: this.marketId,
                yesTokenId: this.yesTokenId,
                fairYes,
                secondsToEnd,
                currentPos,
                avgEntryPriceYes: this.avgEntryPriceYes,
                exitPrice: candidateExit,
                sellSize,
                hardDeadlineActive,
                forceFlattenMode: this.forceFlattenMode,
                forceFlattenAllowLoss: this.forceFlattenAllowLoss,
                dustRecoveryShortSell,
            },
            "Force flatten near market end (posted SELL)",
        );
    }

    private forceFlattenStatus() {
        const secondsToEnd = this.secondsToMarketEnd();
        const inWindow = (
            this.forceFlattenEnabled
            && this.forceFlattenBeforeEndSec > 0
            && secondsToEnd !== null
            && secondsToEnd <= this.forceFlattenBeforeEndSec
        );
        const hasInventory = this.state.currentYesPosition > 0;
        const yes = this.books.get(this.yesTokenId);
        const bestBid = yes?.bid ?? null;
        const candidateExit = bestBid === null
            ? null
            : clampToTickBounds(roundDownToTick(bestBid, this.tickSize), this.tickSize);
        const hardDeadlineActive = (
            this.forceFlattenHardDeadlineSec > 0
            && secondsToEnd !== null
            && secondsToEnd <= this.forceFlattenHardDeadlineSec
        );
        const protectPrice = this.forceFlattenMode === "protect_price" && !this.forceFlattenAllowLoss;
        const blockedByNoLoss = (
            inWindow
            && hasInventory
            && !hardDeadlineActive
            && protectPrice
            && candidateExit !== null
            && this.avgEntryPriceYes > 0
            && candidateExit < this.avgEntryPriceYes
        );
        const ready = inWindow && hasInventory && candidateExit !== null && !blockedByNoLoss;

        let reason: string;
        if (!this.forceFlattenEnabled) reason = "disabled";
        else if (secondsToEnd === null) reason = "market_end_unknown";
        else if (!inWindow) reason = "outside_force_flatten_window";
        else if (!hasInventory) reason = "no_inventory";
        else if (candidateExit === null) reason = "missing_best_bid";
        else if (blockedByNoLoss) reason = "blocked_by_no_loss_guard";
        else reason = "ready_to_flatten";

        return {
            enabled: this.forceFlattenEnabled,
            allowLoss: this.forceFlattenAllowLoss,
            mode: this.forceFlattenMode,
            beforeEndSec: this.forceFlattenBeforeEndSec,
            hardDeadlineSec: this.forceFlattenHardDeadlineSec,
            hardDeadlineActive,
            noNewOrdersBeforeEndSec: this.noNewOrdersBeforeEndSec,
            cancelAllBeforeEndSec: this.cancelAllBeforeEndSec,
            secondsToEnd,
            inWindow,
            hasInventory,
            inventory: this.state.currentYesPosition,
            avgEntryPriceYes: this.avgEntryPriceYes > 0 ? Number(this.avgEntryPriceYes.toFixed(6)) : 0,
            bestBid,
            candidateExit,
            blockedByNoLoss,
            ready,
            reason,
        };
    }

    private secondsToMarketEnd(): number | null {
        if (!this.marketEndUnixSec || !Number.isFinite(this.marketEndUnixSec)) return null;
        return Math.floor(this.marketEndUnixSec - Date.now() / 1000);
    }

    private secondsSinceMarketStart(): number | null {
        if (!this.marketStartUnixSec || !Number.isFinite(this.marketStartUnixSec)) return null;
        return Math.floor(Date.now() / 1000 - this.marketStartUnixSec);
    }

    private parseOpenOrderRows(open: unknown): any[] {
        return Array.isArray(open) ? open
            : Array.isArray((open as any)?.data) ? (open as any).data
                : Array.isArray((open as any)?.orders) ? (open as any).orders
                    : [];
    }

    private orderIdFromRow(o: any): string {
        return String(o?.id ?? o?.orderID ?? o?.order_id ?? "");
    }

    private remainingSellSizeFromOrderRow(o: any): number {
        const side = String(o?.side ?? "").toUpperCase();
        if (side !== "SELL") return 0;
        const original = toNumber(o?.original_size);
        const matched = toNumber(o?.size_matched);
        if (original !== null && matched !== null) {
            return Math.max(0, original - matched);
        }
        const size = toNumber(o?.size);
        return Math.max(0, size ?? 0);
    }

    private sumOpenSellReservedShares(rows: any[]): number {
        let total = 0;
        for (const row of rows) {
            total += this.remainingSellSizeFromOrderRow(row);
        }
        return total;
    }

    private isRateLimitedOpenOrdersError(err: unknown): boolean {
        const e: any = err as any;
        const status = Number(e?.response?.status ?? NaN);
        const dataMsg = String(e?.response?.data ?? "").toLowerCase();
        const msg = String(e?.message ?? "").toLowerCase();
        return (
            status === 429
            || dataMsg.includes("error 1015")
            || dataMsg.includes("rate limit")
            || msg.includes("429")
            || msg.includes("error 1015")
            || msg.includes("rate limit")
        );
    }

    private async fetchOpenYesOrdersRows(force = false, useCacheOnSkip = true): Promise<any[]> {
        if (!this.clobClient) return [];
        const now = Date.now();
        if (now < this.openOrdersRateLimitedUntil) {
            return useCacheOnSkip ? this.openYesOrdersCache : [];
        }
        if (!force && this.clobLedgerMinIntervalMs > 0 && now - this.lastOpenOrdersFetchAt < this.clobLedgerMinIntervalMs) {
            return useCacheOnSkip ? this.openYesOrdersCache : [];
        }
        this.lastOpenOrdersFetchAt = now;

        try {
            const open = await this.clobClient.getOpenOrders({ asset_id: this.yesTokenId });
            const rows = this.parseOpenOrderRows(open);
            this.openYesOrdersCache = rows;
            return rows;
        } catch (err) {
            if (this.isRateLimitedOpenOrdersError(err)) {
                this.openOrdersRateLimitedUntil = Date.now() + this.openOrdersRateLimitBackoffMs;
                logger.warn(
                    {
                        marketId: this.marketId,
                        yesTokenId: this.yesTokenId,
                        backoffMs: this.openOrdersRateLimitBackoffMs,
                    },
                    "getOpenOrders rate-limited; backing off",
                );
                return useCacheOnSkip ? this.openYesOrdersCache : [];
            }
            logger.warn(
                { err, marketId: this.marketId, yesTokenId: this.yesTokenId },
                "getOpenOrders failed; skipping cancel-all for this cycle",
            );
            return useCacheOnSkip ? this.openYesOrdersCache : [];
        }
    }

    private async cancelAllYesOrders() {
        if (!this.clobClient) return;
        const now = Date.now();
        if (now < this.openOrdersRateLimitedUntil) return;
        if (this.cancelAllMinIntervalMs > 0 && now - this.lastCancelAllCallAt < this.cancelAllMinIntervalMs) return;
        this.lastCancelAllCallAt = now;
        const rows = await this.fetchOpenYesOrdersRows(false, false);
        const orderIds = rows.map((o: any) => this.orderIdFromRow(o)).filter(Boolean);
        if (orderIds.length > 0) {
            await this.clobClient.cancelOrders(orderIds);
        }
    }

    private pushCycleNetAfterFees(cycleNetAfterFeesUsdc: number) {
        this.lastCycleNetAfterFeesUsdc = cycleNetAfterFeesUsdc;
        this.sessionNetAfterFeesUsdc += cycleNetAfterFeesUsdc;
        this.recentCycleNetAfterFeesUsdc.push(cycleNetAfterFeesUsdc);
        if (this.recentCycleNetAfterFeesUsdc.length > this.rollingExpectancyWindow) {
            this.recentCycleNetAfterFeesUsdc = this.recentCycleNetAfterFeesUsdc.slice(-this.rollingExpectancyWindow);
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
                entryCount: this.state.entryCount,
                completedRoundTrips: this.state.completedRoundTrips,
                winningRoundTrips: this.state.winningRoundTrips,
                losingRoundTrips: this.state.losingRoundTrips,
            },
            pnl: {
                realizedYes: Number(this.realizedPnlYes.toFixed(4)),
                unrealizedYes: Number(this.unrealizedPnlYes().toFixed(4)),
                netYes: Number((this.realizedPnlYes + this.unrealizedPnlYes()).toFixed(4)),
                netAfterFeesSessionUsdc: Number(this.sessionNetAfterFeesUsdc.toFixed(4)),
                rollingAvgCycleNetAfterFeesUsdc: this.rollingAvgCycleNetAfterFeesUsdc() !== null
                    ? Number((this.rollingAvgCycleNetAfterFeesUsdc() as number).toFixed(4))
                    : null,
                lastCycleNetAfterFeesUsdc: this.lastCycleNetAfterFeesUsdc !== null
                    ? Number(this.lastCycleNetAfterFeesUsdc.toFixed(4))
                    : null,
                avgEntryPriceYes: Number(this.avgEntryPriceYes.toFixed(6)),
                avgEntryPriceNo: Number(this.avgEntryPriceNo.toFixed(6)),
                inventoryNotionalUsdc: Number(this.inventoryNotionalUsdc().toFixed(4)),
                avgEntryLagBps: this.state.entryCount > 0
                    ? Number((this.sumEntryLagBps / this.state.entryCount).toFixed(2))
                    : 0,
                avgHoldSec: this.state.completedRoundTrips > 0
                    ? Number(((this.holdMsAccumulated / this.state.completedRoundTrips) / 1000).toFixed(2))
                    : 0,
                currentHoldSec: this.activePositionOpenedAt
                    ? Number(((Date.now() - this.activePositionOpenedAt) / 1000).toFixed(2))
                    : 0,
                lastFill: this.lastFill,
            },
            collateral: {
                balanceRaw: this.collateral.balanceRaw.toString(),
                allowanceRaw: this.collateral.allowanceRaw.toString(),
                updatedAt: this.collateral.updatedAt || null,
                lastError: this.collateral.lastError,
            },
            dryRun: this.dryRun,
            tradingEnabled: this.runtimeTradingEnabled,
            configuredTradingEnabled: this.configuredTradingEnabled,
            lagArb: {
                enabled: this.lagArbEnabled,
                regime: this.lagRegime,
                spotMoveBps: this.spotMoveBps,
                entrySpotMoveTargetBps: this.entrySpotMoveTargetBps,
                spotUpdatedAt: this.spotUpdatedAt,
                spotConnected: this.spotConnected,
                enterBps: this.lagEnterBps,
                exitBps: this.lagExitBps,
                exitCatchupBufferBps: this.exitCatchupBufferBps,
                maxSkew: this.lagMaxSkew,
                sizeMult: this.lagSizeMult,
            },
            entryGuards: {
                requiredLagBps: this.buyMinLagBps + this.entryEstimatedRoundTripCostBps + this.entryExtraEdgeBufferBps,
                estRoundTripCostBps: this.entryEstimatedRoundTripCostBps,
                extraEdgeBufferBps: this.entryExtraEdgeBufferBps,
                maxYesSpreadBps: this.entryMaxYesSpreadBps,
                maxYesSpreadTicks: this.entryMaxYesSpreadTicks,
                sessionMaxConsecutiveLosses: this.sessionMaxConsecutiveLosses,
                sessionMaxNetLossUsdc: this.sessionMaxNetLossUsdc,
                rollingExpectancyWindow: this.rollingExpectancyWindow,
                rollingExpectancyPauseBelowUsdc: this.rollingExpectancyPauseBelowUsdc,
                rollingExpectancyReduceSizeBelowUsdc: this.rollingExpectancyReduceSizeBelowUsdc,
                rollingExpectancyReduceSizeMult: this.rollingExpectancyReduceSizeMult,
                estimatedFeeBps: this.estimatedFeeBps,
                consecutiveLosingRoundTrips: this.consecutiveLosingRoundTrips,
            },
            forceFlatten: this.forceFlattenStatus(),
        };
    }
}
