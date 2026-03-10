import { test } from "node:test";
import * as assert from "node:assert/strict";
import { OrderLifecycleStore } from "../src/live/orderLifecycle";
import { ExecutionRequest } from "../src/live/types";

function sampleRequest(): ExecutionRequest {
    return {
        executionAttemptId: "attempt-1",
        correlationId: "attempt-1",
        source: "paper",
        strategyId: "binary_full_set_arb_v1",
        marketId: "m1",
        slug: "sample-market",
        createdAtMs: 1000,
        requestedSize: 1,
        notes: [],
        legs: [
            {
                legId: "attempt-1-yes",
                tokenId: "yes-1",
                binarySide: "yes",
                side: "buy",
                limitPrice: 0.4,
                size: 1,
                timeInForce: "FOK",
            },
            {
                legId: "attempt-1-no",
                tokenId: "no-1",
                binarySide: "no",
                side: "buy",
                limitPrice: 0.4,
                size: 1,
                timeInForce: "FOK",
            },
        ],
    };
}

test("order lifecycle store enforces explicit submit and fill path", () => {
    const store = new OrderLifecycleStore();
    store.createFromExecutionRequest(sampleRequest());
    store.transitionExecutionAttempt("attempt-1", "submit_requested", "submit_requested_by_adapter", 1000);
    store.transitionExecutionAttempt("attempt-1", "submitted", "submitted_by_replay_simulated", 1000);
    store.transitionExecutionAttempt("attempt-1", "acknowledged", "acknowledged_by_stub", 1000);
    store.transitionExecutionAttempt("attempt-1", "open", "opened_by_stub", 1000);
    store.applySimulatedUpdate({
        executionAttemptId: "attempt-1",
        ts: 1100,
        legUpdates: [
            { legId: "attempt-1-yes", terminalState: "filled", reason: "filled_by_replay_simulation", filledSize: 1, averageFillPrice: 0.4 },
            { legId: "attempt-1-no", terminalState: "filled", reason: "filled_by_replay_simulation", filledSize: 1, averageFillPrice: 0.4 },
        ],
        reconciliationPending: true,
        reconcileNow: true,
    });
    const summary = store.getSummary();
    assert.equal(summary.ordersByTerminalState.reconciled, 2);
    assert.equal(summary.reconciliationPendingCount, 0);
});

test("order lifecycle store rejects illegal transitions", () => {
    const store = new OrderLifecycleStore();
    store.createFromExecutionRequest(sampleRequest());
    assert.throws(() => {
        store.transitionExecutionAttempt("attempt-1", "filled", "filled_by_replay_simulation", 1000);
    }, /Illegal order transition/);
});
