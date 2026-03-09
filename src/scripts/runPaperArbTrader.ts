import { logger } from "../logger";
import { loadArbScannerConfig } from "../arbScanner/config";
import { discoverBinaryMarkets } from "../arbScanner/marketDiscovery";
import { LiveBookTracker } from "../arbScanner/bookTracker";
import { OpportunityScanner } from "../arbScanner/opportunityScanner";
import { ArbRecorder } from "../arbScanner/recorder";
import { ExecutionSimulator, buildExecutionSimConfig } from "../arbScanner/executionSimulator";
import { PaperTrader } from "../arbScanner/paperTrader";

async function main() {
    const config = loadArbScannerConfig();
    logger.info(
        {
            maxMarkets: config.maxMarkets,
            minEdge: config.minEdge,
            costBuffer: config.costBuffer,
            quoteStaleMs: config.quoteStaleMs,
            recorderEnabled: config.recorderEnabled,
            tradeSize: config.tradeSize,
            simSlippagePerLeg: config.simSlippagePerLeg,
            simPartialFillRatio: config.simPartialFillRatio,
            simRequireFullFill: config.simRequireFullFill,
            simRequireKnownSize: config.simRequireKnownSize,
            paperMaxTradesPerMarket: config.paperMaxTradesPerMarket,
            killSwitchEnabled: config.killSwitchEnabled,
            riskMaxNotionalPerTrade: config.riskMaxNotionalPerTrade,
            riskMaxConcurrentExposure: config.riskMaxConcurrentExposure,
            riskPerMarketExposureCap: config.riskPerMarketExposureCap,
            riskNoTradeBeforeResolutionSec: config.riskNoTradeBeforeResolutionSec,
        },
        "Starting paper arbitrage trader",
    );

    const markets = await discoverBinaryMarkets(config);
    if (markets.length === 0) {
        logger.warn("No markets matched the configured paper trader filters");
        return;
    }

    const recorder = new ArbRecorder({
        enabled: config.recorderEnabled,
        dir: config.recorderDir,
        sessionName: "arb-paper",
    });
    recorder.recordSessionStart("paper", {
        maxMarkets: config.maxMarkets,
        minEdge: config.minEdge,
        costBuffer: config.costBuffer,
        quoteStaleMs: config.quoteStaleMs,
        tradeSize: config.tradeSize,
        simSlippagePerLeg: config.simSlippagePerLeg,
        simPartialFillRatio: config.simPartialFillRatio,
        simRequireFullFill: config.simRequireFullFill,
        simRequireKnownSize: config.simRequireKnownSize,
        paperMaxTradesPerMarket: config.paperMaxTradesPerMarket,
        killSwitchEnabled: config.killSwitchEnabled,
        riskMaxNotionalPerTrade: config.riskMaxNotionalPerTrade,
        riskMaxConcurrentExposure: config.riskMaxConcurrentExposure,
        riskPerMarketExposureCap: config.riskPerMarketExposureCap,
        riskNoTradeBeforeResolutionSec: config.riskNoTradeBeforeResolutionSec,
    });
    recorder.recordMarkets(markets);

    const simulator = new ExecutionSimulator(buildExecutionSimConfig(config));
    const paperTrader = new PaperTrader(simulator, config, {
        maxTradesPerMarket: config.paperMaxTradesPerMarket,
        recorder,
        emitLogs: true,
    });

    let scanner: OpportunityScanner | null = null;
    const liveTracker = new LiveBookTracker({
        markets,
        onBookChange: (tokenId, top) => {
            recorder.recordBookTop(tokenId, top);
            scanner?.onBookChange(tokenId);
        },
        onRawMessage: (message, ts) => {
            recorder.recordWsMessage(message, ts);
            paperTrader.advanceTime(ts);
        },
    });
    scanner = new OpportunityScanner(markets, liveTracker, config, {
        onOpportunity: (opportunity) => {
            recorder.recordOpportunity(opportunity);
            paperTrader.handleOpportunity(opportunity);
        },
    });

    liveTracker.start();

    const shutdown = () => {
        const state = paperTrader.getState();
        logger.info(
            {
                tradeAttempts: state.tradeAttempts,
                positionOpens: state.positionOpens,
                positionsResolved: state.positionsResolved,
                wins: state.wins,
                losses: state.losses,
                averageEdge: state.averageEdge,
                realizedPnl: state.realizedPnl,
                maxDrawdown: state.maxDrawdown,
                grossOpenNotional: state.grossOpenNotional,
                releasedExposure: state.releasedExposure,
                denialCounts: state.denialCounts,
            },
            "Stopping paper arbitrage trader",
        );
        liveTracker.stop();
        recorder.stop();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    logger.error({ err }, "Paper arbitrage trader failed");
    process.exit(1);
});
