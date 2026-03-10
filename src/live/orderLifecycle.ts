import {
    ExecutionRequest,
    FillEvent,
    OrderLifecycleRecord,
    OrderLifecycleState,
    OrderLifecycleSummary,
    OrderLifecycleTransitionReason,
    OrderStatusSnapshot,
    SimulatedOrderLifecycleUpdate,
} from "./types";

const TERMINAL_STATES = new Set<OrderLifecycleState>([
    "submit_denied",
    "reconciled",
]);

const ALLOWED_FROM: Record<OrderLifecycleState, Array<OrderLifecycleState | null>> = {
    created: [null],
    submit_requested: ["created"],
    submit_denied: ["submit_requested"],
    submitted: ["submit_requested"],
    acknowledged: ["submitted"],
    open: ["acknowledged"],
    partially_filled: ["open", "partially_filled"],
    filled: ["open", "partially_filled", "acknowledged"],
    cancel_requested: ["open", "partially_filled", "acknowledged", "reconciliation_pending"],
    cancelled: ["cancel_requested"],
    expired: ["submit_requested", "submitted", "acknowledged", "open", "partially_filled", "reconciliation_pending"],
    rejected: ["submit_requested", "submitted", "acknowledged", "open", "reconciliation_pending"],
    reconciliation_pending: ["acknowledged", "open", "partially_filled", "filled", "cancelled", "expired", "rejected"],
    reconciled: ["reconciliation_pending"],
};

function toOrderStatus(state: OrderLifecycleState): OrderStatusSnapshot["status"] {
    if (state === "created" || state === "submit_requested") return "created";
    if (state === "submitted" || state === "acknowledged") return "accepted";
    if (state === "open" || state === "reconciliation_pending" || state === "reconciled") return "open";
    if (state === "partially_filled") return "partial";
    if (state === "filled") return "filled";
    if (state === "cancelled") return "cancelled";
    if (state === "expired") return "timed_out";
    if (state === "submit_denied" || state === "rejected") return "rejected";
    return "unknown";
}

export class OrderLifecycleStore {
    private readonly orders = new Map<string, OrderLifecycleRecord>();
    private readonly orderIdsByExecutionAttempt = new Map<string, string[]>();
    private readonly fillEvents = new Map<string, FillEvent[]>();

    createFromExecutionRequest(request: ExecutionRequest): OrderLifecycleRecord[] {
        const records = request.legs.map((leg, index) => {
            const orderId = `${request.executionAttemptId}-order-${index + 1}`;
            const record: OrderLifecycleRecord = {
                orderId,
                executionAttemptId: request.executionAttemptId,
                correlationId: request.correlationId,
                legId: leg.legId,
                tokenId: leg.tokenId,
                binarySide: leg.binarySide,
                currentState: "created",
                terminalState: null,
                createdAtMs: request.createdAtMs,
                updatedAtMs: request.createdAtMs,
                history: [{
                    fromState: null,
                    toState: "created",
                    reason: "order_created_from_execution_request",
                    ts: request.createdAtMs,
                }],
            };
            this.orders.set(orderId, record);
            return record;
        });
        this.orderIdsByExecutionAttempt.set(request.executionAttemptId, records.map((item) => item.orderId));
        return records.map((item) => this.snapshot(item.orderId)!);
    }

    transitionExecutionAttempt(
        executionAttemptId: string,
        toState: OrderLifecycleState,
        reason: OrderLifecycleTransitionReason,
        ts: number,
    ) {
        for (const orderId of this.orderIdsByExecutionAttempt.get(executionAttemptId) ?? []) {
            this.transitionOrder(orderId, toState, reason, ts);
        }
    }

    transitionOrder(
        orderId: string,
        toState: OrderLifecycleState,
        reason: OrderLifecycleTransitionReason,
        ts: number,
    ) {
        const record = this.orders.get(orderId);
        if (!record) throw new Error(`Order ${orderId} not found`);
        if (record.terminalState === "reconciled" || record.terminalState === "submit_denied") {
            throw new Error(`Order ${orderId} is already terminal`);
        }
        const allowed = ALLOWED_FROM[toState];
        if (!allowed.includes(record.currentState)) {
            throw new Error(`Illegal order transition ${record.currentState} -> ${toState} for ${orderId}`);
        }
        const fromState = record.currentState;
        record.currentState = toState;
        record.updatedAtMs = ts;
        if (TERMINAL_STATES.has(toState)) record.terminalState = toState;
        record.history.push({
            fromState,
            toState,
            reason,
            ts,
        });
    }

    applySimulatedUpdate(update: SimulatedOrderLifecycleUpdate) {
        for (const legUpdate of update.legUpdates) {
            const orderId = this.findOrderId(update.executionAttemptId, legUpdate.legId);
            if (!orderId) continue;
            const record = this.orders.get(orderId)!;
            if (record.currentState === "acknowledged") {
                this.transitionOrder(orderId, "open", "opened_by_stub", update.ts);
            }
            this.transitionOrder(orderId, legUpdate.terminalState, legUpdate.reason, update.ts);
            if (legUpdate.filledSize && legUpdate.averageFillPrice !== null && legUpdate.averageFillPrice !== undefined) {
                const current = this.fillEvents.get(orderId) ?? [];
                current.push({
                    executionAttemptId: update.executionAttemptId,
                    orderId,
                    legId: legUpdate.legId,
                    filledSize: legUpdate.filledSize,
                    averageFillPrice: legUpdate.averageFillPrice,
                    ts: update.ts,
                });
                this.fillEvents.set(orderId, current);
            }
        }
        if (update.reconciliationPending) {
            this.transitionExecutionAttempt(update.executionAttemptId, "reconciliation_pending", "reconciliation_requested", update.ts);
        }
        if (update.reconcileNow) {
            this.transitionExecutionAttempt(update.executionAttemptId, "reconciled", "reconciled_by_stub", update.ts);
        }
    }

    getOrderSnapshotsForExecutionAttempt(executionAttemptId: string): OrderStatusSnapshot[] {
        return (this.orderIdsByExecutionAttempt.get(executionAttemptId) ?? [])
            .map((orderId) => this.orders.get(orderId))
            .filter((item): item is OrderLifecycleRecord => Boolean(item))
            .map((item) => ({
                orderId: item.orderId,
                executionAttemptId: item.executionAttemptId,
                legId: item.legId,
                tokenId: item.tokenId,
                status: toOrderStatus(item.currentState),
                message: item.history[item.history.length - 1]?.reason ?? "unknown",
                updatedAtMs: item.updatedAtMs,
            }));
    }

    getFillEventsForExecutionAttempt(executionAttemptId: string): FillEvent[] {
        return (this.orderIdsByExecutionAttempt.get(executionAttemptId) ?? [])
            .flatMap((orderId) => this.fillEvents.get(orderId) ?? [])
            .map((item) => ({ ...item }));
    }

    getSummary(): OrderLifecycleSummary {
        const ordersByTerminalState = Array.from(this.orders.values()).reduce<Record<string, number>>((acc, order) => {
            const key = order.terminalState ?? "non_terminal";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
        }, {});
        const transitionReasonCounts = Array.from(this.orders.values()).flatMap((order) => order.history).reduce<Record<string, number>>((acc, item) => {
            acc[item.reason] = (acc[item.reason] ?? 0) + 1;
            return acc;
        }, {});
        const lifetimes = Array.from(this.orders.values())
            .filter((order) => order.terminalState !== null)
            .map((order) => order.updatedAtMs - order.createdAtMs);
        return {
            ordersByTerminalState,
            transitionReasonCounts,
            submitDeniedCount: Array.from(this.orders.values()).filter((order) => order.terminalState === "submit_denied").length,
            reconciliationPendingCount: Array.from(this.orders.values()).filter((order) => order.currentState === "reconciliation_pending").length,
            averageOrderLifetimeMs: lifetimes.length > 0
                ? lifetimes.reduce((sum, value) => sum + value, 0) / lifetimes.length
                : null,
        };
    }

    getTotalKnownOrders() {
        return this.orders.size;
    }

    getTrackedExecutionAttemptIds() {
        return Array.from(this.orderIdsByExecutionAttempt.keys());
    }

    private findOrderId(executionAttemptId: string, legId: string) {
        return (this.orderIdsByExecutionAttempt.get(executionAttemptId) ?? []).find((orderId) => this.orders.get(orderId)?.legId === legId) ?? null;
    }

    private snapshot(orderId: string) {
        const order = this.orders.get(orderId);
        if (!order) return null;
        return {
            ...order,
            history: order.history.map((item) => ({ ...item })),
        };
    }
}
