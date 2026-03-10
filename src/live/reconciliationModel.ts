import {
    ExecutionMode,
    ExternalReconciliationSummary,
    FillEvent,
    InternalOrderReconciliationSnapshot,
    OrderLifecycleRecord,
    OrderStatus,
    ReconciliationDiff,
    ReconciliationInput,
    ReconciliationIssue,
    ReconciliationIssueType,
    ReconciliationResult,
    SnapshotNormalizationResult,
} from "./types";
import { compareExternalAccounting, indexMatchedExternalFills } from "./reconciliationAccounting";
import { matchExternalSnapshots } from "./reconciliationMatching";

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
            fillEventCount: 0,
            filledNotional: null,
            partialFillObserved: false,
        };
    }
    const weighted = fillEvents.reduce((sum, item) => sum + (item.filledSize * item.averageFillPrice), 0);
    return {
        filledSize: totalFilled,
        averageFillPrice: weighted / totalFilled,
        fillEventCount: fillEvents.length,
        filledNotional: weighted,
        partialFillObserved: fillEvents.length > 1,
    };
}

function statusProgressionRank(status: OrderStatus) {
    switch (status) {
        case "created":
            return 0;
        case "accepted":
            return 1;
        case "open":
            return 2;
        case "partial":
            return 3;
        case "filled":
            return 4;
        case "cancelled":
        case "timed_out":
            return 5;
        case "rejected":
            return 6;
        default:
            return 7;
    }
}

function normalizeExternalFilledSize(order: { filledSize: number | null }) {
    return order.filledSize ?? 0;
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
            fillEventCount: fillSummary.fillEventCount,
            filledNotional: fillSummary.filledNotional,
            partialFillObserved: fillSummary.partialFillObserved,
            statusProgressionRank: statusProgressionRank(comparableStatusFromLifecycleState(order.currentState)),
            knownExternalOrderId: null,
            knownExternalExecutionId: null,
            knownExternalFillIds: [],
            knownVenueOrderRef: null,
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
        snapshotProvenance: args.input.snapshot.provenance,
        snapshotSourceLabel: args.input.snapshot.sourceLabel,
        snapshotTrustworthy: args.input.snapshot.trustworthy,
        issueCountsByType,
        accountingIssueCountsByType: {},
        matchCountsByRule: {},
        unmatchedCountsByReason: {},
        ambiguousMatchCount: 0,
        conflictingIdentifierCount: 0,
        duplicateExternalSnapshotCount: 0,
        matchedOrderCount: 0,
        mismatchedOrderCount: 0,
        missingExternalOrderCount: 0,
        unexpectedExternalOrderCount: 0,
        missingExternalOrderIdCount: 0,
        staleSnapshotWarningCount: 0,
        unresolvedReconciliationCount: 0,
        comparisonCoverageCounts: {},
        skippedAccountingFields: {},
        matchedOrdersWithAccountingAgreement: 0,
        matchedOrdersWithAccountingDisagreement: 0,
        matchingOutcomes: [],
        accountingComparisons: [],
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
    const matching = matchExternalSnapshots({
        internalOrders: args.internalOrders,
        externalOrders: args.input.snapshot.orders,
        externalFills: args.input.snapshot.fills,
    });
    const matchCountsByRule = matching.allOutcomes.reduce<Record<string, number>>((acc, item) => {
        if (!item.matchRule) return acc;
        acc[item.matchRule] = (acc[item.matchRule] ?? 0) + 1;
        return acc;
    }, {});
    const unmatchedCountsByReason = matching.allOutcomes.reduce<Record<string, number>>((acc, item) => {
        for (const issueType of item.issueTypes) {
            acc[issueType] = (acc[issueType] ?? 0) + 1;
        }
        return acc;
    }, {});
    const orderMatchByReference = new Map(matching.orderOutcomes.map((item) => [item.externalReference, item]));
    const internalOrderById = new Map(args.internalOrders.map((item) => [item.orderId, item]));
    const matchedExternalFillsByOrderId = indexMatchedExternalFills({
        externalFills: args.input.snapshot.fills,
        fillMatchingOutcomes: matching.fillOutcomes,
    });
    const accountingIssueCountsByType: Record<string, number> = {};
    const comparisonCoverageCounts: Record<string, number> = {};
    const skippedAccountingFields: Record<string, number> = {};
    const accountingComparisons = [];
    let matchedOrdersWithAccountingAgreement = 0;
    let matchedOrdersWithAccountingDisagreement = 0;

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

    const matchedInternalOrderIds = new Set<string>();
    for (const externalOrder of args.input.snapshot.orders) {
        const externalReference = [
            "order",
            externalOrder.externalOrderId ?? "no-order-id",
            externalOrder.externalExecutionId ?? "no-exec-id",
            "no-fill-id",
            externalOrder.executionAttemptId ?? "no-attempt",
            externalOrder.legId ?? "no-leg",
            externalOrder.correlationId ?? "no-correlation",
        ].join(":");
        const matchOutcome = orderMatchByReference.get(externalReference) ?? null;
        const diffIssueTypes: ReconciliationIssueType[] = [];
        const internalOrder = matchOutcome?.matchedInternalOrderId
            ? internalOrderById.get(matchOutcome.matchedInternalOrderId) ?? null
            : null;

        if (!internalOrder) {
            diffIssueTypes.push("unexpected_external_order");
            issueCountsByType.unexpected_external_order += 1;
            issues.push(makeIssue({
                issueType: "unexpected_external_order",
                orderId: null,
                externalOrderId: externalOrder.externalOrderId,
                executionAttemptId: externalOrder.executionAttemptId,
                legId: externalOrder.legId,
                message: "external order snapshot did not produce a unique internal match",
                details: {
                    matchIssues: matchOutcome?.issueTypes.join(",") ?? "no_match",
                },
            }));
            diffs.push({
                orderId: null,
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
                issueTypes: diffIssueTypes,
                accountingIssueTypes: [],
            });
            continue;
        }
        matchedInternalOrderIds.add(internalOrder.orderId);

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

        const accountingComparison = compareExternalAccounting({
            internalOrder,
            externalOrder,
            matchedExternalFills: matchedExternalFillsByOrderId.get(internalOrder.orderId) ?? [],
        });
        accountingComparisons.push(accountingComparison);
        if (accountingComparison.issueTypes.length === 0) matchedOrdersWithAccountingAgreement += 1;
        else matchedOrdersWithAccountingDisagreement += 1;
        for (const issueType of accountingComparison.issueTypes) {
            accountingIssueCountsByType[issueType] = (accountingIssueCountsByType[issueType] ?? 0) + 1;
        }
        comparisonCoverageCounts.order_accounting_compared = (comparisonCoverageCounts.order_accounting_compared ?? 0) + 1;
        if (internalOrder.fillEventCount > 0 || externalOrder.externalFillCount !== null) {
            comparisonCoverageCounts.fill_count = (comparisonCoverageCounts.fill_count ?? 0) + 1;
        }
        if (internalOrder.filledNotional !== null && (externalOrder.totalFilledNotional !== null || (matchedExternalFillsByOrderId.get(internalOrder.orderId)?.length ?? 0) > 0)) {
            comparisonCoverageCounts.filled_notional = (comparisonCoverageCounts.filled_notional ?? 0) + 1;
        }
        if (internalOrder.averageFillPrice !== null && externalOrder.averageFillPrice !== null) {
            comparisonCoverageCounts.avg_fill_price = (comparisonCoverageCounts.avg_fill_price ?? 0) + 1;
        }
        comparisonCoverageCounts.status_progression = (comparisonCoverageCounts.status_progression ?? 0) + 1;
        comparisonCoverageCounts.partial_fill_flag = (comparisonCoverageCounts.partial_fill_flag ?? 0) + 1;
        for (const skippedField of accountingComparison.skippedFields) {
            skippedAccountingFields[skippedField] = (skippedAccountingFields[skippedField] ?? 0) + 1;
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
            accountingIssueTypes: accountingComparison.issueTypes,
        });
    }

    for (const internalOrder of args.internalOrders) {
        if (matchedInternalOrderIds.has(internalOrder.orderId)) continue;
        issueCountsByType.missing_external_order += 1;
        issues.push(makeIssue({
            issueType: "missing_external_order",
            orderId: internalOrder.orderId,
            externalOrderId: null,
            executionAttemptId: internalOrder.executionAttemptId,
            legId: internalOrder.legId,
            message: "internal order has no matched external snapshot",
            details: {
                internalStatus: internalOrder.comparableStatus,
            },
        }));
        if (internalOrder.terminalState === null) {
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
    }

    const matchedOrderCount = diffs.filter((item) => item.matched && item.issueTypes.length === 0).length;
    const mismatchedOrderCount = diffs.filter((item) => item.issueTypes.length > 0).length;

    return {
        adapterMode: args.adapterMode,
        comparisonMode: "synthetic_external_snapshot_compare",
        capturedAtMs: args.input.capturedAtMs,
        snapshotProvenance: args.input.snapshot.provenance,
        snapshotSourceLabel: args.input.snapshot.sourceLabel,
        snapshotTrustworthy: args.input.snapshot.trustworthy,
        issueCountsByType,
        accountingIssueCountsByType,
        matchCountsByRule,
        unmatchedCountsByReason,
        ambiguousMatchCount: (unmatchedCountsByReason.unmatched_ambiguous_candidates ?? 0) + (unmatchedCountsByReason.duplicate_internal_candidates ?? 0),
        conflictingIdentifierCount: unmatchedCountsByReason.conflicting_identifier_data ?? 0,
        duplicateExternalSnapshotCount: unmatchedCountsByReason.duplicate_external_snapshot ?? 0,
        matchedOrderCount,
        mismatchedOrderCount,
        missingExternalOrderCount: issueCountsByType.missing_external_order,
        unexpectedExternalOrderCount: issueCountsByType.unexpected_external_order,
        missingExternalOrderIdCount: issueCountsByType.missing_external_order_id,
        staleSnapshotWarningCount: issueCountsByType.stale_external_snapshot,
        unresolvedReconciliationCount: issueCountsByType.unresolved_reconciliation_state,
        comparisonCoverageCounts,
        skippedAccountingFields,
        matchedOrdersWithAccountingAgreement,
        matchedOrdersWithAccountingDisagreement,
        matchingOutcomes: matching.allOutcomes,
        accountingComparisons,
        diffs,
        issues,
    };
}

export class ExternalReconciliationStore {
    private readonly results: ReconciliationResult[] = [];
    private readonly normalizationResults: SnapshotNormalizationResult[] = [];

    record(result: ReconciliationResult) {
        this.results.push(result);
        return result;
    }

    recordNormalization(result: SnapshotNormalizationResult) {
        this.normalizationResults.push(result);
        return result;
    }

    getLastResult() {
        return this.results.length > 0 ? this.results[this.results.length - 1] : null;
    }

    getSummary(): ExternalReconciliationSummary {
        const summary = this.results.reduce<ExternalReconciliationSummary>((acc, result) => {
            acc.reconciliationRuns += 1;
            for (const [rule, count] of Object.entries(result.matchCountsByRule)) {
                acc.matchCountsByRule[rule] = (acc.matchCountsByRule[rule] ?? 0) + count;
            }
            for (const [issueType, count] of Object.entries(result.accountingIssueCountsByType)) {
                acc.accountingIssueCountsByType[issueType] = (acc.accountingIssueCountsByType[issueType] ?? 0) + count;
            }
            for (const [reason, count] of Object.entries(result.unmatchedCountsByReason)) {
                acc.unmatchedCountsByReason[reason] = (acc.unmatchedCountsByReason[reason] ?? 0) + count;
            }
            acc.ambiguousMatchCount += result.ambiguousMatchCount;
            acc.conflictingIdentifierCount += result.conflictingIdentifierCount;
            acc.duplicateExternalSnapshotCount += result.duplicateExternalSnapshotCount;
            acc.matchedOrderCount += result.matchedOrderCount;
            acc.mismatchedOrderCount += result.mismatchedOrderCount;
            acc.missingExternalOrderCount += result.missingExternalOrderCount;
            acc.unexpectedExternalOrderCount += result.unexpectedExternalOrderCount;
            acc.missingExternalOrderIdCount += result.missingExternalOrderIdCount;
            acc.staleSnapshotWarningCount += result.staleSnapshotWarningCount;
            acc.unresolvedReconciliationCount += result.unresolvedReconciliationCount;
            acc.matchedOrdersWithAccountingAgreement += result.matchedOrdersWithAccountingAgreement;
            acc.matchedOrdersWithAccountingDisagreement += result.matchedOrdersWithAccountingDisagreement;
            acc.lastComparisonMode = result.comparisonMode;
            acc.lastSnapshotSourceLabel = result.snapshotSourceLabel;
            if (result.snapshotTrustworthy) acc.trustworthySnapshotCount += 1;
            else acc.untrustworthySnapshotCount += 1;
            acc.snapshotsIngestedByProvenance[result.snapshotProvenance] = (acc.snapshotsIngestedByProvenance[result.snapshotProvenance] ?? 0) + 1;
            for (const [issueType, count] of Object.entries(result.issueCountsByType)) {
                acc.issueCountsByType[issueType] = (acc.issueCountsByType[issueType] ?? 0) + count;
            }
            for (const [field, count] of Object.entries(result.comparisonCoverageCounts)) {
                acc.comparisonCoverageCounts[field] = (acc.comparisonCoverageCounts[field] ?? 0) + count;
            }
            for (const [field, count] of Object.entries(result.skippedAccountingFields)) {
                acc.skippedAccountingFields[field] = (acc.skippedAccountingFields[field] ?? 0) + count;
            }
            return acc;
        }, {
            reconciliationRuns: 0,
            issueCountsByType: {},
            accountingIssueCountsByType: {},
            matchCountsByRule: {},
            unmatchedCountsByReason: {},
            ambiguousMatchCount: 0,
            conflictingIdentifierCount: 0,
            duplicateExternalSnapshotCount: 0,
            matchedOrderCount: 0,
            mismatchedOrderCount: 0,
            missingExternalOrderCount: 0,
            unexpectedExternalOrderCount: 0,
            missingExternalOrderIdCount: 0,
            staleSnapshotWarningCount: 0,
            unresolvedReconciliationCount: 0,
            comparisonCoverageCounts: {},
            skippedAccountingFields: {},
            matchedOrdersWithAccountingAgreement: 0,
            matchedOrdersWithAccountingDisagreement: 0,
            lastComparisonMode: null,
            lastSnapshotSourceLabel: null,
            trustworthySnapshotCount: 0,
            untrustworthySnapshotCount: 0,
            snapshotsIngestedByProvenance: {},
            snapshotsMissingExternalIdentifiers: 0,
            malformedSnapshotRejectCount: 0,
            staleSnapshotInputCount: 0,
            normalizationWarningCounts: {},
        });
        for (const normalization of this.normalizationResults) {
            if (!normalization.accepted) {
                summary.malformedSnapshotRejectCount += 1;
                continue;
            }
            const snapshot = normalization.snapshot;
            if (!snapshot) continue;
            const missingIds = snapshot.orders.filter((order) => !order.externalOrderId && !order.externalExecutionId && !order.venueOrderRef).length
                + snapshot.fills.filter((fill) => !fill.externalOrderId && !fill.externalExecutionId && !fill.externalFillId && !fill.venueOrderRef).length;
            if (missingIds > 0) summary.snapshotsMissingExternalIdentifiers += 1;
            for (const warning of normalization.warnings) {
                summary.normalizationWarningCounts[warning.warningType] = (summary.normalizationWarningCounts[warning.warningType] ?? 0) + 1;
                if (warning.warningType === "stale_snapshot_input") {
                    summary.staleSnapshotInputCount += 1;
                }
            }
        }
        return summary;
    }
}
