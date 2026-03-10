import { test } from "node:test";
import * as assert from "node:assert/strict";
import { matchExternalSnapshots } from "../src/live/reconciliationMatching";
import { buildExternalFill, buildExternalOrder, buildInternalSnapshots } from "./helpers/reconciliationFixtures";

test("matching rules prefer direct external order id matches over fallback keys", () => {
    const internalOrders = buildInternalSnapshots({
        externalIdentifierMode: "synthetic_full",
    });
    const result = matchExternalSnapshots({
        internalOrders,
        externalOrders: [
            buildExternalOrder({
                externalOrderId: "ext-order-yes",
                externalExecutionId: "ext-exec-yes",
                venueOrderRef: "venue-ref-yes",
                executionAttemptId: "attempt-1",
                correlationId: "attempt-1",
                legId: "attempt-1-no",
                tokenId: "no-1",
            }),
        ],
        externalFills: [],
    });
    assert.equal(result.orderOutcomes[0]?.matchedInternalOrderId, null);
    assert.equal(result.orderOutcomes[0]?.matchRule, null);
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("conflicting_identifier_data"));
});

test("matching rules use external execution id and fill id before fallback identifiers", () => {
    const internalOrders = buildInternalSnapshots({
        externalIdentifierMode: "synthetic_full",
        fillCountPerLeg: 2,
    });
    const executionMatch = matchExternalSnapshots({
        internalOrders,
        externalOrders: [
            buildExternalOrder({
                externalOrderId: null,
                externalExecutionId: "ext-exec-yes",
                executionAttemptId: "attempt-1",
                legId: "attempt-1-yes",
            }),
        ],
        externalFills: [],
    });
    assert.equal(executionMatch.orderOutcomes[0]?.matchedInternalOrderId, "attempt-1-order-1");
    assert.equal(executionMatch.orderOutcomes[0]?.matchRule, "matched_by_external_execution_id");

    const fillMatch = matchExternalSnapshots({
        internalOrders,
        externalOrders: [],
        externalFills: [
            buildExternalFill({
                externalFillId: "ext-fill-no-2",
                externalOrderId: null,
                externalExecutionId: null,
            }),
        ],
    });
    assert.equal(fillMatch.fillOutcomes[0]?.matchedInternalOrderId, "attempt-1-order-2");
    assert.equal(fillMatch.fillOutcomes[0]?.matchRule, "matched_by_external_fill_id");
});

test("matching rules report ambiguous and duplicate identifier cases without guessing", () => {
    const attemptTwoOrders = buildInternalSnapshots({
        executionAttemptId: "attempt-2",
        externalIdentifierMode: "synthetic_partial",
    });
    const internalOrders = buildInternalSnapshots({
        externalIdentifierMode: "synthetic_partial",
    }).concat(attemptTwoOrders, {
        ...attemptTwoOrders[1]!,
        orderId: "attempt-2-order-2-duplicate",
        executionAttemptId: "attempt-2",
        correlationId: "attempt-2",
        legId: "attempt-2-no",
        knownExternalOrderId: null,
        knownExternalExecutionId: null,
        knownExternalFillIds: [],
        knownVenueOrderRef: null,
        externalIdentifierProvenance: "none",
    });
    const result = matchExternalSnapshots({
        internalOrders,
        externalOrders: [
            buildExternalOrder({
                externalOrderId: null,
                externalExecutionId: null,
                executionAttemptId: "attempt-2",
                correlationId: null,
                legId: "attempt-2-no",
            }),
            buildExternalOrder({
                externalOrderId: null,
                externalExecutionId: null,
                executionAttemptId: "attempt-2",
                correlationId: null,
                legId: "attempt-2-no",
                observedAtMs: 1201,
            }),
        ],
        externalFills: [],
    });
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("duplicate_internal_candidates"));
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("unmatched_ambiguous_candidates"));
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("duplicate_external_snapshot"));
    assert.ok(result.orderOutcomes[1]?.issueTypes.includes("duplicate_external_snapshot"));
});

test("matching rules report conflicting identifier data without guessing", () => {
    const internalOrders = buildInternalSnapshots({
        externalIdentifierMode: "synthetic_partial",
    });
    const result = matchExternalSnapshots({
        internalOrders,
        externalOrders: [
            buildExternalOrder({
                externalOrderId: "ext-order-yes",
                externalExecutionId: "different-exec-id",
                executionAttemptId: "attempt-1",
                correlationId: "attempt-1",
                legId: "attempt-1-no",
            }),
        ],
        externalFills: [],
    });
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("conflicting_identifier_data"));
});

test("matching rules keep partial identifiers unmatched when coverage is insufficient", () => {
    const internalOrders = buildInternalSnapshots({
        externalIdentifierMode: "none",
    });
    const result = matchExternalSnapshots({
        internalOrders,
        externalOrders: [
            buildExternalOrder({
                externalOrderId: "ext-order-unknown",
                externalExecutionId: null,
                executionAttemptId: null,
                correlationId: null,
                legId: null,
            }),
        ],
        externalFills: [],
    });
    assert.equal(result.orderOutcomes[0]?.matchedInternalOrderId, null);
    assert.ok(result.orderOutcomes[0]?.issueTypes.includes("partial_identifier_insufficient"));
});
