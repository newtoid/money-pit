import { logger } from "../logger";
import { loadArbScannerConfig } from "../arbScanner/config";
import { discoverBinaryMarkets } from "../arbScanner/marketDiscovery";
import { LiveBookTracker } from "../arbScanner/bookTracker";
import { OpportunityScanner } from "../arbScanner/opportunityScanner";
import { ArbRecorder } from "../arbScanner/recorder";
import { ExecutionSimulator, buildExecutionSimConfig } from "../arbScanner/executionSimulator";
import { PaperTrader } from "../arbScanner/paperTrader";
import { SettlementSource } from "../core/settlementSource";
import { ResolutionPoller } from "../arbScanner/resolutionPoller";

async function main() {
    const config = loadArbScannerConfig();
    const settlementSource = new SettlementSource({
        mode: "placeholder_end_time_full_set_assumption",
        allowPlaceholderFallback: config.settlementAllowPlaceholderFallback,
    });
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
            paperSummaryIntervalMs: config.paperSummaryIntervalMs,
            strandedDamageReportingWindowMs: config.strandedDamageReportingWindowMs,
            openPositionAgeThresholdsMs: config.openPositionAgeThresholdsMs,
            paperMaxTradesPerMarket: config.paperMaxTradesPerMarket,
            killSwitchEnabled: config.killSwitchEnabled,
            riskMaxNotionalPerTrade: config.riskMaxNotionalPerTrade,
            riskMaxConcurrentExposure: config.riskMaxConcurrentExposure,
            riskPerMarketExposureCap: config.riskPerMarketExposureCap,
            riskNoTradeBeforeResolutionSec: config.riskNoTradeBeforeResolutionSec,
            riskMaxDailyLoss: config.riskMaxDailyLoss,
            riskDayUtcOffset: config.riskDayUtcOffset,
            settlementModeUsed: settlementSource.describeSelectionMode(),
            settlementAllowPlaceholderFallback: config.settlementAllowPlaceholderFallback,
            resolutionPollingEnabled: config.resolutionPollingEnabled,
            resolutionPollIntervalMs: config.resolutionPollIntervalMs,
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
        paperSummaryIntervalMs: config.paperSummaryIntervalMs,
        strandedDamageReportingWindowMs: config.strandedDamageReportingWindowMs,
        openPositionAgeThresholdsMs: config.openPositionAgeThresholdsMs,
        paperMaxTradesPerMarket: config.paperMaxTradesPerMarket,
        killSwitchEnabled: config.killSwitchEnabled,
        riskMaxNotionalPerTrade: config.riskMaxNotionalPerTrade,
        riskMaxConcurrentExposure: config.riskMaxConcurrentExposure,
        riskPerMarketExposureCap: config.riskPerMarketExposureCap,
        riskNoTradeBeforeResolutionSec: config.riskNoTradeBeforeResolutionSec,
        riskMaxDailyLoss: config.riskMaxDailyLoss,
        riskDayUtcOffset: config.riskDayUtcOffset,
        settlementModeUsed: settlementSource.describeSelectionMode(),
        settlementAllowPlaceholderFallback: config.settlementAllowPlaceholderFallback,
        resolutionPollingEnabled: config.resolutionPollingEnabled,
        resolutionPollIntervalMs: config.resolutionPollIntervalMs,
    });
    recorder.recordMarkets(markets);

    const simulator = new ExecutionSimulator(buildExecutionSimConfig(config));
    const paperTrader = new PaperTrader(simulator, config, {
        maxTradesPerMarket: config.paperMaxTradesPerMarket,
        recorder,
        emitLogs: true,
        settlementSource,
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
    const resolutionPoller = new ResolutionPoller({
        markets,
        config,
        onResolutionEvent: (event) => {
            recorder.recordResolutionEvent(event);
            paperTrader.recordResolutionEvent(event);
        },
    });

    liveTracker.start();
    resolutionPoller.start();

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
                dailyRealizedPnl: state.dailyRealizedPnl,
                maxDrawdown: state.maxDrawdown,
                grossOpenNotional: state.grossOpenNotional,
                releasedExposure: state.releasedExposure,
                denialCounts: state.denialCounts,
                dailyLossDenials: state.dailyLossDenials,
                firstDailyLossBlockAt: state.firstDailyLossBlockAt,
                settlementModeUsed: state.settlementModeUsed,
                recordedExplicitResolutionEvents: state.recordedExplicitResolutionEvents,
                resolutionEventProvenanceBreakdown: state.resolutionEventProvenanceBreakdown,
                trustworthyResolutionEvents: state.trustworthyResolutionEvents,
                untrustworthyResolutionEvents: state.untrustworthyResolutionEvents,
                dayRollover: state.dayRollover,
                unresolvedAging: state.unresolvedAging,
                settlementCoverage: state.settlementCoverage,
                executionDamage: state.executionDamage,
                executionStateSummary: state.executionStateSummary,
                strandedDamageRecords: state.strandedDamageRecords.length,
                positionsResolvedByExplicitResolutionEvent: state.positionsResolvedByExplicitResolutionEvent,
                positionsResolvedByPlaceholderAssumption: state.positionsResolvedByPlaceholderAssumption,
                unresolvedPositions: state.unresolvedPositions,
                unresolvedLockedExposure: state.unresolvedLockedExposure,
                positionsMissingTrustworthySettlementData: state.positionsMissingTrustworthySettlementData,
                lockedExposureMissingTrustworthySettlementData: state.lockedExposureMissingTrustworthySettlementData,
            },
            "Stopping paper arbitrage trader",
        );
        liveTracker.stop();
        resolutionPoller.stop();
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
