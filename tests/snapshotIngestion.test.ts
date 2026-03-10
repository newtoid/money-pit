import { test } from "node:test";
import * as assert from "node:assert/strict";
import { normalizeExternalSnapshotIngestion } from "../src/live/snapshotIngestion";

test("snapshot ingestion normalizes external identifiers and preserves provenance", () => {
    const result = normalizeExternalSnapshotIngestion({
        provenance: "future_external_api_shape",
        sourceLabel: "future-api-shape",
        capturedAtMs: "1000",
        ingestedAtMs: "1200",
        maxSnapshotAgeMs: "500",
        trustworthy: true,
        orders: [{
            internalOrderId: "order-1",
            externalOrderId: "ext-order-1",
            externalExecutionId: "ext-exec-1",
            venueOrderRef: "venue-ref-1",
            executionAttemptId: "attempt-1",
            correlationId: "attempt-1",
            legId: "leg-1",
            tokenId: "token-1",
            status: "filled",
            filledSize: "1",
            averageFillPrice: "0.42",
            observedAtMs: "1100",
        }],
        fills: [{
            internalOrderId: "order-1",
            externalOrderId: "ext-order-1",
            externalExecutionId: "ext-exec-1",
            externalFillId: "ext-fill-1",
            venueOrderRef: "venue-ref-1",
            executionAttemptId: "attempt-1",
            legId: "leg-1",
            filledSize: "1",
            averageFillPrice: "0.42",
            observedAtMs: "1100",
        }],
    });
    assert.equal(result.accepted, true);
    assert.equal(result.snapshot?.provenance, "future_external_api_shape");
    assert.equal(result.snapshot?.orders[0]?.externalExecutionId, "ext-exec-1");
    assert.equal(result.snapshot?.fills[0]?.externalFillId, "ext-fill-1");
    assert.equal(result.warnings.length, 0);
});

test("snapshot ingestion surfaces missing identifiers and stale input warnings", () => {
    const result = normalizeExternalSnapshotIngestion({
        provenance: "replay_generated_snapshot",
        sourceLabel: "replay-generated",
        capturedAtMs: 1000,
        ingestedAtMs: 2000,
        maxSnapshotAgeMs: 100,
        trustworthy: false,
        orders: [{
            status: "mystery_status",
            filledSize: "oops",
            observedAtMs: null,
        }],
        fills: [{
            filledSize: "1",
            averageFillPrice: null,
            observedAtMs: null,
        }],
    });
    assert.equal(result.accepted, true);
    assert.ok(result.warnings.some((item) => item.warningType === "missing_external_identifiers"));
    assert.ok(result.warnings.some((item) => item.warningType === "unknown_status_value"));
    assert.ok(result.warnings.some((item) => item.warningType === "stale_snapshot_input"));
});
