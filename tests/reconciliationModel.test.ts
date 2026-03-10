import { test } from "node:test";
import * as assert from "node:assert/strict";
import { OrderLifecycleStore } from "../src/live/orderLifecycle";
import { buildExecutionRequest } from "../src/live/buildExecutionRequest";
import { createExecutionAdapter } from "../src/live/createExecutionAdapter";
import { buildInternalReconciliationSnapshots, runExternalReconciliation } from "../src/live/reconciliationModel";
import { Opportunity } from "../src/arbScanner/types";

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

function buildFilledOrderStore() {
    const store = new OrderLifecycleStore();
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-1",
        source: "replay",
        opportunity: sampleOpportunity(),
        requestedSize: 1,
        createdAtMs: 1000,
    });
    store.createFromExecutionRequest(request);
    store.transitionExecutionAttempt("attempt-1", "submit_requested", "submit_requested_by_adapter", 1000);
    store.transitionExecutionAttempt("attempt-1", "submitted", "submitted_by_replay_simulated", 1000);
    store.transitionExecutionAttempt("attempt-1", "acknowledged", "acknowledged_by_stub", 1000);
    store.transitionExecutionAttempt("attempt-1", "open", "opened_by_stub", 1000);
    store.applySimulatedUpdate({
        executionAttemptId: "attempt-1",
        ts: 1100,
        legUpdates: [
            {
                legId: "attempt-1-yes",
                terminalState: "filled",
                reason: "filled_by_replay_simulation",
                filledSize: 1,
                averageFillPrice: 0.4,
            },
            {
                legId: "attempt-1-no",
                terminalState: "filled",
                reason: "filled_by_replay_simulation",
                filledSize: 1,
                averageFillPrice: 0.4,
            },
        ],
        reconciliationPending: true,
        reconcileNow: true,
    });
    return store;
}

test("reconciliation model reports matching synthetic external snapshots", () => {
    const store = buildFilledOrderStore();
    const internalOrders = buildInternalReconciliationSnapshots({
        orders: store.getAllOrderRecords(),
        fillEvents: store.getAllFillEvents(),
    });
    const result = runExternalReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 1200,
            comparisonMode: "synthetic_external_snapshot_compare",
            snapshot: {
                provenance: "synthetic_test_snapshot",
                sourceLabel: "synthetic-test-snapshot",
                capturedAtMs: 1200,
                maxSnapshotAgeMs: 1000,
                trustworthy: true,
                orders: [
                    {
                        internalOrderId: "attempt-1-order-1",
                        externalOrderId: "external-1",
                        externalExecutionId: "execution-1",
                        venueOrderRef: "venue-ref-1",
                        executionAttemptId: "attempt-1",
                        correlationId: "attempt-1",
                        legId: "attempt-1-yes",
                        tokenId: "yes-1",
                        status: "open",
                        filledSize: 1,
                        averageFillPrice: 0.4,
                        observedAtMs: 1200,
                        rawSourceMetadata: null,
                    },
                    {
                        internalOrderId: "attempt-1-order-2",
                        externalOrderId: "external-2",
                        externalExecutionId: "execution-2",
                        venueOrderRef: "venue-ref-2",
                        executionAttemptId: "attempt-1",
                        correlationId: "attempt-1",
                        legId: "attempt-1-no",
                        tokenId: "no-1",
                        status: "open",
                        filledSize: 1,
                        averageFillPrice: 0.4,
                        observedAtMs: 1200,
                        rawSourceMetadata: null,
                    },
                ],
                fills: [],
                rawSourceMetadata: null,
            },
        },
        internalOrders,
    });
    assert.equal(result.matchedOrderCount, 2);
    assert.equal(result.mismatchedOrderCount, 0);
    assert.equal(result.issueCountsByType.status_mismatch, 0);
});

test("reconciliation model reports mismatches, stale snapshots, and unexpected orders", () => {
    const store = buildFilledOrderStore();
    const internalOrders = buildInternalReconciliationSnapshots({
        orders: store.getAllOrderRecords(),
        fillEvents: store.getAllFillEvents(),
    });
    const result = runExternalReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 5000,
            comparisonMode: "synthetic_external_snapshot_compare",
            snapshot: {
                provenance: "synthetic_test_snapshot",
                sourceLabel: "synthetic-mismatch-snapshot",
                capturedAtMs: 1200,
                maxSnapshotAgeMs: 100,
                trustworthy: false,
                orders: [
                    {
                        internalOrderId: "attempt-1-order-1",
                        externalOrderId: null,
                        externalExecutionId: null,
                        venueOrderRef: null,
                        executionAttemptId: "attempt-1",
                        correlationId: "attempt-1",
                        legId: "attempt-1-yes",
                        tokenId: "yes-1",
                        status: "filled",
                        filledSize: 0.5,
                        averageFillPrice: 0.41,
                        observedAtMs: 1200,
                        rawSourceMetadata: null,
                    },
                    {
                        internalOrderId: null,
                        externalOrderId: "external-extra",
                        externalExecutionId: null,
                        venueOrderRef: null,
                        executionAttemptId: "attempt-extra",
                        correlationId: null,
                        legId: "attempt-extra-yes",
                        tokenId: "yes-extra",
                        status: "open",
                        filledSize: 0,
                        averageFillPrice: null,
                        observedAtMs: 1200,
                        rawSourceMetadata: null,
                    },
                ],
                fills: [],
                rawSourceMetadata: null,
            },
        },
        internalOrders,
    });
    assert.equal(result.staleSnapshotWarningCount, 1);
    assert.equal(result.missingExternalOrderCount, 1);
    assert.equal(result.unexpectedExternalOrderCount, 1);
    assert.equal(result.missingExternalOrderIdCount, 1);
    assert.equal(result.issueCountsByType.fill_quantity_mismatch, 1);
    assert.equal(result.issueCountsByType.fill_price_mismatch, 1);
    assert.equal(result.issueCountsByType.status_mismatch, 1);
});

test("replay adapter accepts synthetic reconciliation input and stores summary", () => {
    const adapter = createExecutionAdapter({
        executionMode: "replay_simulated",
        liveExecutionEnabled: false,
        executionKillSwitch: true,
    });
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-2",
        source: "replay",
        opportunity: sampleOpportunity(),
        requestedSize: 1,
        createdAtMs: 1000,
    });
    adapter.submitExecutionAttempt(request);
    adapter.recordSimulatedOrderLifecycle({
        executionAttemptId: "attempt-2",
        ts: 1100,
        legUpdates: [
            { legId: "attempt-2-yes", terminalState: "filled", reason: "filled_by_replay_simulation", filledSize: 1, averageFillPrice: 0.4 },
            { legId: "attempt-2-no", terminalState: "filled", reason: "filled_by_replay_simulation", filledSize: 1, averageFillPrice: 0.4 },
        ],
        reconciliationPending: true,
        reconcileNow: true,
    });
    const result = adapter.reconcileWithExternalState({
        capturedAtMs: 1200,
        comparisonMode: "synthetic_external_snapshot_compare",
        snapshot: {
            provenance: "synthetic_test_snapshot",
            sourceLabel: "synthetic-adapter-snapshot",
            capturedAtMs: 1200,
            maxSnapshotAgeMs: 1000,
            trustworthy: true,
            orders: [
                {
                    internalOrderId: "attempt-2-order-1",
                    externalOrderId: "ext-1",
                    externalExecutionId: "exec-1",
                    venueOrderRef: "venue-1",
                    executionAttemptId: "attempt-2",
                    correlationId: "attempt-2",
                    legId: "attempt-2-yes",
                    tokenId: "yes-1",
                    status: "open",
                    filledSize: 1,
                    averageFillPrice: 0.4,
                    observedAtMs: 1200,
                    rawSourceMetadata: null,
                },
                {
                    internalOrderId: "attempt-2-order-2",
                    externalOrderId: "ext-2",
                    externalExecutionId: "exec-2",
                    venueOrderRef: "venue-2",
                    executionAttemptId: "attempt-2",
                    correlationId: "attempt-2",
                    legId: "attempt-2-no",
                    tokenId: "no-1",
                    status: "open",
                    filledSize: 1,
                    averageFillPrice: 0.4,
                    observedAtMs: 1200,
                    rawSourceMetadata: null,
                },
            ],
            fills: [],
            rawSourceMetadata: null,
        },
    });
    assert.equal(result.matchedOrderCount, 2);
    assert.equal(adapter.reconcileExecutionState().externalReconciliationSummary.reconciliationRuns, 1);
    assert.equal(adapter.reconcileExecutionState().externalReconciliationSummary.snapshotsIngestedByProvenance.synthetic_test_snapshot, 1);
});
