export type ExecutionMode = "dry_run_stub" | "replay_simulated" | "future_live_clob";

export type ExecutionRequestSource = "paper" | "replay";

export type ExecutionStrategyId = "binary_full_set_arb_v1";

export type ExecutionSide = "buy";

export type TimeInForce = "FOK" | "FAK" | "GTC";

export type ExecutionLegOrderRequest = {
    legId: string;
    tokenId: string;
    binarySide: "yes" | "no";
    side: ExecutionSide;
    limitPrice: number;
    size: number;
    timeInForce: TimeInForce;
};

export type ExecutionRequest = {
    executionAttemptId: string;
    correlationId: string;
    source: ExecutionRequestSource;
    strategyId: ExecutionStrategyId;
    marketId: string;
    slug: string;
    createdAtMs: number;
    requestedSize: number;
    legs: ExecutionLegOrderRequest[];
    notes: string[];
};

export type OrderLifecycleState =
    | "created"
    | "submit_requested"
    | "submit_denied"
    | "submitted"
    | "acknowledged"
    | "open"
    | "partially_filled"
    | "filled"
    | "cancel_requested"
    | "rejected"
    | "cancelled"
    | "expired"
    | "reconciliation_pending"
    | "reconciled";

export type OrderLifecycleTransitionReason =
    | "order_created_from_execution_request"
    | "submit_requested_by_adapter"
    | "submit_denied_execution_kill_switch"
    | "submit_denied_live_disabled"
    | "submit_denied_live_not_implemented"
    | "submitted_by_dry_run_stub"
    | "submitted_by_replay_simulated"
    | "acknowledged_by_stub"
    | "opened_by_stub"
    | "partially_filled_by_replay_simulation"
    | "filled_by_replay_simulation"
    | "cancel_requested_by_adapter"
    | "cancelled_by_stub"
    | "expired_by_stub_timeout"
    | "rejected_by_stub"
    | "reconciliation_requested"
    | "reconciled_by_stub";

export type OrderLifecycleTransition = {
    fromState: OrderLifecycleState | null;
    toState: OrderLifecycleState;
    reason: OrderLifecycleTransitionReason;
    ts: number;
};

export type OrderLifecycleRecord = {
    orderId: string;
    executionAttemptId: string;
    correlationId: string;
    legId: string;
    tokenId: string;
    binarySide: "yes" | "no";
    currentState: OrderLifecycleState;
    terminalState: OrderLifecycleState | null;
    createdAtMs: number;
    updatedAtMs: number;
    history: OrderLifecycleTransition[];
};

export type OrderStatus =
    | "created"
    | "accepted"
    | "open"
    | "partial"
    | "filled"
    | "rejected"
    | "cancelled"
    | "timed_out"
    | "unknown";

export type OrderStatusSnapshot = {
    orderId: string;
    executionAttemptId: string;
    legId: string;
    tokenId: string;
    status: OrderStatus;
    message: string;
    updatedAtMs: number;
};

export type FillEvent = {
    executionAttemptId: string;
    orderId: string;
    legId: string;
    filledSize: number;
    averageFillPrice: number;
    ts: number;
};

export type CancelResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    cancelStatus: "cancelled_stub" | "rejected_not_found" | "rejected_unsupported";
    cancelledOrderIds: string[];
    message: string;
};

export type TimeoutResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    timeoutStatus: "timed_out_stub" | "rejected_not_found" | "rejected_unsupported";
    affectedOrderIds: string[];
    message: string;
};

export type ExecutionSubmitResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    accepted: boolean;
    submitStatus:
        | "accepted_dry_run_stub"
        | "accepted_replay_simulated"
        | "rejected_live_disabled"
        | "rejected_execution_kill_switch"
        | "rejected_live_mode_not_implemented";
    message: string;
    orderStatuses: OrderStatusSnapshot[];
};

export type ExecutionStatusResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    found: boolean;
    message: string;
    orderStatuses: OrderStatusSnapshot[];
    fillEvents: FillEvent[];
};

export type SimulatedOrderLifecycleUpdate = {
    executionAttemptId: string;
    ts: number;
    legUpdates: Array<{
        legId: string;
        terminalState: Extract<OrderLifecycleState, "open" | "partially_filled" | "filled" | "rejected" | "expired" | "cancelled">;
        reason: OrderLifecycleTransitionReason;
        filledSize?: number;
        averageFillPrice?: number | null;
    }>;
    reconciliationPending?: boolean;
    reconcileNow?: boolean;
};

export type OrderLifecycleSummary = {
    ordersByTerminalState: Record<string, number>;
    transitionReasonCounts: Record<string, number>;
    submitDeniedCount: number;
    reconciliationPendingCount: number;
    averageOrderLifetimeMs: number | null;
};

export type ReconciliationSnapshot = {
    adapterMode: ExecutionMode;
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    totalExecutionRequests: number;
    totalKnownOrders: number;
    submitStatusCounts: Record<string, number>;
    orderStatusCounts: Record<string, number>;
    trackedExecutionAttemptIds: string[];
    orderLifecycleSummary: OrderLifecycleSummary;
};
