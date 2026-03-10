import { test } from "node:test";
import * as assert from "node:assert/strict";
import { StrandedDamageTracker } from "../src/core/strandedDamage";
import { ExecutionAttemptRecord } from "../src/core/executionStateMachine";
import { ReplayExecutionOutcome } from "../src/arbScanner/types";

function baseAttempt(overrides: Partial<ExecutionAttemptRecord> = {}): ExecutionAttemptRecord {
    return {
        id: "replay-attempt-1",
        marketId: "m1",
        slug: "market-1",
        detectedAt: 1000,
        scheduledExecutionAt: 1000,
        expiresAt: 6000,
        currentState: "invalidated",
        terminalState: "invalidated",
        history: [],
        ...overrides,
    };
}

function baseOutcome(overrides: Partial<ReplayExecutionOutcome> = {}): ReplayExecutionOutcome {
    return {
        marketId: "m1",
        slug: "market-1",
        detectedAt: 1000,
        legAPlannedAt: 1000,
        legAAttemptedAt: 1000,
        legBAttemptedAt: 2000,
        detectionToExecutionDelayMs: 0,
        opportunityInvalidated: true,
        outcome: "leg_a_fill_only",
        legA: {
            side: "yes",
            attemptedAt: 1000,
            topUpdatedAt: 1000,
            topAgeMs: 0,
            detectedBestAsk: 0.4,
            availableSize: 1,
            visibleAvailableSize: 1,
            fillableAvailableSize: 1,
            requestedSize: 1,
            filledSize: 1,
            price: 0.4,
            averageFillPrice: 0.4,
            levelsConsumed: [],
            levelsConsumedCount: 1,
            unfilledRemainder: 0,
            fullFillMethod: "top_level",
            depthUsed: false,
            queueMode: "optimistic_visible_depth",
            queueLimited: false,
            queueLimitedReason: null,
            averageQueueHaircutApplied: 0,
            status: "filled",
            reason: "filled",
        },
        legB: {
            side: "no",
            attemptedAt: 2000,
            topUpdatedAt: 2000,
            topAgeMs: 0,
            detectedBestAsk: 0.4,
            availableSize: 0,
            visibleAvailableSize: 0,
            fillableAvailableSize: 0,
            requestedSize: 1,
            filledSize: 0,
            price: null,
            averageFillPrice: null,
            levelsConsumed: [],
            levelsConsumedCount: 0,
            unfilledRemainder: 1,
            fullFillMethod: null,
            depthUsed: false,
            queueMode: "optimistic_visible_depth",
            queueLimited: false,
            queueLimitedReason: null,
            averageQueueHaircutApplied: null,
            status: "failed",
            reason: "missing_ask",
        },
        matchedSize: 0,
        strandedSize: 1,
        strandedNotional: 0.4,
        partialFillDamage: 0.4,
        depthLimited: false,
        invalidatedBeforeSecondLeg: true,
        queueLimited: false,
        fullSetFill: null,
        ...overrides,
    };
}

test("creates stranded damage records from replay outcomes", () => {
    const tracker = new StrandedDamageTracker();
    const records = tracker.recordExecutionOutcome({
        attempt: baseAttempt(),
        outcome: baseOutcome(),
        provenance: "replay_execution_outcome",
    });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.currentState, "open_damage");
    assert.equal(records[0]?.damageType, "leg_a_only");
});

test("resolved damage records become terminal and clear outstanding exposure", () => {
    const tracker = new StrandedDamageTracker();
    tracker.recordExecutionOutcome({
        attempt: baseAttempt(),
        outcome: baseOutcome(),
        provenance: "replay_execution_outcome",
    });
    tracker.resolveAllOpen(5000, "replay_session_end_summary");

    const records = tracker.getRecords();
    assert.equal(records.every((record) => record.currentState === "resolved_damage"), true);
    assert.equal(records.every((record) => record.outstandingExposure === 0), true);
});

test("expiring old damage updates summary totals and age reporting", () => {
    const tracker = new StrandedDamageTracker();
    tracker.recordExecutionOutcome({
        attempt: baseAttempt({ terminalState: "partially_filled", currentState: "partially_filled" }),
        outcome: baseOutcome({
            outcome: "partial_fill_insufficient_depth",
            opportunityInvalidated: false,
            partialFillDamage: 0.25,
            strandedNotional: 0,
            invalidatedBeforeSecondLeg: false,
        }),
        provenance: "paper_execution_outcome",
    });

    const openSummary = tracker.getSummary(2000);
    assert.equal(openSummary.openStrandedDamageCount, 1);
    assert.equal(openSummary.oldestOpenStrandedDamageAgeMs, 0);
    assert.equal(openSummary.outstandingStrandedExposureByType.partial_fill, 0.25);

    tracker.expireOpenDamageOlderThan(9000, 1000);
    const expiredSummary = tracker.getSummary(9000);
    assert.equal(expiredSummary.openStrandedDamageCount, 0);
    assert.equal(expiredSummary.expiredStrandedDamageCount, 1);
    assert.equal(expiredSummary.totalOutstandingStrandedExposure, 0);

    tracker.resolveAllOpen(10000, "replay_session_end_summary");
    const records = tracker.getRecords();
    assert.equal(records[0]?.currentState, "expired_damage");
});
