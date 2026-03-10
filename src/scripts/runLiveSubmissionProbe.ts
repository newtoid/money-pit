import { loadLiveSubmissionConfig } from "../config/liveSubmission";
import { createExecutionAdapter } from "../live/createExecutionAdapter";
import { buildExecutionRequest } from "../live/buildExecutionRequest";
import { logger } from "../logger";

async function main() {
    const liveSubmissionConfig = loadLiveSubmissionConfig();
    const executionAdapter = createExecutionAdapter({
        executionMode: "future_live_clob",
        liveExecutionEnabled: liveSubmissionConfig.liveExecutionEnabled,
        executionKillSwitch: liveSubmissionConfig.executionKillSwitch,
        liveSubmissionConfig,
    });

    logger.info({
        msg: "starting live submission probe",
        source: "live_submission_probe",
        adapterMode: executionAdapter.mode,
        configuredSafetyPosture: executionAdapter.getLiveSubmissionSummary?.()?.configuredSafetyPosture ?? null,
        liveExecutionEnabled: liveSubmissionConfig.liveExecutionEnabled,
        executionKillSwitch: liveSubmissionConfig.executionKillSwitch,
    });

    const request = buildExecutionRequest({
        executionAttemptId: `live-submission-probe-${Date.now()}`,
        source: "paper",
        createdAtMs: Date.now(),
        requestedSize: 1,
        opportunity: {
            market: {
                marketId: "probe-market",
                conditionId: null,
                slug: "probe-market",
                question: "probe",
                eventSlug: null,
                tagSlugs: [],
                tagLabels: [],
                yesTokenId: "probe-yes-token",
                noTokenId: "probe-no-token",
                tokenMappingSource: "outcomes",
                active: true,
                closed: false,
                archived: false,
                endDate: null,
                liquidityNum: null,
                volumeNum: null,
                feeRaw: null,
                feesEnabled: null,
            },
            quote: {
                yesAsk: 0.4,
                noAsk: 0.5,
                yesAskSize: 1,
                noAskSize: 1,
                quoteAgeMs: 0,
            },
            cost: {
                explicitCostBuffer: 0,
                feeCost: 0,
                totalCostBuffer: 0,
                notes: [],
            },
            totalAllIn: 0.9,
            edge: 0.1,
            observedAt: Date.now(),
        },
    });

    const result = executionAdapter.submitExecutionAttempt(request);
    logger.info({
        msg: "live submission probe complete",
        source: "live_submission_probe",
        submitStatus: result.submitStatus,
        liveSubmissionResult: result.liveSubmissionResult,
        liveSubmissionSummary: executionAdapter.getLiveSubmissionSummary?.() ?? null,
    });

    process.stdout.write(`${JSON.stringify({
        submitResult: result,
        adapterSummary: executionAdapter.reconcileExecutionState(),
    }, null, 2)}\n`);
}

main().catch((error) => {
    logger.error({
        msg: "live submission probe failed",
        source: "live_submission_probe",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
