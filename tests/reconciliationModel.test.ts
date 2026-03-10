import { test } from "node:test";
import * as assert from "node:assert/strict";
import { createExecutionAdapter } from "../src/live/createExecutionAdapter";
import { buildInternalReconciliationSnapshots, runExternalReconciliation } from "../src/live/reconciliationModel";
import {
    buildExternalFill,
    buildExternalOrder,
    buildFilledOrderStore,
    buildSyntheticSnapshot,
    sampleOpportunity,
} from "./helpers/reconciliationFixtures";
import { buildExecutionRequest } from "../src/live/buildExecutionRequest";

test("reconciliation model reports matching synthetic snapshots with internal external-id coverage", () => {
    const store = buildFilledOrderStore({
        externalIdentifierMode: "synthetic_full",
    });
    const internalOrders = buildInternalReconciliationSnapshots({
        orders: store.getAllOrderRecords(),
        fillEvents: store.getAllFillEvents(),
    });
    const result = runExternalReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 1200,
            comparisonMode: "synthetic_external_snapshot_compare",
            snapshot: buildSyntheticSnapshot({
                sourceLabel: "synthetic-full-identifier-match",
                orders: [
                    buildExternalOrder({
                        internalOrderId: "attempt-1-order-1",
                        externalOrderId: "ext-order-yes",
                        externalExecutionId: "ext-exec-yes",
                        venueOrderRef: "venue-ref-yes",
                        executionAttemptId: "attempt-1",
                        correlationId: "attempt-1",
                        legId: "attempt-1-yes",
                        tokenId: "yes-1",
                    }),
                    buildExternalOrder({
                        internalOrderId: "attempt-1-order-2",
                        externalOrderId: "ext-order-no",
                        externalExecutionId: "ext-exec-no",
                        venueOrderRef: "venue-ref-no",
                        executionAttemptId: "attempt-1",
                        correlationId: "attempt-1",
                        legId: "attempt-1-no",
                        tokenId: "no-1",
                    }),
                ],
            }),
        },
        internalOrders,
    });
    assert.equal(result.matchedOrderCount, 2);
    assert.equal(result.mismatchedOrderCount, 0);
    assert.equal(result.matchCountsByRule.matched_by_external_order_id, 2);
    assert.equal(result.matchedOrdersWithAccountingAgreement, 2);
    assert.equal(result.internalIdentifierCoverage.orders_with_external_order_id, 2);
    assert.equal(result.internalIdentifierCoverage.orders_with_external_fill_ids, 2);
    assert.equal(result.internalIdentifierProvenanceCounts.synthetic_fixture, 2);
});

test("reconciliation model reports conflicting identifiers, missing ids, and accounting disagreement combinations", () => {
    const store = buildFilledOrderStore({
        fillCountPerLeg: 2,
        externalIdentifierMode: "synthetic_partial",
    });
    const internalOrders = buildInternalReconciliationSnapshots({
        orders: store.getAllOrderRecords(),
        fillEvents: store.getAllFillEvents(),
    });
    const result = runExternalReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 5000,
            comparisonMode: "synthetic_external_snapshot_compare",
            snapshot: buildSyntheticSnapshot({
                sourceLabel: "synthetic-partial-identifier-disagreement",
                trustworthy: false,
                orders: [
                    buildExternalOrder({
                        externalOrderId: "ext-order-yes",
                        externalExecutionId: null,
                        executionAttemptId: "attempt-1",
                        correlationId: "attempt-1",
                        legId: "attempt-1-yes",
                        status: "filled",
                        filledSize: 1,
                        averageFillPrice: 0.41,
                        externalFillCount: 1,
                        totalFilledNotional: 0.41,
                        partialFillObserved: false,
                    }),
                    buildExternalOrder({
                        externalOrderId: "ext-order-unknown",
                        externalExecutionId: null,
                        executionAttemptId: null,
                        correlationId: null,
                        legId: null,
                        status: "open",
                        filledSize: 0,
                        averageFillPrice: null,
                        externalFillCount: 0,
                        totalFilledNotional: 0,
                        partialFillObserved: false,
                    }),
                ],
                fills: [
                    buildExternalFill({
                        externalFillId: "ext-fill-yes-1",
                        externalOrderId: "ext-order-yes",
                        externalExecutionId: null,
                        executionAttemptId: "attempt-1",
                        legId: "attempt-1-yes",
                        filledSize: 1,
                        averageFillPrice: 0.41,
                    }),
                ],
            }),
        },
        internalOrders,
    });
    assert.equal(result.unexpectedExternalOrderCount, 1);
    assert.equal(result.accountingIssueCountsByType.external_internal_avg_price_mismatch, 1);
    assert.equal(result.accountingIssueCountsByType.external_internal_fill_count_mismatch, 1);
    assert.equal(result.accountingIssueCountsByType.external_internal_notional_mismatch, 1);
    assert.equal(result.accountingIssueCountsByType.external_internal_partial_fill_mismatch, 1);
    assert.equal(result.unmatchedCountsByReason.partial_identifier_insufficient, 1);
    assert.equal(result.internalIdentifierCoverage.orders_with_external_order_id, 2);
    assert.equal(result.internalIdentifierCoverage.orders_with_external_execution_id ?? 0, 0);
});

test("replay adapter stores synthetic provenance and identifier coverage through reconciliation ingestion", () => {
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
    const ingested = adapter.ingestExternalSnapshot({
        provenance: "synthetic_test_snapshot",
        sourceLabel: "synthetic-ingestion-coverage",
        capturedAtMs: 1200,
        ingestedAtMs: 1201,
        trustworthy: true,
        orders: [
            {
                externalOrderId: "synthetic-ext-order-1",
                executionAttemptId: "attempt-2",
                legId: "attempt-2-yes",
                status: "filled",
                filledSize: 1,
                averageFillPrice: 0.4,
                externalFillCount: 1,
                totalFilledNotional: 0.4,
                partialFillObserved: false,
                observedAtMs: 1200,
                rawSourceMetadata: {
                    fixtureScenario: "partial-identifiers-only",
                },
            },
        ],
        fills: [],
        rawSourceMetadata: {
            fixtureSuite: "reconciliation-model",
        },
    });
    assert.equal(ingested.normalization.accepted, true);
    const summary = adapter.reconcileExecutionState().externalReconciliationSummary;
    assert.equal(summary.snapshotsIngestedByProvenance.synthetic_test_snapshot, 1);
    assert.equal(summary.internalIdentifierCoverage.orders_without_external_identifiers, 2);
    assert.equal(summary.internalIdentifierProvenanceCounts.none, 2);
});
