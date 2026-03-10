import { createAuthedClobClient } from "../clobClientFactory";
import { readClobApiCredsFromEnv } from "../clobCredentials";
import { loadLiveOrderPilotConfig } from "../config/liveOrderPilot";
import { evaluateLiveSubmissionGuard } from "../live/liveSubmission";
import { createPilotTransport, runLiveOrderPilot } from "../live/liveOrderPilot";
import { logger } from "../logger";

function getArgValue(flag: string) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] ?? null;
}

function requiredArg(flag: string) {
    const value = getArgValue(flag);
    if (!value) throw new Error(`missing required arg ${flag}`);
    return value;
}

function parseNumberArg(flag: string) {
    const value = Number(requiredArg(flag));
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`invalid numeric arg ${flag}`);
    }
    return value;
}

async function main() {
    const config = loadLiveOrderPilotConfig();
    const marketId = requiredArg("--market");
    const assetId = requiredArg("--asset");
    const side = (getArgValue("--side") ?? "buy").toLowerCase();
    if (side !== "buy" && side !== "sell") {
        throw new Error("--side must be buy or sell");
    }
    const request = {
        marketId,
        assetId,
        side,
        price: parseNumberArg("--price"),
        size: parseNumberArg("--size"),
        tickSize: requiredArg("--tick-size"),
        timeInForce: "GTC" as const,
        confirmValue: getArgValue("--confirm"),
        invokedAtMs: Date.now(),
    };

    const preflightGuard = evaluateLiveSubmissionGuard({
        request: {
            executionAttemptId: `live-order-pilot-${request.invokedAtMs}`,
            correlationId: `live-order-pilot-${request.invokedAtMs}`,
            marketId: request.marketId,
            slug: request.marketId,
            legId: `live-order-pilot-${request.invokedAtMs}-single`,
            tokenId: request.assetId,
            binarySide: "yes",
            side: request.side,
            limitPrice: request.price,
            size: request.size,
            timeInForce: request.timeInForce,
            createdAtMs: request.invokedAtMs,
            source: "paper",
        },
        config: {
            liveExecutionEnabled: config.liveExecutionEnabled,
            executionKillSwitch: config.executionKillSwitch,
            liveSubmissionMode: config.liveSubmissionMode,
            allowlistedMarkets: config.allowlistedMarkets,
            allowlistedAssets: config.allowlistedAssets,
            maxOrderSize: config.maxOrderSize,
            requiredEnvironmentConfirmation: config.requiredConfirmation,
            providedEnvironmentConfirmation: request.confirmValue,
        },
        allowedModes: ["one_shot_live_pilot"],
    });

    logger.info({
        msg: "starting one-shot live order pilot",
        source: config.logLabel,
        pilotEnabled: config.enabled,
        liveExecutionEnabled: config.liveExecutionEnabled,
        executionKillSwitch: config.executionKillSwitch,
        liveSubmissionMode: config.liveSubmissionMode,
        allowlistedMarkets: config.allowlistedMarkets,
        allowlistedAssets: config.allowlistedAssets,
        maxOrderSize: config.maxOrderSize,
        absoluteMaxOrderSize: config.absoluteMaxOrderSize,
        requiredConfirmationConfigured: Boolean(config.requiredConfirmation),
        request,
        preflightGuard,
    });

    if (!config.enabled) {
        throw new Error("LIVE_ORDER_PILOT_ENABLED must be true for manual live pilot submission");
    }

    let transport;
    if (preflightGuard.allow && config.maxOrderSize <= config.absoluteMaxOrderSize) {
        const creds = readClobApiCredsFromEnv();
        if (!creds) {
            throw new Error("live order pilot requires explicit CLOB API credentials in env");
        }
        const client = createAuthedClobClient(creds);
        if (!client) {
            throw new Error("failed to build authenticated CLOB client for live order pilot");
        }
        transport = createPilotTransport(client);
    } else {
        transport = {
            createAndPostOrder: async () => {
                throw new Error("guard denied before live pilot transport creation");
            },
        };
    }

    const result = await runLiveOrderPilot({
        config,
        request,
        transport,
    });

    logger.info({
        msg: "one-shot live order pilot complete",
        source: config.logLabel,
        terminalState: result.terminalState,
        requestSent: result.requestSent,
        denied: result.denied,
        submittedAtMs: result.submittedAtMs,
        externalOrderId: result.venueAck?.externalOrderId ?? null,
        followUp: result.followUp,
        resultOutputPath: result.resultOutputPath,
        internalOrderBaselinePath: result.internalOrderBaselinePath,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    logger.error({
        msg: "one-shot live order pilot failed",
        source: "live_order_pilot",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
