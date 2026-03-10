import {
    ExecutionMode,
    ExternalReconciliationSummary,
    ExternalOrderSnapshot,
    FillEvent,
    InternalOrderReconciliationSnapshot,
    OrderLifecycleRecord,
    OrderStatus,
    ReconciliationDiff,
    ReconciliationInput,
    ReconciliationIssue,
    ReconciliationIssueType,
    ReconciliationResult,
} from "./types";

const EPSILON = 1e-9;

function comparableStatusFromLifecycleState(state: OrderLifecycleRecord["currentState"]): OrderStatus {
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

function roundIfFinite(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) return null;
    return value;
}

function sumFillEvents(fillEvents: FillEvent[]) {
    const totalFilled = fillEvents.reduce((sum, item) => sum + item.filledSize, 0);
    if (totalFilled <= EPSILON) {
        return {
            filledSize: 0,
            averageFillPrice: null,
        };
    }
    const weighted = fillEvents.reduce((sum, item) => sum + (item.filledSize * item.averageFillPrice), 0);
    return {
        filledSize: totalFilled,
        averageFillPrice: weighted / totalFilled,
    };
}

function normalizeExternalFilledSize(order: ExternalOrderSnapshot) {
    return order.filledSize ?? 0;
}

function matchKeyForExternal(order: ExternalOrderSnapshot) {
    if (order.internalOrderId) return `internal:${order.internalOrderId}`;
    if (order.executionAttemptId && order.legId) return `attempt-leg:${order.executionAttemptId}:${order.legId}`;
    return null;
}

function matchKeyForInternal(order: InternalOrderReconciliationSnapshot) {
    return [`internal:${order.orderId}`, `attempt-leg:${order.executionAttemptId}:${order.legId}`];
}

function makeIssue(args: {
    issueType: ReconciliationIssueType;
    orderId: string | null;
    externalOrderId: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    message: string;
    details: Record<string, number | string | boolean | null>;
}): ReconciliationIssue {
    return {
        issueType: args.issueType,
        orderId: args.orderId,
        externalOrderId: args.externalOrderId,
        executionAttemptId: args.executionAttemptId,
        legId: args.legId,
        message: args.message,
        details: args.details,
    };
}

export function buildInternalReconciliationSnapshots(args: {
    orders: OrderLifecycleRecord[];
    fillEvents: FillEvent[];
}): InternalOrderReconciliationSnapshot[] {
    const fillEventsByOrder = new Map<string, FillEvent[]>();
    for (const fillEvent of args.fillEvents) {
        const current = fillEventsByOrder.get(fillEvent.orderId) ?? [];
        current.push(fillEvent);
        fillEventsByOrder.set(fillEvent.orderId, current);
    }

    return args.orders.map((order) => {
        const fillSummary = sumFillEvents(fillEventsByOrder.get(order.orderId) ?? []);
        return {
            orderId: order.orderId,
            executionAttemptId: order.executionAttemptId,
            correlationId: order.correlationId,
            legId: order.legId,
            tokenId: order.tokenId,
            binarySide: order.binarySide,
            currentState: order.currentState,
            terminalState: order.terminalState,
            comparableStatus: comparableStatusFromLifecycleState(order.currentState),
            createdAtMs: order.createdAtMs,
            updatedAtMs: order.updatedAtMs,
            filledSize: fillSummary.filledSize,
            averageFillPrice: fillSummary.averageFillPrice,
        };
    });
}

export function runNoopReconciliation(args: {
    adapterMode: ExecutionMode;
    input: ReconciliationInput;
}): ReconciliationResult {
    const issueCountsByType = {
        status_mismatch: 0,
        fill_quantity_mismatch: 0,
        fill_price_mismatch: 0,
        missing_external_order: 0,
        unexpected_external_order: 0,
        missing_external_order_id: 0,
        stale_external_snapshot: 0,
        unresolved_reconciliation_state: 0,
    } satisfies Record<ReconciliationIssueType, number>;

    return {
        adapterMode: args.adapterMode,
        comparisonMode: "noop_stub",
        capturedAtMs: args.input.capturedAtMs,
        snapshotSourceLabel: args.input.snapshot.sourceLabel,
        snapshotTrustworthy: args.input.snapshot.trustworthy,
        issueCountsByType,
        matchedOrderCount: 0,
        mismatchedOrderCount: 0,
        missingExternalOrderCount: 0,
        unexpectedExternalOrderCount: 0,
        missingExternalOrderIdCount: 0,
        staleSnapshotWarningCount: 0,
        unresolvedReconciliationCount: 0,
        diffs: [],
        issues: [],
    };
}

export function runExternalReconciliation(args: {
    adapterMode: ExecutionMode;
    input: ReconciliationInput;
    internalOrders: InternalOrderReconciliationSnapshot[];
}): ReconciliationResult {
    const issueCountsByType = {
        status_mismatch: 0,
        fill_quantity_mismatch: 0,
        fill_price_mismatch: 0,
        missing_external_order: 0,
        unexpected_external_order: 0,
        missing_external_order_id: 0,
        stale_external_snapshot: 0,
        unresolved_reconciliation_state: 0,
    } satisfies Record<ReconciliationIssueType, number>;
    const issues: ReconciliationIssue[] = [];
    const diffs: ReconciliationDiff[] = [];

    const externalByKey = new Map<string, ExternalOrderSnapshot>();
    for (const externalOrder of args.input.snapshot.orders) {
        const key = matchKeyForExternal(externalOrder);
        if (key) externalByKey.set(key, externalOrder);
    }

    const matchedExternalKeys = new Set<string>();

    if (
        args.input.snapshot.maxSnapshotAgeMs !== null
        && (args.input.capturedAtMs - args.input.snapshot.capturedAtMs) > args.input.snapshot.maxSnapshotAgeMs
    ) {
        issueCountsByType.stale_external_snapshot += 1;
        issues.push(makeIssue({
            issueType: "stale_external_snapshot",
            orderId: null,
            externalOrderId: null,
            executionAttemptId: null,
            legId: null,
            message: "external reconciliation snapshot is stale",
            details: {
                capturedAtMs: args.input.capturedAtMs,
                snapshotCapturedAtMs: args.input.snapshot.capturedAtMs,
                maxSnapshotAgeMs: args.input.snapshot.maxSnapshotAgeMs,
            },
        }));
    }

    for (const internalOrder of args.internalOrders) {
        const matchedKey = matchKeyForInternal(internalOrder).find((key) => externalByKey.has(key)) ?? null;
        const externalOrder = matchedKey ? externalByKey.get(matchedKey)! : null;
        if (matchedKey) matchedExternalKeys.add(matchedKey);

        const diffIssueTypes: ReconciliationIssueType[] = [];
        if (!externalOrder) {
            diffIssueTypes.push("missing_external_order");
            issueCountsByType.missing_external_order += 1;
            issues.push(makeIssue({
                issueType: "missing_external_order",
                orderId: internalOrder.orderId,
                externalOrderId: null,
                executionAttemptId: internalOrder.executionAttemptId,
                legId: internalOrder.legId,
                message: "no external order snapshot matched the internal order",
                details: {
                    internalStatus: internalOrder.comparableStatus,
                },
            }));
            if (internalOrder.terminalState === null) {
                diffIssueTypes.push("unresolved_reconciliation_state");
                issueCountsByType.unresolved_reconciliation_state += 1;
                issues.push(makeIssue({
                    issueType: "unresolved_reconciliation_state",
                    orderId: internalOrder.orderId,
                    externalOrderId: null,
                    executionAttemptId: internalOrder.executionAttemptId,
                    legId: internalOrder.legId,
                    message: "internal order remains non-terminal without external confirmation",
                    details: {
                        internalStatus: internalOrder.comparableStatus,
                    },
                }));
            }
            diffs.push({
                orderId: internalOrder.orderId,
                externalOrderId: null,
                executionAttemptId: internalOrder.executionAttemptId,
                legId: internalOrder.legId,
                matched: false,
                internalStatus: internalOrder.comparableStatus,
                externalStatus: null,
                internalFilledSize: internalOrder.filledSize,
                externalFilledSize: null,
                internalAverageFillPrice: roundIfFinite(internalOrder.averageFillPrice),
                externalAverageFillPrice: null,
                issueTypes: diffIssueTypes,
            });
            continue;
        }

        if (!externalOrder.externalOrderId) {
            diffIssueTypes.push("missing_external_order_id");
            issueCountsByType.missing_external_order_id += 1;
            issues.push(makeIssue({
                issueType: "missing_external_order_id",
                orderId: internalOrder.orderId,
                externalOrderId: null,
                executionAttemptId: internalOrder.executionAttemptId,
                legId: internalOrder.legId,
                message: "external snapshot matched an internal order but did not carry an external order id",
                details: {
                    externalStatus: externalOrder.status,
                },
            }));
        }

        if (internalOrder.comparableStatus !== externalOrder.status) {
            diffIssueTypes.push("status_mismatch");
            issueCountsByType.status_mismatch += 1;
            issues.push(makeIssue({
                issueType: "status_mismatch",
                orderId: internalOrder.orderId,
                externalOrderId: externalOrder.externalOrderId,
                executionAttemptId: internalOrder.executionAttemptId,
                legId: internalOrder.legId,
                message: "internal and external order status differ",
                details: {
                    internalStatus: internalOrder.comparableStatus,
                    externalStatus: externalOrder.status,
                },
            }));
        }

        if (Math.abs(internalOrder.filledSize - normalizeExternalFilledSize(externalOrder)) > EPSILON) {
            diffIssueTypes.push("fill_quantity_mismatch");
            issueCountsByType.fill_quantity_mismatch += 1;
            issues.push(makeIssue({
                issueType: "fill_quantity_mismatch",
                orderId: internalOrder.orderId,
                externalOrderId: externalOrder.externalOrderId,
                executionAttemptId: internalOrder.executionAttemptId,
                legId: internalOrder.legId,
                message: "internal and external filled size differ",
                details: {
                    internalFilledSize: internalOrder.filledSize,
                    externalFilledSize: normalizeExternalFilledSize(externalOrder),
                },
            }));
        }

        if (
            internalOrder.averageFillPrice !== null
            && externalOrder.averageFillPrice !== null
            && Math.abs(internalOrder.averageFillPrice - externalOrder.averageFillPrice) > EPSILON
        ) {
            diffIssueTypes.push("fill_price_mismatch");
            issueCountsByType.fill_price_mismatch += 1;
            issues.push(makeIssue({
                issueType: "fill_price_mismatch",
                orderId: internalOrder.orderId,
                externalOrderId: externalOrder.externalOrderId,
                executionAttemptId: internalOrder.executionAttemptId,
                legId: internalOrder.legId,
                message: "internal and external average fill price differ",
                details: {
                    internalAverageFillPrice: internalOrder.averageFillPrice,
                    externalAverageFillPrice: externalOrder.averageFillPrice,
                },
            }));
        }

        if (internalOrder.terminalState === null || externalOrder.status === "unknown") {
            diffIssueTypes.push("unresolved_reconciliation_state");
            issueCountsByType.unresolved_reconciliation_state += 1;
            issues.push(makeIssue({
                issueType: "unresolved_reconciliation_state",
                orderId: internalOrder.orderId,
                externalOrderId: externalOrder.externalOrderId,
                executionAttemptId: internalOrder.executionAttemptId,
                legId: internalOrder.legId,
                message: "reconciliation remains unresolved for a non-terminal or unknown-status order",
                details: {
                    internalStatus: internalOrder.comparableStatus,
                    externalStatus: externalOrder.status,
                },
            }));
        }

        diffs.push({
            orderId: internalOrder.orderId,
            externalOrderId: externalOrder.externalOrderId,
            executionAttemptId: internalOrder.executionAttemptId,
            legId: internalOrder.legId,
            matched: true,
            internalStatus: internalOrder.comparableStatus,
            externalStatus: externalOrder.status,
            internalFilledSize: internalOrder.filledSize,
            externalFilledSize: normalizeExternalFilledSize(externalOrder),
            internalAverageFillPrice: roundIfFinite(internalOrder.averageFillPrice),
            externalAverageFillPrice: roundIfFinite(externalOrder.averageFillPrice),
            issueTypes: diffIssueTypes,
        });
    }

    for (const externalOrder of args.input.snapshot.orders) {
        const key = matchKeyForExternal(externalOrder);
        if (key && matchedExternalKeys.has(key)) continue;
        issueCountsByType.unexpected_external_order += 1;
        issues.push(makeIssue({
            issueType: "unexpected_external_order",
            orderId: externalOrder.internalOrderId,
            externalOrderId: externalOrder.externalOrderId,
            executionAttemptId: externalOrder.executionAttemptId,
            legId: externalOrder.legId,
            message: "external order snapshot did not match any internal order",
            details: {
                externalStatus: externalOrder.status,
            },
        }));
        diffs.push({
            orderId: externalOrder.internalOrderId,
            externalOrderId: externalOrder.externalOrderId,
            executionAttemptId: externalOrder.executionAttemptId,
            legId: externalOrder.legId,
            matched: false,
            internalStatus: null,
            externalStatus: externalOrder.status,
            internalFilledSize: null,
            externalFilledSize: normalizeExternalFilledSize(externalOrder),
            internalAverageFillPrice: null,
            externalAverageFillPrice: roundIfFinite(externalOrder.averageFillPrice),
            issueTypes: ["unexpected_external_order"],
        });
    }

    const matchedOrderCount = diffs.filter((item) => item.matched && item.issueTypes.length === 0).length;
    const mismatchedOrderCount = diffs.filter((item) => item.issueTypes.length > 0).length;

    return {
        adapterMode: args.adapterMode,
        comparisonMode: "synthetic_external_snapshot_compare",
        capturedAtMs: args.input.capturedAtMs,
        snapshotSourceLabel: args.input.snapshot.sourceLabel,
        snapshotTrustworthy: args.input.snapshot.trustworthy,
        issueCountsByType,
        matchedOrderCount,
        mismatchedOrderCount,
        missingExternalOrderCount: issueCountsByType.missing_external_order,
        unexpectedExternalOrderCount: issueCountsByType.unexpected_external_order,
        missingExternalOrderIdCount: issueCountsByType.missing_external_order_id,
        staleSnapshotWarningCount: issueCountsByType.stale_external_snapshot,
        unresolvedReconciliationCount: issueCountsByType.unresolved_reconciliation_state,
        diffs,
        issues,
    };
}

export class ExternalReconciliationStore {
    private readonly results: ReconciliationResult[] = [];

    record(result: ReconciliationResult) {
        this.results.push(result);
        return result;
    }

    getLastResult() {
        return this.results.length > 0 ? this.results[this.results.length - 1] : null;
    }

    getSummary(): ExternalReconciliationSummary {
        return this.results.reduce<ExternalReconciliationSummary>((acc, result) => {
            acc.reconciliationRuns += 1;
            acc.matchedOrderCount += result.matchedOrderCount;
            acc.mismatchedOrderCount += result.mismatchedOrderCount;
            acc.missingExternalOrderCount += result.missingExternalOrderCount;
            acc.unexpectedExternalOrderCount += result.unexpectedExternalOrderCount;
            acc.missingExternalOrderIdCount += result.missingExternalOrderIdCount;
            acc.staleSnapshotWarningCount += result.staleSnapshotWarningCount;
            acc.unresolvedReconciliationCount += result.unresolvedReconciliationCount;
            acc.lastComparisonMode = result.comparisonMode;
            acc.lastSnapshotSourceLabel = result.snapshotSourceLabel;
            if (result.snapshotTrustworthy) acc.trustworthySnapshotCount += 1;
            else acc.untrustworthySnapshotCount += 1;
            for (const [issueType, count] of Object.entries(result.issueCountsByType)) {
                acc.issueCountsByType[issueType] = (acc.issueCountsByType[issueType] ?? 0) + count;
            }
            return acc;
        }, {
            reconciliationRuns: 0,
            issueCountsByType: {},
            matchedOrderCount: 0,
            mismatchedOrderCount: 0,
            missingExternalOrderCount: 0,
            unexpectedExternalOrderCount: 0,
            missingExternalOrderIdCount: 0,
            staleSnapshotWarningCount: 0,
            unresolvedReconciliationCount: 0,
            lastComparisonMode: null,
            lastSnapshotSourceLabel: null,
            trustworthySnapshotCount: 0,
            untrustworthySnapshotCount: 0,
        });
    }
}
