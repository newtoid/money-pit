import "dotenv/config";
import { loadReadOnlyVenueConfig } from "../config/readOnlyVenue";
import { createPolymarketReadOnlyTransport, fetchAndNormalizeReadOnlyVenueData } from "../adapters/readOnlyVenue";
import { logger } from "../logger";

async function main() {
    const config = loadReadOnlyVenueConfig();
    logger.info({
        msg: "starting read-only venue probe",
        source: config.readOnlyLogLabel,
        enabled: config.enabled,
        mode: config.mode,
        liveExecutionEnabled: config.liveExecutionEnabled,
        executionKillSwitch: config.executionKillSwitch,
        fetchOpenOrders: config.fetchOpenOrders,
        fetchTrades: config.fetchTrades,
        fetchAccountBalances: config.fetchAccountBalances,
    });

    if (!config.enabled) {
        logger.info({
            msg: "read-only venue probe disabled via READ_ONLY_VENUE_ENABLED=false",
            source: config.readOnlyLogLabel,
        });
        return;
    }

    const transport = createPolymarketReadOnlyTransport(config);
    const result = await fetchAndNormalizeReadOnlyVenueData({
        config,
        transport,
    });

    logger.info({
        msg: "read-only venue probe completed",
        source: config.readOnlyLogLabel,
        summary: result.summary,
        executionSnapshotAccepted: result.executionSnapshotNormalization?.accepted ?? null,
        accountSnapshotAccepted: result.accountSnapshotNormalization?.accepted ?? null,
    });
}

main().catch((error) => {
    logger.error({
        msg: "read-only venue probe failed",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
});
