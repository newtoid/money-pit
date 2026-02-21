// src/main.ts
import { env } from "./config";
import { ensureClobApiCreds } from "./clobCredentials";
import { createAuthedClobClient } from "./clobClientFactory";
import { createUserWs } from "./ws/userWs";
import { createMarketWs } from "./ws/marketWs";
import { logger } from "./logger";
import {
    resolveLatestBtc5mMarket,
    resolveMarketIdFromSlug,
} from "./gamma/resolveMarketIdFromSlug";
import { TradeEngine } from "./tradeEngine";
import { startDashboardServer } from "./dashboardServer";
import { runClobPreflight } from "./clobPreflight";
import { SpotFeed } from "./spotFeed";
import { DustSweeper } from "./dustSweeper";
import { RedeemablesManager } from "./redeemablesManager";

function logEnvSummary() {
    logger.info("Starting bot");
    logger.info(
        {
            apiKeyPresent: Boolean(env.POLYMARKET_CLOB_API_KEY),
            secretPresent: Boolean(env.POLYMARKET_CLOB_SECRET),
            passphrasePresent: Boolean(env.POLYMARKET_CLOB_PASSPHRASE),
            dryRun: env.DRY_RUN,
            marketSlugPresent: Boolean(env.MARKET_SLUG),
        },
        "Config",
    );
    logger.info({ raw: process.env.DRY_RUN }, "process.env.DRY_RUN (raw)");
    logger.info(
        {
            orderSize: process.env.ORDER_SIZE ?? null,
            maxPosition: process.env.MAX_POSITION ?? null,
            maxInventoryNotionalUsdc: process.env.MAX_INVENTORY_NOTIONAL_USDC ?? null,
            requoteTickThreshold: process.env.REQUOTE_TICK_THRESHOLD ?? null,
            minRequoteMs: process.env.MIN_REQUOTE_MS ?? null,
        },
        "Strategy env (effective process values)",
    );
}

async function main() {
    logEnvSummary();
    const startedAt = Date.now();
    const dashboardPort = Number(process.env.DASHBOARD_PORT ?? "8787");
    const recentEvents: Array<{ at: number; type: string; msg?: string }> = [];
    const pushEvent = (type: string, msg?: string) => {
        recentEvents.unshift({ at: Date.now(), type, msg });
        if (recentEvents.length > 100) recentEvents.length = 100;
    };
    const wsState = {
        user: { connected: false, messages: 0, reconnects: 0, lastCloseCode: null as number | null, lastCloseReason: "" },
        market: { connected: false, messages: 0, reconnects: 0, lastCloseCode: null as number | null, lastCloseReason: "" },
    };

    const configuredSlug = env.MARKET_SLUG;
    const slugUnix = configuredSlug?.match(/(\d+)$/)?.[1];
    const slugAgeSec = slugUnix ? Math.floor(Date.now() / 1000) - Number(slugUnix) : null;
    const useLatest = !configuredSlug || (slugAgeSec !== null && slugAgeSec > 900);

    let slug = configuredSlug ?? "";
    let marketId = "";
    let question = "";
    let tokenIds: string[] = [];
    let marketStartUnixSec: number | null = null;
    let marketEndUnixSec: number | null = null;
    let marketOpenSpot: number | null = null;

    if (useLatest) {
        if (!configuredSlug) {
            logger.warn("MARKET_SLUG missing; auto-resolving latest BTC 5m market");
        } else {
            logger.warn(
                { configuredSlug, slugAgeSec },
                "MARKET_SLUG appears stale; auto-resolving latest BTC 5m market",
            );
        }
        const latest = await resolveLatestBtc5mMarket();
        slug = latest.slug;
        marketId = latest.marketId;
        question = latest.question;
        tokenIds = latest.tokenIds;
        marketStartUnixSec = deriveMarketStartUnixFromSlug(slug);
        marketEndUnixSec = deriveMarketEndUnixFromSlug(slug);
    } else {
        logger.info({ slug: configuredSlug }, "Resolving market id from slug");
        const resolved = await resolveMarketIdFromSlug(configuredSlug!);
        slug = configuredSlug!;
        marketId = resolved.marketId;
        question = resolved.question;
        tokenIds = resolved.tokenIds;
        marketStartUnixSec = deriveMarketStartUnixFromSlug(slug);
        marketEndUnixSec = deriveMarketEndUnixFromSlug(slug);
    }

    logger.info({ slug, marketId, question, tokenIds }, "Resolved market id");

    let clobCreds = null;
    let credsSource: "none" | "env" | "derived" = "none";
    if (!env.DRY_RUN) {
        try {
            const bootstrap = await ensureClobApiCreds();
            clobCreds = bootstrap.creds;
            credsSource = bootstrap.source;
            logger.info(
                {
                    source: bootstrap.source,
                    signatureType: process.env.POLYMARKET_SIGNATURE_TYPE ?? process.env.CLOB_SIGNATURE_TYPE ?? "0",
                    funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS
                        ?? process.env.POLYMARKET_FUNDER
                        ?? process.env.CLOB_FUNDER
                        ?? null,
                },
                "CLOB credentials ready",
            );
            logger.info(
                {
                    tradingEnabled: env.TRADING_ENABLED,
                    tradingUseSignerAsMaker: env.TRADING_USE_SIGNER_AS_MAKER,
                    tradingSignatureType: env.TRADING_SIGNATURE_TYPE
                        ?? process.env.POLYMARKET_SIGNATURE_TYPE
                        ?? process.env.CLOB_SIGNATURE_TYPE
                        ?? "0",
                    tradingFunderAddress: env.TRADING_USE_SIGNER_AS_MAKER
                        ? null
                        : (env.TRADING_FUNDER_ADDRESS
                            ?? process.env.POLYMARKET_FUNDER_ADDRESS
                            ?? process.env.POLYMARKET_FUNDER
                            ?? process.env.CLOB_FUNDER
                            ?? null),
                },
                "Trading maker mode",
            );
        } catch (err) {
            logger.error(
                { err },
                "Failed to verify/regenerate CLOB credentials; user WS will be disabled",
            );
        }
    }

    const clobClient = createAuthedClobClient(clobCreds);
    if (clobClient && !env.DRY_RUN && env.TRADING_ENABLED) {
        await runClobPreflight(clobClient);
    }
    type ActiveRuntime = {
        marketId: string;
        tokenIds: string[];
        marketStartUnixSec: number | null;
        marketEndUnixSec: number | null;
        engine: TradeEngine;
        userWs: ReturnType<typeof createUserWs>;
        marketWs: ReturnType<typeof createMarketWs>;
    };
    let active: ActiveRuntime | null = null;

    const stopActiveRuntime = () => {
        if (!active) return;
        active.userWs.stop();
        active.marketWs.stop();
        active.engine.stop();
        active = null;
        wsState.user.connected = false;
        wsState.market.connected = false;
    };

    const startRuntime = (target: {
        marketId: string;
        tokenIds: string[];
        marketStartUnixSec: number | null;
        marketEndUnixSec: number | null;
    }) => {
        const engine = new TradeEngine({
            marketId: target.marketId,
            tokenIds: target.tokenIds,
            marketStartUnixSec: target.marketStartUnixSec,
            marketEndUnixSec: target.marketEndUnixSec,
            clobClient,
            dryRun: env.DRY_RUN,
            tradingEnabled: env.TRADING_ENABLED,
        });

        const userWs = createUserWs(target.marketId, clobCreds, {
            onMessage: (msg) => {
                wsState.user.messages += 1;
                engine.onUserMessage(msg);
            },
            onReconnect: () => {
                wsState.user.reconnects += 1;
                engine.onReconnect();
                pushEvent("user_ws_reconnect");
            },
            onOpen: () => {
                wsState.user.connected = true;
                pushEvent("user_ws_open");
            },
            onClose: (code, reason) => {
                wsState.user.connected = false;
                wsState.user.lastCloseCode = code;
                wsState.user.lastCloseReason = reason;
                pushEvent("user_ws_close", `${code} ${reason}`);
            },
        });
        const marketWs = createMarketWs({
            assetIds: target.tokenIds,
            onMessage: (msg) => {
                wsState.market.messages += 1;
                engine.onMarketMessage(msg);
            },
            onReconnect: () => {
                wsState.market.reconnects += 1;
                engine.onReconnect();
                pushEvent("market_ws_reconnect");
            },
            onOpen: () => {
                wsState.market.connected = true;
                pushEvent("market_ws_open");
            },
            onClose: (code, reason) => {
                wsState.market.connected = false;
                wsState.market.lastCloseCode = code;
                wsState.market.lastCloseReason = reason;
                pushEvent("market_ws_close", `${code} ${reason}`);
            },
        });

        active = {
            marketId: target.marketId,
            tokenIds: target.tokenIds,
            marketStartUnixSec: target.marketStartUnixSec,
            marketEndUnixSec: target.marketEndUnixSec,
            engine,
            userWs,
            marketWs,
        };

        userWs.start();
        marketWs.start();
        engine.start();
        const spot = spotFeed.getSnapshot();
        const spotMove = (spot.price !== null && marketOpenSpot !== null && marketOpenSpot > 0)
            ? ((spot.price - marketOpenSpot) / marketOpenSpot)
            : null;
        engine.updateSpotSignal({
            spotMoveBps: spotMove === null ? null : spotMove * 10000,
            updatedAt: spot.updatedAt,
            connected: spot.connected,
        });
    };

    const spotFeed = new SpotFeed({
        onPrice: (price) => {
            if (marketOpenSpot === null) {
                marketOpenSpot = price;
            }
            const spotMove = (marketOpenSpot !== null && marketOpenSpot > 0)
                ? ((price - marketOpenSpot) / marketOpenSpot)
                : null;
            active?.engine.updateSpotSignal({
                spotMoveBps: spotMove === null ? null : spotMove * 10000,
                updatedAt: Date.now(),
                connected: true,
            });
        },
    });
    const dustSweeper = new DustSweeper({
        clobClient,
        getActiveTokenIds: () => active?.tokenIds ?? [],
    });
    const redeemables = new RedeemablesManager();

    const dashboardServer = startDashboardServer({
        port: dashboardPort,
        onListening: (port) => logger.info({ dashboardPort: port }, "Dashboard available"),
        onError: (err) => {
            const e = err as NodeJS.ErrnoException;
            if (e?.code === "EADDRINUSE") {
                logger.warn(
                    { dashboardPort },
                    "Dashboard port already in use; continuing without dashboard on this process",
                );
                return;
            }
            logger.error({ err }, "Dashboard server error");
        },
        onRedeemNow: async () => redeemables.redeemNow(),
        getState: () => ({
            ...(function () {
                const engine = active?.engine.getSnapshot() ?? null;
                const spot = spotFeed.getSnapshot();
                const fairYes = engine?.lastQuote?.fairYes ?? null;
                const spotMove = (spot.price !== null && marketOpenSpot !== null && marketOpenSpot > 0)
                    ? ((spot.price - marketOpenSpot) / marketOpenSpot)
                    : null;
                const signalK = Number(process.env.SIGNAL_K ?? "60");
                const signalFairYes = spotMove === null
                    ? null
                    : Math.max(0.01, Math.min(0.99, 0.5 + (signalK * spotMove)));
                const edgeVsPolymarket = (signalFairYes !== null && fairYes !== null)
                    ? (signalFairYes - fairYes)
                    : null;
                const polymarketImpliedMove = fairYes === null
                    ? null
                    : ((fairYes - 0.5) / signalK);
                const polymarketImpliedMoveBps = polymarketImpliedMove === null
                    ? null
                    : polymarketImpliedMove * 10000;
                const lagBps = (spotMove !== null && polymarketImpliedMove !== null)
                    ? (spotMove - polymarketImpliedMove) * 10000
                    : null;
                return {
                    engine,
                    dustSweeper: dustSweeper.getSnapshot(),
                    redeemables: redeemables.getSnapshot(),
                    signal: {
                        spotPrice: spot.price,
                        spotUpdatedAt: spot.updatedAt,
                        spotConnected: spot.connected,
                        spotMessages: spot.messages,
                        spotReconnects: spot.reconnects,
                        marketOpenSpot,
                        marketStartUnixSec,
                        marketEndUnixSec,
                        spotMoveBps: spotMove === null ? null : spotMove * 10000,
                        polymarketImpliedMoveBps,
                        lagBps,
                        signalFairYes,
                        polymarketFairYes: fairYes,
                        edgeVsPolymarket,
                    },
                };
            })(),
            process: {
                running: true,
                startedAt,
                uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
            },
            config: {
                dryRun: env.DRY_RUN,
                tradingEnabled: env.TRADING_ENABLED,
                tradingUseSignerAsMaker: env.TRADING_USE_SIGNER_AS_MAKER,
                tradingFunderAddress: env.TRADING_USE_SIGNER_AS_MAKER
                    ? null
                    : (env.TRADING_FUNDER_ADDRESS
                        ?? process.env.POLYMARKET_FUNDER_ADDRESS
                        ?? process.env.POLYMARKET_FUNDER
                        ?? process.env.CLOB_FUNDER
                        ?? null),
                credsSource,
                dashboardPort,
            },
            market: { slug, marketId, question, tokenIds },
            ws: wsState,
            events: recentEvents,
        }),
    });

    startRuntime({ marketId, tokenIds, marketStartUnixSec, marketEndUnixSec });
    spotFeed.start();
    dustSweeper.start();
    redeemables.start();

    const rolloverCheckMsRaw = Number(process.env.MARKET_ROLLOVER_CHECK_MS ?? "15000");
    const rolloverCheckMs = Number.isFinite(rolloverCheckMsRaw) ? Math.max(5000, Math.floor(rolloverCheckMsRaw)) : 15000;
    let rolloverTimer: NodeJS.Timeout | null = null;

    const maybeRolloverMarket = async () => {
        if (!useLatest) return;
        try {
            const latest = await resolveLatestBtc5mMarket();
            if (latest.marketId === marketId) return;

            const prev = { slug, marketId };
            slug = latest.slug;
            marketId = latest.marketId;
            question = latest.question;
            tokenIds = latest.tokenIds;
            marketStartUnixSec = deriveMarketStartUnixFromSlug(slug);
            marketEndUnixSec = deriveMarketEndUnixFromSlug(slug);
            marketOpenSpot = spotFeed.getSnapshot().price;

            logger.info(
                {
                    from: prev,
                    to: { slug, marketId },
                    tokenIds,
                    reason: "latest_5m_market_changed",
                },
                "Rolling bot to new market",
            );
            pushEvent("market_rollover", `${prev.marketId} -> ${marketId}`);

            stopActiveRuntime();
            startRuntime({ marketId, tokenIds, marketStartUnixSec, marketEndUnixSec });
        } catch (err) {
            logger.warn({ err }, "Market rollover check failed");
        }
    };

    if (useLatest) {
        rolloverTimer = setInterval(() => {
            void maybeRolloverMarket();
        }, rolloverCheckMs);
    }

    const shutdown = () => {
        logger.info("Shutting down...");
        if (rolloverTimer) clearInterval(rolloverTimer);
        rolloverTimer = null;
        spotFeed.stop();
        dustSweeper.stop();
        redeemables.stop();
        stopActiveRuntime();
        dashboardServer.close();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

function deriveMarketStartUnixFromSlug(slug: string): number | null {
    const match = slug.match(/(\d+)$/);
    if (!match) return null;
    const startUnix = Number(match[1]);
    if (!Number.isFinite(startUnix)) return null;
    return startUnix;
}

function deriveMarketEndUnixFromSlug(slug: string): number | null {
    const startUnix = deriveMarketStartUnixFromSlug(slug);
    if (startUnix === null) return null;
    return startUnix + 300; // BTC 5m window
}

main().catch((err) => {
    logger.error({ err }, "Fatal error");
    process.exit(1);
});
