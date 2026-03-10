import { test } from "node:test";
import * as assert from "node:assert/strict";
import { matchExternalSnapshots } from "../src/live/reconciliationMatching";
import { InternalOrderReconciliationSnapshot } from "../src/live/types";

function sampleInternalOrders(): InternalOrderReconciliationSnapshot[] {
    return [
        {
            orderId: "order-1",
            executionAttemptId: "attempt-1",
            correlationId: "corr-1",
            legId: "leg-yes",
            tokenId: "yes-1",
            binarySide: "yes",
            currentState: "reconciled",
            terminalState: "reconciled",
            comparableStatus: "open",
            createdAtMs: 1000,
            updatedAtMs: 1100,
            filledSize: 1,
            averageFillPrice: 0.4,
            fillEventCount: 1,
            filledNotional: 0.4,
            partialFillObserved: false,
            statusProgressionRank: 2,
            knownExternalOrderId: "ext-order-1",
            knownExternalExecutionId: "ext-exec-1",
            knownExternalFillIds: ["ext-fill-1"],
            knownVenueOrderRef: "venue-1",
        },
        {
            orderId: "order-2",
            executionAttemptId: "attempt-2",
            correlationId: "corr-2",
            legId: "leg-no",
            tokenId: "no-1",
            binarySide: "no",
            currentState: "reconciled",
            terminalState: "reconciled",
            comparableStatus: "open",
            createdAtMs: 1000,
            updatedAtMs: 1100,
            filledSize: 1,
            averageFillPrice: 0.4,
            fillEventCount: 1,
            filledNotional: 0.4,
            partialFillObserved: false,
            statusProgressionRank: 2,
            knownExternalOrderId: null,
            knownExternalExecutionId: null,
            knownExternalFillIds: [],
            knownVenueOrderRef: null,
        },
    ];
}

test("matching rules prefer direct external id matches over fallback keys", () => {
    const result = matchExternalSnapshots({
        internalOrders: sampleInternalOrders(),
        externalOrders: [{
            internalOrderId: null,
            externalOrderId: "ext-order-1",
            externalExecutionId: "ext-exec-1",
            venueOrderRef: "venue-1",
            executionAttemptId: "attempt-2",
            correlationId: "corr-2",
            legId: "leg-no",
            tokenId: "no-1",
            status: "open",
            filledSize: 1,
            averageFillPrice: 0.4,
            externalFillCount: 1,
            totalFilledNotional: 0.4,
            partialFillObserved: false,
            observedAtMs: 1200,
            rawSourceMetadata: null,
        }],
        externalFills: [],
    });
    assert.equal(result.orderOutcomes[0]?.matchedInternalOrderId, null);
    assert.equal(result.orderOutcomes[0]?.matchRule, null);
    assert.equal(result.orderOutcomes[0]?.issueTypes.includes("conflicting_identifier_data"), true);
});

test("matching rules detect ambiguous and duplicate candidates without guessing", () => {
    const internalOrders = sampleInternalOrders().concat({
        ...sampleInternalOrders()[1],
        orderId: "order-3",
    });
    const result = matchExternalSnapshots({
        internalOrders,
        externalOrders: [
            {
                internalOrderId: null,
                externalOrderId: null,
                externalExecutionId: null,
                venueOrderRef: null,
                executionAttemptId: "attempt-2",
                correlationId: null,
                legId: "leg-no",
                tokenId: "no-1",
                status: "open",
                filledSize: 1,
                averageFillPrice: 0.4,
                externalFillCount: 1,
                totalFilledNotional: 0.4,
                partialFillObserved: false,
                observedAtMs: 1200,
                rawSourceMetadata: null,
            },
            {
                internalOrderId: null,
                externalOrderId: null,
                externalExecutionId: null,
                venueOrderRef: null,
                executionAttemptId: "attempt-2",
                correlationId: null,
                legId: "leg-no",
                tokenId: "no-1",
                status: "open",
                filledSize: 1,
                averageFillPrice: 0.4,
                externalFillCount: 1,
                totalFilledNotional: 0.4,
                partialFillObserved: false,
                observedAtMs: 1201,
                rawSourceMetadata: null,
            },
        ],
        externalFills: [],
    });
    assert.equal(result.orderOutcomes[0]?.matchedInternalOrderId, null);
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("duplicate_internal_candidates"));
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("unmatched_ambiguous_candidates"));
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("duplicate_external_snapshot"));
    assert.ok(result.orderOutcomes[1]?.issueTypes.includes("duplicate_external_snapshot"));
});

test("matching rules use external fill ids when available", () => {
    const result = matchExternalSnapshots({
        internalOrders: sampleInternalOrders(),
        externalOrders: [],
        externalFills: [{
            internalOrderId: null,
            externalOrderId: null,
            externalExecutionId: null,
            externalFillId: "ext-fill-1",
            venueOrderRef: null,
            executionAttemptId: null,
            legId: null,
            filledSize: 1,
            averageFillPrice: 0.4,
            observedAtMs: 1200,
            rawSourceMetadata: null,
        }],
    });
    assert.equal(result.fillOutcomes[0]?.matchedInternalOrderId, "order-1");
    assert.equal(result.fillOutcomes[0]?.matchRule, "matched_by_external_fill_id");
});
