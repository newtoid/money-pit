import fs from "node:fs";
import path from "node:path";

type BookSide = {
    bid: number;
    ask: number;
};

type Snapshot = {
    ts: number;
    spotPrice: number;
    yes: BookSide;
    no: BookSide;
};

type Trade = {
    entryTs: number;
    exitTs: number;
    entryPrice: number;
    exitPrice: number;
    size: number;
    grossPnlUsdc: number;
    feesUsdc: number;
    netPnlUsdc: number;
    holdSec: number;
    entryLagBps: number;
    exitReason: string;
};

type BacktestConfig = {
    tickSize: number;
    signalK: number;
    lagEnterBps: number;
    lagExitBps: number;
    lagDisableBeforeEndSec: number;
    buyWindowSec: number;
    buyMinLagBps: number;
    entryEstimatedRoundTripCostBps: number;
    entryExtraEdgeBufferBps: number;
    entryMaxYesSpreadBps: number;
    entryMaxYesSpreadTicks: number;
    buyNoChaseWindowMs: number;
    buyNoChaseMaxUpBps: number;
    orderSize: number;
    maxPosition: number;
    maxInventoryNotionalUsdc: number;
    takeProfitPct: number;
    hardTakeProfitPct: number;
    exitMinProfitTicks: number;
    exitCatchupBufferBps: number;
    exitAllowProfitBeforeCatchup: boolean;
    exitForceAfterHoldSec: number;
    exitAllowLossOnlyLastSec: number;
    forceFlattenBeforeEndSec: number;
    forceFlattenHardDeadlineSec: number;
    forceFlattenAllowLoss: boolean;
    estimatedFeeBps: number;
    marketDurationSec: number;
};

type OpenPosition = {
    entryTs: number;
    entryPrice: number;
    size: number;
    entrySpotMoveTargetBps: number | null;
    entryLagBps: number;
};

type ParsedArgs = {
    inputPath: string;
    config: BacktestConfig;
};

type RawRecord = Record<string, unknown>;

function getEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
}

function getEnvBool(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined || raw === null || raw === "") return fallback;
    const normalized = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
    return fallback;
}

function clampPrice(price: number) {
    return Math.max(0.001, Math.min(0.999, price));
}

function clampToTickBounds(price: number, tick: number) {
    return Math.max(tick, Math.min(1 - tick, price));
}

function roundDownToTick(price: number, tick: number) {
    return Math.floor(price / tick) * tick;
}

function roundUpToTick(price: number, tick: number) {
    return Math.ceil(price / tick) * tick;
}

function fairYesFromBooks(yes: BookSide, no: BookSide) {
    const yesMid = (yes.bid + yes.ask) / 2;
    const noMid = (no.bid + no.ask) / 2;
    return clampPrice((yesMid + (1 - noMid)) / 2);
}

function parseArgValue(args: string[], name: string): string | null {
    const direct = args.find((arg) => arg.startsWith(`${name}=`));
    if (direct) return direct.slice(name.length + 1);
    const index = args.indexOf(name);
    if (index >= 0 && index + 1 < args.length) return args[index + 1] ?? null;
    return null;
}

function requireNumber(value: unknown, field: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid numeric field: ${field}`);
    }
    return parsed;
}

function parseBookSide(record: RawRecord, prefix: "yes" | "no"): BookSide {
    const nested = record[prefix];
    if (nested && typeof nested === "object") {
        const side = nested as RawRecord;
        return {
            bid: requireNumber(side.bid, `${prefix}.bid`),
            ask: requireNumber(side.ask, `${prefix}.ask`),
        };
    }
    return {
        bid: requireNumber(record[`${prefix}Bid`], `${prefix}Bid`),
        ask: requireNumber(record[`${prefix}Ask`], `${prefix}Ask`),
    };
}

function parseSnapshot(line: string, lineNo: number): Snapshot {
    let parsed: RawRecord;
    try {
        parsed = JSON.parse(line) as RawRecord;
    } catch (err) {
        throw new Error(`Line ${lineNo}: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
    }

    const ts = requireNumber(parsed.ts ?? parsed.at ?? parsed.timestamp, "ts");
    const spotPrice = requireNumber(parsed.spotPrice ?? parsed.spot ?? parsed.btcPrice, "spotPrice");
    const yes = parseBookSide(parsed, "yes");
    const no = parseBookSide(parsed, "no");

    return { ts, spotPrice, yes, no };
}

function parseArgs(argv: string[]): ParsedArgs {
    const inputPath = parseArgValue(argv, "--input") ?? parseArgValue(argv, "-i");
    if (!inputPath) {
        throw new Error("Missing required --input path to a JSONL snapshot file");
    }

    const config: BacktestConfig = {
        tickSize: getEnvNumber("TICK_SIZE", 0.01),
        signalK: getEnvNumber("SIGNAL_K", 60),
        lagEnterBps: getEnvNumber("LAG_ENTER_BPS", 4),
        lagExitBps: getEnvNumber("LAG_EXIT_BPS", 2),
        lagDisableBeforeEndSec: Math.max(0, getEnvNumber("LAG_DISABLE_BEFORE_END_SEC", 35)),
        buyWindowSec: Math.max(0, getEnvNumber("BUY_WINDOW_SEC", 180)),
        buyMinLagBps: Math.max(0, getEnvNumber("BUY_MIN_LAG_BPS", 6)),
        entryEstimatedRoundTripCostBps: Math.max(0, getEnvNumber("ENTRY_ESTIMATED_ROUNDTRIP_COST_BPS", 12)),
        entryExtraEdgeBufferBps: Math.max(0, getEnvNumber("ENTRY_EXTRA_EDGE_BUFFER_BPS", 2)),
        entryMaxYesSpreadBps: Math.max(0, getEnvNumber("ENTRY_MAX_YES_SPREAD_BPS", 80)),
        entryMaxYesSpreadTicks: Math.max(0, getEnvNumber("ENTRY_MAX_YES_SPREAD_TICKS", 0)),
        buyNoChaseWindowMs: Math.max(0, getEnvNumber("BUY_NO_CHASE_WINDOW_MS", 4000)),
        buyNoChaseMaxUpBps: Math.max(0, getEnvNumber("BUY_NO_CHASE_MAX_UP_BPS", 8)),
        orderSize: Math.max(0, getEnvNumber("ORDER_SIZE", 5)),
        maxPosition: Math.max(0, getEnvNumber("MAX_POSITION", 100)),
        maxInventoryNotionalUsdc: Math.max(0, getEnvNumber("MAX_INVENTORY_NOTIONAL_USDC", 20)),
        takeProfitPct: Math.max(0, getEnvNumber("TAKE_PROFIT_PCT", 0.01)),
        hardTakeProfitPct: Math.max(0, getEnvNumber("HARD_TAKE_PROFIT_PCT", 0.5)),
        exitMinProfitTicks: Math.max(0, getEnvNumber("EXIT_MIN_PROFIT_TICKS", 1)),
        exitCatchupBufferBps: Math.max(0, getEnvNumber("EXIT_CATCHUP_BUFFER_BPS", 0)),
        exitAllowProfitBeforeCatchup: getEnvBool("EXIT_ALLOW_PROFIT_BEFORE_CATCHUP", true),
        exitForceAfterHoldSec: Math.max(0, getEnvNumber("EXIT_FORCE_AFTER_HOLD_SEC", 20)),
        exitAllowLossOnlyLastSec: Math.max(0, getEnvNumber("EXIT_ALLOW_LOSS_ONLY_LAST_SEC", 300)),
        forceFlattenBeforeEndSec: Math.max(0, getEnvNumber("FORCE_FLATTEN_BEFORE_END_SEC", 40)),
        forceFlattenHardDeadlineSec: Math.max(0, getEnvNumber("FORCE_FLATTEN_HARD_DEADLINE_SEC", 5)),
        forceFlattenAllowLoss: getEnvBool("FORCE_FLATTEN_ALLOW_LOSS", false),
        estimatedFeeBps: Math.max(0, getEnvNumber("ESTIMATED_FEE_BPS", 100)),
        marketDurationSec: Math.max(60, getEnvNumber("MARKET_DURATION_SEC", 300)),
    };

    const durationOverride = parseArgValue(argv, "--market-duration-sec");
    if (durationOverride !== null) config.marketDurationSec = Math.max(60, Number(durationOverride));

    return {
        inputPath: path.resolve(process.cwd(), inputPath),
        config,
    };
}

function loadSnapshots(filePath: string): Snapshot[] {
    const raw = fs.readFileSync(filePath, "utf8");
    const snapshots = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line, index) => parseSnapshot(line, index + 1))
        .sort((a, b) => a.ts - b.ts);

    if (snapshots.length < 2) {
        throw new Error("Need at least 2 snapshots for a replay");
    }
    return snapshots;
}

function computeLagBps(fairYes: number, spotMoveBps: number, signalK: number) {
    const polyImpliedMoveBps = ((fairYes - 0.5) / signalK) * 10000;
    return spotMoveBps - polyImpliedMoveBps;
}

function computeTradeFeeUsdc(notionalUsdc: number, estimatedFeeBps: number) {
    return notionalUsdc * (estimatedFeeBps / 10000);
}

function summarizeTrades(trades: Trade[]) {
    const totalNet = trades.reduce((sum, trade) => sum + trade.netPnlUsdc, 0);
    const totalGross = trades.reduce((sum, trade) => sum + trade.grossPnlUsdc, 0);
    const totalFees = trades.reduce((sum, trade) => sum + trade.feesUsdc, 0);
    const winners = trades.filter((trade) => trade.netPnlUsdc > 0).length;
    const losers = trades.filter((trade) => trade.netPnlUsdc < 0).length;
    const avgHoldSec = trades.length > 0
        ? trades.reduce((sum, trade) => sum + trade.holdSec, 0) / trades.length
        : 0;
    const avgEntryLagBps = trades.length > 0
        ? trades.reduce((sum, trade) => sum + trade.entryLagBps, 0) / trades.length
        : 0;

    return {
        trades: trades.length,
        winners,
        losers,
        winRatePct: trades.length > 0 ? (winners / trades.length) * 100 : 0,
        grossPnlUsdc: totalGross,
        feesUsdc: totalFees,
        netPnlUsdc: totalNet,
        avgNetPerTradeUsdc: trades.length > 0 ? totalNet / trades.length : 0,
        avgHoldSec,
        avgEntryLagBps,
    };
}

function runBacktest(snapshots: Snapshot[], config: BacktestConfig) {
    const firstTs = snapshots[0]!.ts;
    const marketEndTs = firstTs + (config.marketDurationSec * 1000);
    const openSpot = snapshots[0]!.spotPrice;
    const fairHistory: Array<{ ts: number; fairYes: number }> = [];
    const trades: Trade[] = [];
    let lagRegime: -1 | 0 | 1 = 0;
    let position: OpenPosition | null = null;
    let skippedNoChase = 0;
    let skippedSpread = 0;
    let skippedLag = 0;
    let skippedWindow = 0;

    for (const snapshot of snapshots) {
        const fairYes = fairYesFromBooks(snapshot.yes, snapshot.no);
        fairHistory.push({ ts: snapshot.ts, fairYes });
        while (fairHistory.length > 0 && snapshot.ts - fairHistory[0]!.ts > config.buyNoChaseWindowMs) {
            fairHistory.shift();
        }

        const secondsSinceStart = Math.floor((snapshot.ts - firstTs) / 1000);
        const secondsToEnd = Math.floor((marketEndTs - snapshot.ts) / 1000);
        const spotMoveBps = ((snapshot.spotPrice - openSpot) / openSpot) * 10000;
        const lagBps = computeLagBps(fairYes, spotMoveBps, config.signalK);

        if (secondsToEnd <= config.lagDisableBeforeEndSec) {
            lagRegime = 0;
        } else if (lagBps >= config.lagEnterBps) {
            lagRegime = 1;
        } else if (lagBps <= -config.lagEnterBps) {
            lagRegime = -1;
        } else if (lagRegime === 1 && lagBps <= config.lagExitBps) {
            lagRegime = 0;
        } else if (lagRegime === -1 && lagBps >= -config.lagExitBps) {
            lagRegime = 0;
        }

        const bestBid = snapshot.yes.bid;
        const bestAsk = snapshot.yes.ask;
        const yesSpread = bestAsk - bestBid;
        const yesMid = (bestAsk + bestBid) / 2;
        const yesSpreadBps = yesMid > 0 ? (yesSpread / yesMid) * 10000 : null;
        const yesSpreadTicks = config.tickSize > 0 ? yesSpread / config.tickSize : null;
        const spreadTooWide = (
            (config.entryMaxYesSpreadBps > 0 && yesSpreadBps !== null && yesSpreadBps > config.entryMaxYesSpreadBps)
            || (config.entryMaxYesSpreadTicks > 0 && yesSpreadTicks !== null && yesSpreadTicks > config.entryMaxYesSpreadTicks)
        );

        let noChaseActive = false;
        const oldestFair = fairHistory[0];
        if (oldestFair && config.buyNoChaseWindowMs > 0) {
            const jumpBps = ((fairYes - oldestFair.fairYes) / Math.max(oldestFair.fairYes, 0.0001)) * 10000;
            noChaseActive = jumpBps >= config.buyNoChaseMaxUpBps;
        }

        if (position) {
            const minProfitTarget = clampToTickBounds(
                roundUpToTick(position.entryPrice + (config.exitMinProfitTicks * config.tickSize), config.tickSize),
                config.tickSize,
            );
            const hardTarget = position.entryPrice * (1 + config.hardTakeProfitPct);
            const softTarget = position.entryPrice * (1 + config.takeProfitPct);
            const holdSec = Math.max(0, Math.floor((snapshot.ts - position.entryTs) / 1000));
            const canExitAtLoss = secondsToEnd <= config.exitAllowLossOnlyLastSec;
            let exitReason: string | null = null;
            let exitPrice = clampToTickBounds(roundDownToTick(bestBid, config.tickSize), config.tickSize);

            if (config.hardTakeProfitPct > 0 && bestBid >= hardTarget) {
                exitReason = "hard_take_profit";
            } else if (config.takeProfitPct > 0 && bestBid >= softTarget) {
                exitReason = "take_profit";
            } else if (position.entrySpotMoveTargetBps !== null) {
                const polyImpliedMoveBps = ((fairYes - 0.5) / config.signalK) * 10000;
                const catchupReached = (polyImpliedMoveBps + config.exitCatchupBufferBps) >= position.entrySpotMoveTargetBps;
                if (catchupReached && bestBid >= minProfitTarget) {
                    exitReason = "price_rise_exit";
                } else if (config.exitAllowProfitBeforeCatchup && bestBid >= minProfitTarget) {
                    exitReason = "profit_before_full_catchup";
                } else if (config.exitForceAfterHoldSec > 0 && holdSec >= config.exitForceAfterHoldSec && bestBid >= minProfitTarget) {
                    exitReason = "force_profitable_exit_after_hold";
                }
            }

            const inForceFlattenWindow = secondsToEnd <= config.forceFlattenBeforeEndSec;
            const hardDeadlineActive = secondsToEnd <= config.forceFlattenHardDeadlineSec;
            if (!exitReason && inForceFlattenWindow) {
                const candidateExit = clampToTickBounds(roundDownToTick(bestBid, config.tickSize), config.tickSize);
                if (hardDeadlineActive || config.forceFlattenAllowLoss || candidateExit >= position.entryPrice || canExitAtLoss) {
                    exitReason = hardDeadlineActive ? "force_flatten_hard_deadline" : "force_flatten";
                    exitPrice = candidateExit;
                }
            }

            if (exitReason) {
                const grossPnlUsdc = (exitPrice - position.entryPrice) * position.size;
                const feesUsdc = computeTradeFeeUsdc(position.entryPrice * position.size, config.estimatedFeeBps)
                    + computeTradeFeeUsdc(exitPrice * position.size, config.estimatedFeeBps);
                trades.push({
                    entryTs: position.entryTs,
                    exitTs: snapshot.ts,
                    entryPrice: position.entryPrice,
                    exitPrice,
                    size: position.size,
                    grossPnlUsdc,
                    feesUsdc,
                    netPnlUsdc: grossPnlUsdc - feesUsdc,
                    holdSec,
                    entryLagBps: position.entryLagBps,
                    exitReason,
                });
                position = null;
            }

            continue;
        }

        const requiredLagBps = config.buyMinLagBps + config.entryEstimatedRoundTripCostBps + config.entryExtraEdgeBufferBps;
        const buyWindowActive = secondsSinceStart >= 0 && secondsSinceStart <= config.buyWindowSec;
        if (!buyWindowActive) {
            skippedWindow += 1;
            continue;
        }
        if (lagRegime !== 1 || lagBps < requiredLagBps) {
            skippedLag += 1;
            continue;
        }
        if (spreadTooWide) {
            skippedSpread += 1;
            continue;
        }
        if (noChaseActive) {
            skippedNoChase += 1;
            continue;
        }

        const remainingByPosition = config.maxPosition;
        const remainingNotional = config.maxInventoryNotionalUsdc;
        const remainingByNotional = bestAsk > 0 ? remainingNotional / bestAsk : 0;
        const size = Math.max(0, Math.min(config.orderSize, remainingByPosition, remainingByNotional));
        if (size <= 0) continue;

        position = {
            entryTs: snapshot.ts,
            entryPrice: clampToTickBounds(roundUpToTick(bestAsk, config.tickSize), config.tickSize),
            size,
            entrySpotMoveTargetBps: spotMoveBps,
            entryLagBps: lagBps,
        };
    }

    const openPositionMarked = position ? 1 : 0;
    const summary = summarizeTrades(trades);
    return {
        summary,
        trades,
        diagnostics: {
            snapshots: snapshots.length,
            openPositionMarked,
            skippedNoChase,
            skippedSpread,
            skippedLag,
            skippedWindow,
        },
    };
}

function formatMoney(value: number) {
    return value.toFixed(4);
}

function printUsage() {
    console.log("Usage: npm run backtest -- --input path/to/snapshots.jsonl [--market-duration-sec 300]");
    console.log("Snapshot JSONL fields: ts|at, spotPrice|spot, yesBid/yesAsk, noBid/noAsk");
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return;
    }

    const { inputPath, config } = parseArgs(argv);
    const snapshots = loadSnapshots(inputPath);
    const result = runBacktest(snapshots, config);

    console.log(`Backtest file: ${inputPath}`);
    console.log(`Snapshots: ${result.diagnostics.snapshots}`);
    console.log(`Trades: ${result.summary.trades}`);
    console.log(`Winners / Losers: ${result.summary.winners} / ${result.summary.losers}`);
    console.log(`Win rate: ${result.summary.winRatePct.toFixed(2)}%`);
    console.log(`Gross PnL: ${formatMoney(result.summary.grossPnlUsdc)} USDC`);
    console.log(`Estimated fees: ${formatMoney(result.summary.feesUsdc)} USDC`);
    console.log(`Net PnL: ${formatMoney(result.summary.netPnlUsdc)} USDC`);
    console.log(`Avg net / trade: ${formatMoney(result.summary.avgNetPerTradeUsdc)} USDC`);
    console.log(`Avg hold: ${result.summary.avgHoldSec.toFixed(2)} sec`);
    console.log(`Avg entry lag: ${result.summary.avgEntryLagBps.toFixed(2)} bps`);
    console.log(`Skipped by lag: ${result.diagnostics.skippedLag}`);
    console.log(`Skipped by spread: ${result.diagnostics.skippedSpread}`);
    console.log(`Skipped by no-chase: ${result.diagnostics.skippedNoChase}`);
    console.log(`Skipped by buy window: ${result.diagnostics.skippedWindow}`);
    console.log(`Open positions left: ${result.diagnostics.openPositionMarked}`);

    if (result.trades.length > 0) {
        const lastTrade = result.trades[result.trades.length - 1]!;
        console.log(
            `Last trade: entry=${lastTrade.entryPrice.toFixed(4)} exit=${lastTrade.exitPrice.toFixed(4)} `
            + `net=${formatMoney(lastTrade.netPnlUsdc)} reason=${lastTrade.exitReason}`,
        );
    }
}

main();
