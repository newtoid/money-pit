import { test } from "node:test";
import * as assert from "node:assert/strict";
import { ExecutionAttemptStateMachine } from "../src/core/executionStateMachine";

test("full fill path reaches fully_filled terminal state", () => {
    const attempt = new ExecutionAttemptStateMachine({
        id: "test-full",
        marketId: "m1",
        slug: "market-1",
        detectedAt: 1000,
        scheduledExecutionAt: 1100,
        expiresAt: 2000,
    });

    attempt.queue(1000);
    attempt.startLegA(1100);
    attempt.finishLegAFilled(1100, false);
    attempt.startLegB(1101);
    attempt.finishLegBFilled(1101, false);
    attempt.complete(1101, false);

    const snapshot = attempt.snapshot();
    assert.equal(snapshot.terminalState, "fully_filled");
    assert.deepEqual(snapshot.history.map((item) => item.toState), [
        "detected",
        "queued_for_execution",
        "leg_a_pending",
        "leg_a_filled",
        "leg_b_pending",
        "leg_b_filled",
        "fully_filled",
    ]);
});

test("expired attempts cannot transition afterward", () => {
    const attempt = new ExecutionAttemptStateMachine({
        id: "test-expired",
        marketId: "m1",
        slug: "market-1",
        detectedAt: 1000,
        scheduledExecutionAt: 1100,
        expiresAt: 1100,
    });

    attempt.queue(1000);
    attempt.expire(1100);

    assert.equal(attempt.snapshot().terminalState, "expired");
    assert.throws(() => attempt.startLegA(1200), /already terminal/);
});

test("invalidated attempts cannot become filled later", () => {
    const attempt = new ExecutionAttemptStateMachine({
        id: "test-invalidated",
        marketId: "m1",
        slug: "market-1",
        detectedAt: 1000,
        scheduledExecutionAt: 1100,
        expiresAt: 2000,
    });

    attempt.queue(1000);
    attempt.startLegA(1100);
    attempt.finishLegAFilled(1100, false);
    attempt.startLegB(1200);
    attempt.failLegB(1200, "leg_b_failed_stale_orderbook", true);

    assert.equal(attempt.snapshot().terminalState, "invalidated");
    assert.throws(() => attempt.finishLegBFilled(1201, false), /already terminal/);
});

test("partial vs full classification stays stable", () => {
    const partial = new ExecutionAttemptStateMachine({
        id: "test-partial",
        marketId: "m1",
        slug: "market-1",
        detectedAt: 1000,
        scheduledExecutionAt: 1100,
        expiresAt: 2000,
    });
    partial.queue(1000);
    partial.startLegA(1100);
    partial.finishLegAFilled(1100, true);
    partial.startLegB(1101);
    partial.finishLegBFilled(1101, true);
    partial.complete(1101, true);
    assert.equal(partial.snapshot().terminalState, "partially_filled");

    const full = new ExecutionAttemptStateMachine({
        id: "test-full-2",
        marketId: "m2",
        slug: "market-2",
        detectedAt: 1000,
        scheduledExecutionAt: 1100,
        expiresAt: 2000,
    });
    full.queue(1000);
    full.startLegA(1100);
    full.finishLegAFilled(1100, false);
    full.startLegB(1101);
    full.finishLegBFilled(1101, false);
    full.complete(1101, false);
    assert.equal(full.snapshot().terminalState, "fully_filled");
});
