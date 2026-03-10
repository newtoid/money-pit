export type ExecutionAttemptState =
    | "detected"
    | "queued_for_execution"
    | "leg_a_pending"
    | "leg_a_filled"
    | "leg_a_failed"
    | "leg_b_pending"
    | "leg_b_filled"
    | "leg_b_failed"
    | "fully_filled"
    | "partially_filled"
    | "failed"
    | "invalidated"
    | "expired";

export type ExecutionTransitionReason =
    | "opportunity_detected"
    | "queued_after_detection"
    | "leg_a_started"
    | "leg_a_fill"
    | "leg_a_partial_fill"
    | "leg_a_failed_missing_liquidity"
    | "leg_a_failed_stale_orderbook"
    | "leg_a_failed_queue_limited"
    | "leg_a_failed_other"
    | "leg_b_started"
    | "leg_b_fill"
    | "leg_b_partial_fill"
    | "leg_b_failed_missing_liquidity"
    | "leg_b_failed_stale_orderbook"
    | "leg_b_failed_queue_limited"
    | "leg_b_failed_other"
    | "fully_filled_complete"
    | "partially_filled_complete"
    | "failed_no_fill"
    | "invalidated_before_second_leg"
    | "expired_timeout"
    | "paper_atomic_fill_assumption"
    | "paper_atomic_reject";

export type ExecutionTransition = {
    fromState: ExecutionAttemptState | null;
    toState: ExecutionAttemptState;
    reason: ExecutionTransitionReason;
    ts: number;
};

export type ExecutionAttemptRecord = {
    id: string;
    marketId: string;
    slug: string;
    detectedAt: number;
    scheduledExecutionAt: number;
    expiresAt: number;
    currentState: ExecutionAttemptState;
    history: ExecutionTransition[];
    terminalState: ExecutionAttemptState | null;
};

const TERMINAL_STATES = new Set<ExecutionAttemptState>([
    "fully_filled",
    "partially_filled",
    "failed",
    "invalidated",
    "expired",
]);

function isTerminal(state: ExecutionAttemptState) {
    return TERMINAL_STATES.has(state);
}

export class ExecutionAttemptStateMachine {
    private readonly record: ExecutionAttemptRecord;

    constructor(args: {
        id: string;
        marketId: string;
        slug: string;
        detectedAt: number;
        scheduledExecutionAt: number;
        expiresAt: number;
    }) {
        this.record = {
            id: args.id,
            marketId: args.marketId,
            slug: args.slug,
            detectedAt: args.detectedAt,
            scheduledExecutionAt: args.scheduledExecutionAt,
            expiresAt: args.expiresAt,
            currentState: "detected",
            history: [{
                fromState: null,
                toState: "detected",
                reason: "opportunity_detected",
                ts: args.detectedAt,
            }],
            terminalState: null,
        };
    }

    transition(toState: ExecutionAttemptState, reason: ExecutionTransitionReason, ts: number) {
        if (this.record.terminalState) {
            throw new Error(`Execution attempt ${this.record.id} is already terminal`);
        }
        const fromState = this.record.currentState;
        this.record.currentState = toState;
        if (isTerminal(toState)) this.record.terminalState = toState;
        this.record.history.push({ fromState, toState, reason, ts });
    }

    queue(ts: number) {
        this.transition("queued_for_execution", "queued_after_detection", ts);
    }

    startLegA(ts: number) {
        this.transition("leg_a_pending", "leg_a_started", ts);
    }

    finishLegAFilled(ts: number, partial: boolean) {
        this.transition(partial ? "leg_a_filled" : "leg_a_filled", partial ? "leg_a_partial_fill" : "leg_a_fill", ts);
    }

    failLegA(ts: number, reason: ExecutionTransitionReason) {
        this.transition("leg_a_failed", reason, ts);
        this.transition("failed", "failed_no_fill", ts);
    }

    startLegB(ts: number) {
        this.transition("leg_b_pending", "leg_b_started", ts);
    }

    finishLegBFilled(ts: number, partial: boolean) {
        this.transition("leg_b_filled", partial ? "leg_b_partial_fill" : "leg_b_fill", ts);
    }

    failLegB(ts: number, reason: ExecutionTransitionReason, invalidated: boolean) {
        this.transition("leg_b_failed", reason, ts);
        this.transition(invalidated ? "invalidated" : "failed", invalidated ? "invalidated_before_second_leg" : "failed_no_fill", ts);
    }

    complete(ts: number, partiallyFilled: boolean) {
        this.transition(partiallyFilled ? "partially_filled" : "fully_filled", partiallyFilled ? "partially_filled_complete" : "fully_filled_complete", ts);
    }

    expire(ts: number) {
        this.transition("expired", "expired_timeout", ts);
    }

    snapshot(): ExecutionAttemptRecord {
        return {
            ...this.record,
            history: this.record.history.map((item) => ({ ...item })),
        };
    }
}
