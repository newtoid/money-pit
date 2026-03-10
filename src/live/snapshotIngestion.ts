import {
    ExternalExecutionSnapshot,
    ExternalFillSnapshot,
    ExternalOrderSnapshot,
    ExternalSnapshotExecutionIngestion,
    ExternalSnapshotFillIngestion,
    ExternalSnapshotOrderIngestion,
    SnapshotNormalizationResult,
    SnapshotNormalizationWarning,
} from "./types";

function parseNumberLike(value: number | string | null | undefined) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function parseStringLike(value: string | null | undefined) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeStatus(raw: string | null, warnings: SnapshotNormalizationWarning[], scopeLabel: string) {
    const normalized = raw?.toLowerCase() ?? null;
    switch (normalized) {
        case "accepted":
        case "open":
        case "partial":
        case "filled":
        case "cancelled":
        case "expired":
        case "rejected":
        case "unknown":
            return normalized;
        default:
            warnings.push({
                warningType: "unknown_status_value",
                scope: "order",
                message: "unknown external order status value normalized to unknown",
                details: {
                    scopeLabel,
                    rawStatus: raw,
                },
            });
            return "unknown";
    }
}

function normalizeOrder(
    order: ExternalSnapshotOrderIngestion,
    index: number,
    warnings: SnapshotNormalizationWarning[],
): ExternalOrderSnapshot {
    const filledSize = parseNumberLike(order.filledSize);
    if (order.filledSize !== undefined && order.filledSize !== null && filledSize === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "order",
            message: "invalid filled size normalized to null",
            details: {
                index,
                field: "filledSize",
            },
        });
    }
    const averageFillPrice = parseNumberLike(order.averageFillPrice);
    if (order.averageFillPrice !== undefined && order.averageFillPrice !== null && averageFillPrice === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "order",
            message: "invalid average fill price normalized to null",
            details: {
                index,
                field: "averageFillPrice",
            },
        });
    }
    const observedAtMs = parseNumberLike(order.observedAtMs);
    const externalFillCount = parseNumberLike(order.externalFillCount);
    const totalFilledNotional = parseNumberLike(order.totalFilledNotional);
    if (observedAtMs === null) {
        warnings.push({
            warningType: "missing_timestamp",
            scope: "order",
            message: "missing order observedAtMs; snapshot capturedAtMs will be used by caller if needed",
            details: {
                index,
                field: "observedAtMs",
            },
        });
    }
    if (order.externalFillCount !== undefined && order.externalFillCount !== null && externalFillCount === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "order",
            message: "invalid external fill count normalized to null",
            details: {
                index,
                field: "externalFillCount",
            },
        });
    }
    if (order.totalFilledNotional !== undefined && order.totalFilledNotional !== null && totalFilledNotional === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "order",
            message: "invalid total filled notional normalized to null",
            details: {
                index,
                field: "totalFilledNotional",
            },
        });
    }
    const internalOrderId = parseStringLike(order.internalOrderId);
    const externalOrderId = parseStringLike(order.externalOrderId);
    const executionAttemptId = parseStringLike(order.executionAttemptId);
    const legId = parseStringLike(order.legId);
    if (!externalOrderId && !parseStringLike(order.externalExecutionId) && !parseStringLike(order.venueOrderRef)) {
        warnings.push({
            warningType: "missing_external_identifiers",
            scope: "order",
            message: "external order snapshot is missing external identifiers",
            details: {
                index,
            },
        });
    }
    if (!internalOrderId && !(executionAttemptId && legId)) {
        warnings.push({
            warningType: "missing_internal_match_keys",
            scope: "order",
            message: "external order snapshot is missing internal matching keys",
            details: {
                index,
            },
        });
    }
    return {
        internalOrderId,
        externalOrderId,
        externalExecutionId: parseStringLike(order.externalExecutionId),
        venueOrderRef: parseStringLike(order.venueOrderRef),
        executionAttemptId,
        correlationId: parseStringLike(order.correlationId),
        legId,
        tokenId: parseStringLike(order.tokenId),
        status: normalizeStatus(parseStringLike(order.status), warnings, `order:${index}`),
        filledSize,
        averageFillPrice,
        externalFillCount,
        totalFilledNotional,
        partialFillObserved: typeof order.partialFillObserved === "boolean" ? order.partialFillObserved : null,
        observedAtMs: observedAtMs ?? 0,
        rawSourceMetadata: order.rawSourceMetadata ?? null,
    };
}

function normalizeFill(
    fill: ExternalSnapshotFillIngestion,
    index: number,
    warnings: SnapshotNormalizationWarning[],
): ExternalFillSnapshot {
    const filledSize = parseNumberLike(fill.filledSize);
    const averageFillPrice = parseNumberLike(fill.averageFillPrice);
    const observedAtMs = parseNumberLike(fill.observedAtMs);
    if (filledSize === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "fill",
            message: "missing or invalid fill size normalized to 0",
            details: {
                index,
                field: "filledSize",
            },
        });
    }
    if (fill.averageFillPrice !== undefined && fill.averageFillPrice !== null && averageFillPrice === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "fill",
            message: "invalid fill average price normalized to null",
            details: {
                index,
                field: "averageFillPrice",
            },
        });
    }
    if (observedAtMs === null) {
        warnings.push({
            warningType: "missing_timestamp",
            scope: "fill",
            message: "missing fill observedAtMs; snapshot capturedAtMs will be used by caller if needed",
            details: {
                index,
                field: "observedAtMs",
            },
        });
    }
    if (!parseStringLike(fill.externalOrderId) && !parseStringLike(fill.externalFillId) && !parseStringLike(fill.externalExecutionId)) {
        warnings.push({
            warningType: "missing_external_identifiers",
            scope: "fill",
            message: "external fill snapshot is missing external identifiers",
            details: {
                index,
            },
        });
    }
    return {
        internalOrderId: parseStringLike(fill.internalOrderId),
        externalOrderId: parseStringLike(fill.externalOrderId),
        externalExecutionId: parseStringLike(fill.externalExecutionId),
        externalFillId: parseStringLike(fill.externalFillId),
        venueOrderRef: parseStringLike(fill.venueOrderRef),
        executionAttemptId: parseStringLike(fill.executionAttemptId),
        legId: parseStringLike(fill.legId),
        filledSize: filledSize ?? 0,
        averageFillPrice,
        observedAtMs: observedAtMs ?? 0,
        rawSourceMetadata: fill.rawSourceMetadata ?? null,
    };
}

export function normalizeExternalSnapshotIngestion(input: ExternalSnapshotExecutionIngestion): SnapshotNormalizationResult {
    const warnings: SnapshotNormalizationWarning[] = [];
    const sourceLabel = parseStringLike(input.sourceLabel);
    if (!sourceLabel) {
        return {
            accepted: false,
            rejectReason: "missing_source_label",
            snapshot: null,
            warnings,
        };
    }
    const capturedAtMs = parseNumberLike(input.capturedAtMs);
    if (capturedAtMs === null) {
        return {
            accepted: false,
            rejectReason: "invalid_captured_at",
            snapshot: null,
            warnings,
        };
    }
    if (!input.orders && !input.fills) {
        return {
            accepted: false,
            rejectReason: "missing_snapshot_payload",
            snapshot: null,
            warnings,
        };
    }

    const maxSnapshotAgeMs = parseNumberLike(input.maxSnapshotAgeMs);
    const ingestedAtMs = parseNumberLike(input.ingestedAtMs);
    if (input.maxSnapshotAgeMs !== undefined && input.maxSnapshotAgeMs !== null && maxSnapshotAgeMs === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "snapshot",
            message: "invalid maxSnapshotAgeMs normalized to null",
            details: {
                field: "maxSnapshotAgeMs",
            },
        });
    }
    if (input.ingestedAtMs !== undefined && input.ingestedAtMs !== null && ingestedAtMs === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "snapshot",
            message: "invalid ingestedAtMs normalized to null",
            details: {
                field: "ingestedAtMs",
            },
        });
    }
    const orders = (input.orders ?? []).map((order, index) => normalizeOrder(order, index, warnings));
    const fills = (input.fills ?? []).map((fill, index) => normalizeFill(fill, index, warnings));
    const snapshot: ExternalExecutionSnapshot = {
        provenance: input.provenance,
        sourceLabel,
        capturedAtMs,
        maxSnapshotAgeMs,
        trustworthy: input.trustworthy ?? false,
        orders,
        fills,
        rawSourceMetadata: input.rawSourceMetadata ?? null,
    };
    if (ingestedAtMs !== null && maxSnapshotAgeMs !== null && (ingestedAtMs - capturedAtMs) > maxSnapshotAgeMs) {
        warnings.push({
            warningType: "stale_snapshot_input",
            scope: "snapshot",
            message: "snapshot was ingested already stale",
            details: {
                capturedAtMs,
                ingestedAtMs,
                maxSnapshotAgeMs,
            },
        });
    }
    return {
        accepted: true,
        rejectReason: null,
        snapshot,
        warnings,
    };
}
