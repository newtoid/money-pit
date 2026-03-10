import { logger } from "../logger";
import { loadArbScannerConfig } from "../arbScanner/config";
import { discoverBinaryMarkets } from "../arbScanner/marketDiscovery";
import { LiveBookTracker } from "../arbScanner/bookTracker";
import { OpportunityScanner } from "../arbScanner/opportunityScanner";
import { ArbRecorder } from "../arbScanner/recorder";
import { ResolutionPoller } from "../arbScanner/resolutionPoller";

async function main() {
    const config = loadArbScannerConfig();
    logger.info(
        {
            maxMarkets: config.maxMarkets,
            minEdge: config.minEdge,
            costBuffer: config.costBuffer,
            quoteStaleMs: config.quoteStaleMs,
            marketSlugFilter: config.marketSlugFilter,
            eventSlugFilter: config.eventSlugFilter,
            tagFilter: config.tagFilter,
            watchlistSize: config.watchlistSlugs.size,
            feeCostOverride: config.feeCostOverride,
            recorderEnabled: config.recorderEnabled,
            resolutionPollingEnabled: config.resolutionPollingEnabled,
            resolutionPollIntervalMs: config.resolutionPollIntervalMs,
        },
        "Starting read-only Polymarket arbitrage scanner",
    );

    const markets = await discoverBinaryMarkets(config);
    if (markets.length === 0) {
        logger.warn("No markets matched the configured scanner filters");
        return;
    }

    const recorder = new ArbRecorder({
        enabled: config.recorderEnabled,
        dir: config.recorderDir,
        sessionName: "arb-scan",
    });
    recorder.recordSessionStart("scan", {
        maxMarkets: config.maxMarkets,
        minEdge: config.minEdge,
        costBuffer: config.costBuffer,
        quoteStaleMs: config.quoteStaleMs,
        tradeSize: config.tradeSize,
        resolutionPollingEnabled: config.resolutionPollingEnabled,
        resolutionPollIntervalMs: config.resolutionPollIntervalMs,
    });
    recorder.recordMarkets(markets);

    let scanner: OpportunityScanner | null = null;
    const liveTracker = new LiveBookTracker({
        markets,
        onBookChange: (tokenId, top) => {
            recorder.recordBookTop(tokenId, top);
            scanner?.onBookChange(tokenId);
        },
        onRawMessage: (message, ts) => recorder.recordWsMessage(message, ts),
    });
    scanner = new OpportunityScanner(markets, liveTracker, config, {
        onOpportunity: (opportunity) => recorder.recordOpportunity(opportunity),
    });
    const resolutionPoller = new ResolutionPoller({
        markets,
        config,
        onResolutionEvent: (event) => recorder.recordResolutionEvent(event),
    });

    liveTracker.start();
    resolutionPoller.start();

    const shutdown = () => {
        logger.info("Stopping Polymarket arbitrage scanner");
        liveTracker.stop();
        resolutionPoller.stop();
        recorder.stop();
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    logger.error({ err }, "Arbitrage scanner failed");
    process.exit(1);
});
