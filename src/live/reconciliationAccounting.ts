import {
    ExternalFillSnapshot,
    ExternalOrderSnapshot,
    InternalOrderReconciliationSnapshot,
    ReconciliationAccountingComparison,
    ReconciliationAccountingField,
    ReconciliationAccountingIssueType,
    ReconciliationMatchingOutcome,
} from "./types";

const EPSILON = 1e-9;

function statusRank(status: ExternalOrderSnapshot["status"] | InternalOrderReconciliationSnapshot["comparableStatus"]) {
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
        case "expired":
            return 5;
        case "rejected":
            return 6;
        default:
            return 7;
    }
}

function sumExternalFillNotional(fills: ExternalFillSnapshot[]) {
    return fills.reduce((sum, fill) => {
        if (fill.averageFillPrice === null) return sum;
        return sum + (fill.filledSize * fill.averageFillPrice);
    }, 0);
}

export function compareExternalAccounting(args: {
    internalOrder: InternalOrderReconciliationSnapshot;
    externalOrder: ExternalOrderSnapshot;
    matchedExternalFills: ExternalFillSnapshot[];
}): ReconciliationAccountingComparison {
    const issueTypes: ReconciliationAccountingIssueType[] = [];
    const skippedFields: ReconciliationAccountingField[] = [];

    const externalFillCount = args.externalOrder.externalFillCount ?? args.matchedExternalFills.length;
    const externalNotional = args.externalOrder.totalFilledNotional ?? (
        args.matchedExternalFills.length > 0 ? sumExternalFillNotional(args.matchedExternalFills) : null
    );
    const externalAvgPrice = args.externalOrder.averageFillPrice;
    const externalPartialFillObserved = args.externalOrder.partialFillObserved
        ?? (args.externalOrder.status === "partial");
    const externalStatusRank = statusRank(args.externalOrder.status);

    if (args.internalOrder.fillEventCount > 0 || externalFillCount > 0) {
        if (args.internalOrder.fillEventCount !== externalFillCount) {
            issueTypes.push("external_internal_fill_count_mismatch");
        }
    } else {
        skippedFields.push("fill_count");
    }

    if (args.internalOrder.filledNotional !== null && externalNotional !== null) {
        if (Math.abs(args.internalOrder.filledNotional - externalNotional) > EPSILON) {
            issueTypes.push("external_internal_notional_mismatch");
        }
    } else {
        skippedFields.push("filled_notional");
    }

    if (args.internalOrder.averageFillPrice !== null && externalAvgPrice !== null) {
        if (Math.abs(args.internalOrder.averageFillPrice - externalAvgPrice) > EPSILON) {
            issueTypes.push("external_internal_avg_price_mismatch");
        }
    } else {
        skippedFields.push("avg_fill_price");
    }

    if (args.internalOrder.statusProgressionRank !== externalStatusRank) {
        issueTypes.push("external_internal_status_progression_mismatch");
    }

    if (args.internalOrder.partialFillObserved !== externalPartialFillObserved) {
        issueTypes.push("external_internal_partial_fill_mismatch");
    }

    return {
        orderId: args.internalOrder.orderId,
        externalOrderId: args.externalOrder.externalOrderId,
        issueTypes,
        skippedFields,
        details: {
            internalFillEventCount: args.internalOrder.fillEventCount,
            externalFillCount,
            internalFilledNotional: args.internalOrder.filledNotional,
            externalFilledNotional: externalNotional,
            internalAverageFillPrice: args.internalOrder.averageFillPrice,
            externalAverageFillPrice: externalAvgPrice,
            internalStatusProgressionRank: args.internalOrder.statusProgressionRank,
            externalStatusProgressionRank: externalStatusRank,
            internalPartialFillObserved: args.internalOrder.partialFillObserved,
            externalPartialFillObserved,
        },
    };
}

export function indexMatchedExternalFills(args: {
    externalFills: ExternalFillSnapshot[];
    fillMatchingOutcomes: ReconciliationMatchingOutcome[];
}) {
    const byInternalOrderId = new Map<string, ExternalFillSnapshot[]>();
    args.fillMatchingOutcomes.forEach((outcome, index) => {
        if (!outcome.matchedInternalOrderId) return;
        const fill = args.externalFills[index];
        if (!fill) return;
        const current = byInternalOrderId.get(outcome.matchedInternalOrderId) ?? [];
        current.push(fill);
        byInternalOrderId.set(outcome.matchedInternalOrderId, current);
    });
    return byInternalOrderId;
}
