import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildExecutionRequest } from "../src/live/buildExecutionRequest";
import { createExecutionAdapter } from "../src/live/createExecutionAdapter";
import { Opportunity } from "../src/arbScanner/types";
import { buildExternalAccountSnapshot, buildInternalAccountSnapshot } from "./helpers/reconciliationFixtures";

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

test("dry_run_stub accepts requests without creating live behavior", () => {
    const adapter = createExecutionAdapter({
        executionMode: "dry_run_stub",
        liveExecutionEnabled: false,
        executionKillSwitch: false,
    });
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-1",
        source: "paper",
        opportunity: sampleOpportunity(),
        requestedSize: 1,
        createdAtMs: 1000,
    });
    const result = adapter.submitExecutionAttempt(request);
    assert.equal(result.submitStatus, "accepted_dry_run_stub");
    assert.equal(result.accepted, true);
    assert.equal(adapter.reconcileExecutionState().totalExecutionRequests, 1);
    assert.equal(adapter.reconcileExecutionState().orderLifecycleSummary.reconciliationPendingCount, 2);
    const reconciliation = adapter.reconcileWithExternalState({
        capturedAtMs: 1200,
        comparisonMode: "noop_stub",
        snapshot: {
            provenance: "synthetic_test_snapshot",
            sourceLabel: "stub-noop",
            capturedAtMs: 1200,
            maxSnapshotAgeMs: null,
            trustworthy: false,
            orders: [],
            fills: [],
            rawSourceMetadata: null,
        },
    });
    assert.equal(reconciliation.comparisonMode, "noop_stub");
    assert.equal(adapter.reconcileExecutionState().externalReconciliationSummary.reconciliationRuns, 1);
    const ingested = adapter.ingestExternalSnapshot({
        provenance: "synthetic_test_snapshot",
        sourceLabel: "dry-run-ingested",
        capturedAtMs: 1200,
        ingestedAtMs: 1500,
        maxSnapshotAgeMs: 500,
        trustworthy: false,
        orders: [],
        fills: [],
        rawSourceMetadata: null,
    });
    assert.equal(ingested.normalization.accepted, true);
    assert.equal(adapter.reconcileExecutionState().externalReconciliationSummary.snapshotsIngestedByProvenance.synthetic_test_snapshot, 2);
});

test("future_live_clob remains inert and clearly denied", () => {
    const adapter = createExecutionAdapter({
        executionMode: "future_live_clob",
        liveExecutionEnabled: false,
        executionKillSwitch: true,
    });
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-2",
        source: "paper",
        opportunity: sampleOpportunity(),
        requestedSize: 1,
        createdAtMs: 1000,
    });
    const result = adapter.submitExecutionAttempt(request);
    assert.equal(result.accepted, false);
    assert.equal(result.submitStatus, "rejected_execution_kill_switch");
    assert.equal(adapter.reconcileExecutionState().totalExecutionRequests, 1);
    assert.equal(adapter.reconcileExecutionState().orderLifecycleSummary.submitDeniedCount, 2);
    const ingested = adapter.ingestExternalSnapshot({
        provenance: "future_external_api_shape",
        sourceLabel: "",
        capturedAtMs: null,
        orders: null,
        fills: null,
    });
    assert.equal(ingested.normalization.accepted, false);
    assert.equal(adapter.reconcileExecutionState().externalReconciliationSummary.malformedSnapshotRejectCount, 1);
});

test("replay_simulated adapter records scaffold submissions", () => {
    const adapter = createExecutionAdapter({
        executionMode: "replay_simulated",
        liveExecutionEnabled: false,
        executionKillSwitch: true,
    });
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-3",
        source: "replay",
        opportunity: sampleOpportunity(),
        requestedSize: 1,
        createdAtMs: 1000,
    });
    const result = adapter.submitExecutionAttempt(request);
    assert.equal(result.submitStatus, "accepted_replay_simulated");
    assert.equal(adapter.getExecutionStatus("attempt-3").found, true);
    const lifecycle = adapter.recordSimulatedOrderLifecycle({
        executionAttemptId: "attempt-3",
        ts: 1100,
        legUpdates: [
            { legId: "attempt-3-yes", terminalState: "filled", reason: "filled_by_replay_simulation", filledSize: 1, averageFillPrice: 0.4 },
            { legId: "attempt-3-no", terminalState: "filled", reason: "filled_by_replay_simulation", filledSize: 1, averageFillPrice: 0.4 },
        ],
        reconciliationPending: true,
        reconcileNow: true,
    });
    assert.equal(lifecycle.fillEvents.length, 2);
    const reconciliation = adapter.reconcileExecutionState();
    assert.equal(reconciliation.liveExecutionEnabled, false);
    assert.equal(reconciliation.executionKillSwitch, true);
    assert.equal(reconciliation.orderLifecycleSummary.ordersByTerminalState.reconciled, 2);
    assert.equal(reconciliation.externalReconciliationSummary.reconciliationRuns, 0);
    const balanceResult = adapter.reconcileAccountBalances({
        capturedAtMs: 1200,
        comparisonMode: "synthetic_external_account_snapshot_compare",
        internalAccount: buildInternalAccountSnapshot(),
        externalAccount: buildExternalAccountSnapshot(),
    });
    assert.equal(balanceResult.matchedAssetCount, 2);
    assert.equal(adapter.reconcileExecutionState().externalBalanceReconciliationSummary.reconciliationRuns, 1);
});
