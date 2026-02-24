// src/main.ts
import { env } from "./config";
import { ensureClobApiCreds } from "./clobCredentials";
import { createAuthedClobClient } from "./clobClientFactory";
import { createUserWs } from "./ws/userWs";
import { createMarketWs } from "./ws/marketWs";
import { logger } from "./logger";
import {
    type UpDownAsset,
    resolveLatestBtc5mMarket,
    resolveLatestUpDownHourlyMarket,
    resolveMarketIdFromSlug,
} from "./gamma/resolveMarketIdFromSlug";
import { TradeEngine } from "./tradeEngine";
import { startDashboardServer } from "./dashboardServer";
import { runClobPreflight } from "./clobPreflight";
import { SpotFeed } from "./spotFeed";

type ActiveRuntime = {
    asset: UpDownAsset;
    slug: string;
    marketId: string;
    question: string;
    tokenIds: string[];
    marketStartUnixSec: number | null;
    marketEndUnixSec: number | null;
    engine: TradeEngine;
    userWs: ReturnType<typeof createUserWs>;
    marketWs: ReturnType<typeof createMarketWs>;
};

function logEnvSummary() {
    logger.info("Starting bot");
    logger.info(
        {
            apiKeyPresent: Boolean(env.POLYMARKET_CLOB_API_KEY),
            secretPresent: Boolean(env.POLYMARKET_CLOB_SECRET),
            passphrasePresent: Boolean(env.POLYMARKET_CLOB_PASSPHRASE),
            dryRun: env.DRY_RUN,
            marketSlugPresent: Boolean(env.MARKET_SLUG),
            autoMarketMode: process.env.AUTO_MARKET_MODE ?? "5m",
            autoMarketAsset: process.env.AUTO_MARKET_ASSET ?? "btc",
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
    const lossCooldownMarketsConfiguredRaw = Number(process.env.LOSS_COOLDOWN_MARKETS_AFTER_LOSS ?? "1");
    const lossCooldownMarketsConfigured = Number.isFinite(lossCooldownMarketsConfiguredRaw)
        ? Math.max(0, Math.floor(lossCooldownMarketsConfiguredRaw))
        : 1;
    let cooldownMarketsRemaining = 0;
    let cooldownActiveThisMarket = false;
    let lastMarketNetAfterFeesUsdc: number | null = null;
    const defaultAssets: UpDownAsset[] = ["btc", "eth", "sol", "xrp"];
    const controls = {
        tradingEnabled: env.TRADING_ENABLED,
        multiMarketEnabled: String(process.env.MULTI_MARKET_ENABLED ?? "false").trim().toLowerCase() === "true",
        assetsEnabled: {
            btc: true,
            eth: true,
            sol: true,
            xrp: true,
        } as Record<UpDownAsset, boolean>,
    };
    const marketLifecycle = {
        completed: 0,
        flatAtHandoff: 0,
        leftoverAtHandoff: 0,
        leftoverSharesTotal: 0,
        lastFinalizedMarketId: null as string | null,
    };

    const configuredSlug = env.MARKET_SLUG;
    const autoMarketModeRaw = String(process.env.AUTO_MARKET_MODE ?? "5m").trim().toLowerCase();
    const autoMarketMode: "5m" | "hourly_updown" = autoMarketModeRaw === "hourly_updown" ? "hourly_updown" : "5m";
    const autoMarketAssetRaw = String(process.env.AUTO_MARKET_ASSET ?? "btc").trim().toLowerCase();
    const autoMarketAsset: UpDownAsset = (["btc", "eth", "sol", "xrp"] as const).includes(autoMarketAssetRaw as any)
        ? (autoMarketAssetRaw as UpDownAsset)
        : "btc";
    const autoMarketAssetsRaw = String(process.env.AUTO_MARKET_ASSETS ?? autoMarketAsset).trim().toLowerCase();
    const parsedAssets = Array.from(new Set(autoMarketAssetsRaw.split(",").map((x) => x.trim()).filter(Boolean)))
        .filter((x): x is UpDownAsset => (["btc", "eth", "sol", "xrp"] as const).includes(x as any));
    const monitoredAssets: UpDownAsset[] = parsedAssets.length > 0 ? parsedAssets : defaultAssets;
    for (const k of Object.keys(controls.assetsEnabled) as UpDownAsset[]) controls.assetsEnabled[k] = false;
    for (const a of monitoredAssets) controls.assetsEnabled[a] = true;
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

    const resolveLatestAutoMarket = async (asset: UpDownAsset = autoMarketAsset) => {
        if (autoMarketMode === "hourly_updown") {
            return resolveLatestUpDownHourlyMarket(asset);
        }
        return resolveLatestBtc5mMarket();
    };

    if (useLatest) {
        if (!configuredSlug) {
            logger.warn({ autoMarketMode, autoMarketAsset }, "MARKET_SLUG missing; auto-resolving latest market");
        } else {
            logger.warn(
                { configuredSlug, slugAgeSec, autoMarketMode, autoMarketAsset },
                "MARKET_SLUG appears stale; auto-resolving latest market",
            );
        }
        const latest = await resolveLatestAutoMarket();
        slug = latest.slug;
        marketId = latest.marketId;
        question = latest.question;
        tokenIds = latest.tokenIds;
        marketStartUnixSec = latest.startUnixSec ?? deriveMarketStartUnixFromSlug(slug);
        marketEndUnixSec = latest.endUnixSec ?? deriveMarketEndUnixFromSlug(slug);
    } else {
        logger.info({ slug: configuredSlug }, "Resolving market id from slug");
        const resolved = await resolveMarketIdFromSlug(configuredSlug!);
        slug = configuredSlug!;
        marketId = resolved.marketId;
        question = resolved.question;
        tokenIds = resolved.tokenIds;
        marketStartUnixSec = resolved.startUnixSec ?? deriveMarketStartUnixFromSlug(slug);
        marketEndUnixSec = resolved.endUnixSec ?? deriveMarketEndUnixFromSlug(slug);
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
    const runtimes = new Map<UpDownAsset, ActiveRuntime>();
    let primaryAsset: UpDownAsset = autoMarketAsset;
    const resolveTargetAssets = (): UpDownAsset[] => {
        if (autoMarketMode === "5m") return ["btc"];
        return controls.multiMarketEnabled ? monitoredAssets : [monitoredAssets[0] ?? autoMarketAsset];
    };

    const getPrimaryRuntime = (): ActiveRuntime | null => {
        if (runtimes.has(primaryAsset)) return runtimes.get(primaryAsset)!;
        const first = runtimes.values().next();
        return first.done ? null : first.value;
    };

    const applyControlsToActive = () => {
        for (const rt of runtimes.values()) {
            const effectiveTradingEnabled = controls.tradingEnabled && !!controls.assetsEnabled[rt.asset] && !cooldownActiveThisMarket;
            rt.engine.setTradingEnabled(effectiveTradingEnabled);
        }
    };

    const finalizeRuntime = (rt: ActiveRuntime) => {
        const snap = rt.engine.getSnapshot();
        const pos = Number(snap?.currentYesPosition ?? 0) + Number((snap as any)?.currentNoPosition ?? 0);
        const netAfterFees = Number(snap?.pnl?.netAfterFeesSessionUsdc ?? NaN);
        lastMarketNetAfterFeesUsdc = Number.isFinite(netAfterFees) ? netAfterFees : null;
        marketLifecycle.completed += 1;
        marketLifecycle.lastFinalizedMarketId = rt.marketId;
        if (pos <= 0) {
            marketLifecycle.flatAtHandoff += 1;
        } else {
            marketLifecycle.leftoverAtHandoff += 1;
            marketLifecycle.leftoverSharesTotal += pos;
        }
        if (!controls.multiMarketEnabled && lastMarketNetAfterFeesUsdc !== null && lastMarketNetAfterFeesUsdc < 0 && lossCooldownMarketsConfigured > 0) {
            cooldownMarketsRemaining = Math.max(cooldownMarketsRemaining, lossCooldownMarketsConfigured);
            pushEvent("loss_cooldown_set", `${cooldownMarketsRemaining} market(s)`);
        }
    };

    const stopRuntime = (asset: UpDownAsset) => {
        const rt = runtimes.get(asset);
        if (!rt) return;
        finalizeRuntime(rt);
        rt.userWs.stop();
        rt.marketWs.stop();
        rt.engine.stop();
        runtimes.delete(asset);
        wsState.user.connected = runtimes.size > 0;
        wsState.market.connected = runtimes.size > 0;
    };

    const stopAllRuntimes = () => {
        for (const asset of Array.from(runtimes.keys())) stopRuntime(asset);
        wsState.user.connected = false;
        wsState.market.connected = false;
    };

    const startRuntime = (asset: UpDownAsset, target: {
        slug: string;
        marketId: string;
        question: string;
        tokenIds: string[];
        marketStartUnixSec: number | null;
        marketEndUnixSec: number | null;
    }) => {
        if (!controls.multiMarketEnabled) {
            cooldownActiveThisMarket = cooldownMarketsRemaining > 0;
            if (cooldownActiveThisMarket) {
                cooldownMarketsRemaining = Math.max(0, cooldownMarketsRemaining - 1);
                pushEvent("loss_cooldown_skip_market", `${target.marketId} (${cooldownMarketsRemaining} left after this)`);
            }
        } else {
            cooldownActiveThisMarket = false;
        }
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
                pushEvent(`user_ws_reconnect_${asset}`);
            },
            onOpen: () => {
                wsState.user.connected = true;
                pushEvent(`user_ws_open_${asset}`);
            },
            onClose: (code, reason) => {
                wsState.user.lastCloseCode = code;
                wsState.user.lastCloseReason = reason;
                pushEvent(`user_ws_close_${asset}`, `${code} ${reason}`);
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
                pushEvent(`market_ws_reconnect_${asset}`);
            },
            onOpen: () => {
                wsState.market.connected = true;
                pushEvent(`market_ws_open_${asset}`);
            },
            onClose: (code, reason) => {
                wsState.market.lastCloseCode = code;
                wsState.market.lastCloseReason = reason;
                pushEvent(`market_ws_close_${asset}`, `${code} ${reason}`);
            },
        });

        runtimes.set(asset, {
            asset,
            slug: target.slug,
            marketId: target.marketId,
            question: target.question,
            tokenIds: target.tokenIds,
            marketStartUnixSec: target.marketStartUnixSec,
            marketEndUnixSec: target.marketEndUnixSec,
            engine,
            userWs,
            marketWs,
        });
        primaryAsset = asset;
        applyControlsToActive();

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
            for (const rt of runtimes.values()) {
                rt.engine.updateSpotSignal({
                    spotMoveBps: spotMove === null ? null : spotMove * 10000,
                    updatedAt: Date.now(),
                    connected: true,
                });
            }
        },
    });
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
        onSetControls: async (patch) => {
            if (typeof patch.tradingEnabled === "boolean") {
                controls.tradingEnabled = patch.tradingEnabled;
                pushEvent("control_trading_enabled", String(controls.tradingEnabled));
            }
            if (typeof (patch as any).multiMarketEnabled === "boolean") {
                controls.multiMarketEnabled = Boolean((patch as any).multiMarketEnabled);
                pushEvent("control_multi_market", String(controls.multiMarketEnabled));
            }
            const assetsPatch = (patch as any).assetsEnabled;
            if (assetsPatch && typeof assetsPatch === "object") {
                for (const a of Object.keys(controls.assetsEnabled) as UpDownAsset[]) {
                    if (typeof assetsPatch[a] === "boolean") controls.assetsEnabled[a] = assetsPatch[a];
                }
                pushEvent("control_assets", JSON.stringify(controls.assetsEnabled));
            }
            applyControlsToActive();
            const effectiveTradingEnabled = controls.tradingEnabled && !cooldownActiveThisMarket;
            return {
                ok: true,
                controls: {
                    ...controls,
                    effectiveTradingEnabled,
                    cooldownActiveThisMarket,
                    cooldownMarketsRemaining,
                    lossCooldownMarketsConfigured,
                },
            };
        },
        getState: () => ({
            ...(function () {
                const primary = getPrimaryRuntime();
                const engine = primary?.engine.getSnapshot() ?? null;
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
                const markets = Array.from(runtimes.values()).map((rt) => ({
                    asset: rt.asset,
                    slug: rt.slug,
                    marketId: rt.marketId,
                    question: rt.question,
                    tokenIds: rt.tokenIds,
                    engine: rt.engine.getSnapshot(),
                }));
                return {
                    engine,
                    markets,
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
            marketLifecycle: {
                ...marketLifecycle,
                flatRatePct: marketLifecycle.completed > 0
                    ? (marketLifecycle.flatAtHandoff / marketLifecycle.completed) * 100
                    : null,
            },
            config: {
                dryRun: env.DRY_RUN,
                signalK: Number(process.env.SIGNAL_K ?? "60"),
                tradingEnabled: controls.tradingEnabled && !cooldownActiveThisMarket,
                configuredTradingEnabled: env.TRADING_ENABLED,
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
            controls: {
                ...controls,
                effectiveTradingEnabled: controls.tradingEnabled && !cooldownActiveThisMarket,
                cooldownActiveThisMarket,
                cooldownMarketsRemaining,
                lossCooldownMarketsConfigured,
            },
            performance: {
                lastMarketNetAfterFeesUsdc,
            },
            market: (() => {
                const p = getPrimaryRuntime();
                return p
                    ? { slug: p.slug, marketId: p.marketId, question: p.question, tokenIds: p.tokenIds, asset: p.asset }
                    : { slug, marketId, question, tokenIds, asset: primaryAsset };
            })(),
            ws: wsState,
            events: recentEvents,
        }),
    });

    async function reconcileLatestRuntimes() {
        const targetAssets = resolveTargetAssets();
        const targetSet = new Set<UpDownAsset>(targetAssets);
        for (const a of Array.from(runtimes.keys())) {
            if (!targetSet.has(a)) stopRuntime(a);
        }

        for (const a of targetAssets) {
            const latest = await resolveLatestAutoMarket(a);
            const rt = runtimes.get(a);
            if (rt && rt.marketId === latest.marketId) continue;
            if (rt) {
                pushEvent("market_rollover", `${rt.marketId} -> ${latest.marketId}`);
                stopRuntime(a);
            }
            if (!runtimes.size) {
                slug = latest.slug;
                marketId = latest.marketId;
                question = latest.question;
                tokenIds = latest.tokenIds;
                marketStartUnixSec = latest.startUnixSec ?? deriveMarketStartUnixFromSlug(slug);
                marketEndUnixSec = latest.endUnixSec ?? deriveMarketEndUnixFromSlug(slug);
            }
            startRuntime(a, {
                slug: latest.slug,
                marketId: latest.marketId,
                question: latest.question,
                tokenIds: latest.tokenIds,
                marketStartUnixSec: latest.startUnixSec ?? deriveMarketStartUnixFromSlug(latest.slug),
                marketEndUnixSec: latest.endUnixSec ?? deriveMarketEndUnixFromSlug(latest.slug),
            });
        }
    }

    if (useLatest) {
        await reconcileLatestRuntimes();
    } else {
        startRuntime(autoMarketAsset, {
            slug,
            marketId,
            question,
            tokenIds,
            marketStartUnixSec,
            marketEndUnixSec,
        });
    }
    spotFeed.start();

    const rolloverCheckMsRaw = Number(process.env.MARKET_ROLLOVER_CHECK_MS ?? "15000");
    const rolloverCheckMs = Number.isFinite(rolloverCheckMsRaw) ? Math.max(5000, Math.floor(rolloverCheckMsRaw)) : 15000;
    let rolloverTimer: NodeJS.Timeout | null = null;

    const maybeRolloverMarket = async () => {
        if (!useLatest) return;
        try {
            await reconcileLatestRuntimes();
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
        stopAllRuntimes();
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
