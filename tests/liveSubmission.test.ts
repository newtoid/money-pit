import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createExecutionAdapter } from "../src/live/createExecutionAdapter";
import { buildExecutionRequest } from "../src/live/buildExecutionRequest";
import { Opportunity } from "../src/arbScanner/types";
import { buildLiveOrderSubmissionRequests, evaluateLiveSubmissionGuard } from "../src/live/liveSubmission";

function sampleOpportunity(): Opportunity {
    return {
        market: {
            marketId: "m1",
            conditionId: null,
            slug: "sample-market",
            question: "sample",
            eventSlug: null,
            tagSlugs: [],
            tagLabels: [],
            yesTokenId: "yes-1",
            noTokenId: "no-1",
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
            noAsk: 0.4,
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
        totalAllIn: 0.8,
        edge: 0.2,
        observedAt: 1000,
    };
}

test("live submission guards deny by default with explicit machine-readable reasons", () => {
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-live-1",
        source: "paper",
        opportunity: sampleOpportunity(),
        requestedSize: 2,
        createdAtMs: 1000,
    });
    const liveRequest = buildLiveOrderSubmissionRequests(request)[0];
    const guard = evaluateLiveSubmissionGuard({
        request: liveRequest,
        config: {
            liveExecutionEnabled: false,
            executionKillSwitch: true,
            liveSubmissionMode: "disabled",
            allowlistedMarkets: [],
            allowlistedAssets: [],
            maxOrderSize: 0,
            requiredEnvironmentConfirmation: "CONFIRM",
            providedEnvironmentConfirmation: null,
        },
    });
    assert.equal(guard.allow, false);
    assert.deepEqual(guard.reasonCodes, [
        "live_execution_disabled",
        "execution_kill_switch_enabled",
        "live_submission_mode_not_selected",
        "max_order_size_cap_missing",
        "environment_confirmation_missing",
    ]);
});

test("future_live_clob adapter constructs denied live submission results and summaries", () => {
    const adapter = createExecutionAdapter({
        executionMode: "future_live_clob",
        liveExecutionEnabled: false,
        executionKillSwitch: true,
        liveSubmissionConfig: {
            liveExecutionEnabled: false,
            executionKillSwitch: true,
            liveSubmissionMode: "disabled",
            allowlistedMarkets: ["m1"],
            allowlistedAssets: ["yes-1"],
            maxOrderSize: 1,
            requiredEnvironmentConfirmation: "CONFIRM",
            providedEnvironmentConfirmation: null,
        },
    });
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-live-2",
        source: "paper",
        opportunity: sampleOpportunity(),
        requestedSize: 2,
        createdAtMs: 1000,
    });
    const result = adapter.submitExecutionAttempt(request);
    assert.equal(result.accepted, false);
    assert.equal(result.liveSubmissionResult?.submissionStatus, "denied_by_guard");
    assert.equal(result.liveSubmissionResult?.guard.reasonCodes.includes("order_size_above_cap"), true);
    const summary = adapter.getLiveSubmissionSummary?.();
    assert.equal(summary?.attemptsConstructed, 1);
    assert.equal(summary?.deniedSubmissionCount, 1);
    assert.equal(summary?.guardFailureCounts.order_size_above_cap, 1);
});

test("future_live_clob remains deny-only even when all live submission guards pass", () => {
    const adapter = createExecutionAdapter({
        executionMode: "future_live_clob",
        liveExecutionEnabled: true,
        executionKillSwitch: false,
        liveSubmissionConfig: {
            liveExecutionEnabled: true,
            executionKillSwitch: false,
            liveSubmissionMode: "future_live_clob_guarded",
            allowlistedMarkets: ["m1"],
            allowlistedAssets: ["yes-1", "no-1"],
            maxOrderSize: 5,
            requiredEnvironmentConfirmation: "CONFIRM",
            providedEnvironmentConfirmation: "CONFIRM",
        },
    });
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-live-3",
        source: "paper",
        opportunity: sampleOpportunity(),
        requestedSize: 1,
        createdAtMs: 1000,
    });
    const result = adapter.submitExecutionAttempt(request);
    assert.equal(result.accepted, false);
    assert.equal(result.liveSubmissionResult?.submissionStatus, "denied_not_implemented");
    assert.deepEqual(result.liveSubmissionResult?.guard.reasonCodes, ["live_submission_not_implemented_in_phase"]);
});
