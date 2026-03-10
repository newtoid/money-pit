import { test } from "node:test";
import * as assert from "node:assert/strict";
import { compareExternalAccounting } from "../src/live/reconciliationAccounting";
import { ExternalFillSnapshot, ExternalOrderSnapshot, InternalOrderReconciliationSnapshot } from "../src/live/types";

function sampleInternalOrder(): InternalOrderReconciliationSnapshot {
    return {
        orderId: "order-1",
        executionAttemptId: "attempt-1",
        correlationId: "corr-1",
        legId: "leg-1",
        tokenId: "token-1",
        binarySide: "yes",
        currentState: "reconciled",
        terminalState: "reconciled",
        comparableStatus: "open",
        createdAtMs: 1000,
        updatedAtMs: 1200,
        filledSize: 2,
        averageFillPrice: 0.4,
        fillEventCount: 2,
        filledNotional: 0.8,
        partialFillObserved: true,
        statusProgressionRank: 2,
        knownExternalOrderId: null,
        knownExternalExecutionId: null,
        knownExternalFillIds: [],
        knownVenueOrderRef: null,
    };
}

function sampleExternalOrder(): ExternalOrderSnapshot {
    return {
        internalOrderId: "order-1",
        externalOrderId: "ext-order-1",
        externalExecutionId: "ext-exec-1",
        venueOrderRef: "venue-1",
        executionAttemptId: "attempt-1",
        correlationId: "corr-1",
        legId: "leg-1",
        tokenId: "token-1",
        status: "open",
        filledSize: 2,
        averageFillPrice: 0.4,
        externalFillCount: 2,
        totalFilledNotional: 0.8,
        partialFillObserved: true,
        observedAtMs: 1200,
        rawSourceMetadata: null,
    };
}

test("accounting comparison reports agreement when comparable values match", () => {
    const result = compareExternalAccounting({
        internalOrder: sampleInternalOrder(),
        externalOrder: sampleExternalOrder(),
        matchedExternalFills: [],
    });
    assert.equal(result.issueTypes.length, 0);
    assert.equal(result.skippedFields.length, 0);
});

test("accounting comparison reports fill, notional, price, status, and partial mismatches", () => {
    const result = compareExternalAccounting({
        internalOrder: sampleInternalOrder(),
        externalOrder: {
            ...sampleExternalOrder(),
            status: "filled",
            averageFillPrice: 0.41,
            externalFillCount: 1,
            totalFilledNotional: 0.41,
            partialFillObserved: false,
        },
        matchedExternalFills: [],
    });
    assert.ok(result.issueTypes.includes("external_internal_fill_count_mismatch"));
    assert.ok(result.issueTypes.includes("external_internal_notional_mismatch"));
    assert.ok(result.issueTypes.includes("external_internal_avg_price_mismatch"));
    assert.ok(result.issueTypes.includes("external_internal_status_progression_mismatch"));
    assert.ok(result.issueTypes.includes("external_internal_partial_fill_mismatch"));
});

test("accounting comparison reports skipped fields when external data is insufficient", () => {
    const externalOrder: ExternalOrderSnapshot = {
        ...sampleExternalOrder(),
        averageFillPrice: null,
        externalFillCount: null,
        totalFilledNotional: null,
        partialFillObserved: null,
    };
    const matchedExternalFills: ExternalFillSnapshot[] = [];
    const result = compareExternalAccounting({
        internalOrder: {
            ...sampleInternalOrder(),
            averageFillPrice: null,
            filledNotional: null,
            fillEventCount: 0,
        },
        externalOrder,
        matchedExternalFills,
    });
    assert.ok(result.skippedFields.includes("fill_count"));
    assert.ok(result.skippedFields.includes("filled_notional"));
    assert.ok(result.skippedFields.includes("avg_fill_price"));
});
