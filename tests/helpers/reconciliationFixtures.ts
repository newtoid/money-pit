import { Opportunity } from "../../src/arbScanner/types";
import { buildExecutionRequest } from "../../src/live/buildExecutionRequest";
import { OrderLifecycleStore } from "../../src/live/orderLifecycle";
import {
    ExternalAccountSnapshot,
    ExternalExecutionSnapshot,
    ExternalFillSnapshot,
    InternalAccountBalanceSnapshot,
    ExternalOrderSnapshot,
    InternalOrderReconciliationSnapshot,
} from "../../src/live/types";
import { buildInternalReconciliationSnapshots } from "../../src/live/reconciliationModel";

export function sampleOpportunity(): Opportunity {
    return {
        market: {
            marketId: "m1",
            conditionId: null,
            slug: "sample-market",
            question: "sample",
            eventSlug: null,
            tagSlugs: [],
            tagLabels: [],
            yesTokenId: "yes-1",
            noTokenId: "no-1",
            tokenMappingSource: "outcomes",
            active: true,
            closed: false,
            archived: false,
            endDate: null,
            liquidityNum: null,
            volumeNum: null,
            feeRaw: null,
            feesEnabled: null,
        },
        quote: {
            yesAsk: 0.4,
            noAsk: 0.4,
            yesAskSize: 1,
            noAskSize: 1,
            quoteAgeMs: 0,
        },
        cost: {
            explicitCostBuffer: 0,
            feeCost: 0,
            totalCostBuffer: 0,
            notes: [],
        },
        totalAllIn: 0.8,
        edge: 0.2,
        observedAt: 1000,
    };
}

export function buildFilledOrderStore(args?: {
    executionAttemptId?: string;
    fillCountPerLeg?: number;
    externalIdentifierMode?: "none" | "synthetic_full" | "synthetic_partial";
}) {
    const executionAttemptId = args?.executionAttemptId ?? "attempt-1";
    const fillCountPerLeg = args?.fillCountPerLeg ?? 1;
    const externalIdentifierMode = args?.externalIdentifierMode ?? "none";
    const store = new OrderLifecycleStore();
    const request = buildExecutionRequest({
        executionAttemptId,
        source: "replay",
        opportunity: sampleOpportunity(),
        requestedSize: 1,
        createdAtMs: 1000,
    });
    const created = store.createFromExecutionRequest(request);
    store.transitionExecutionAttempt(executionAttemptId, "submit_requested", "submit_requested_by_adapter", 1000);
    store.transitionExecutionAttempt(executionAttemptId, "submitted", "submitted_by_replay_simulated", 1000);
    store.transitionExecutionAttempt(executionAttemptId, "acknowledged", "acknowledged_by_stub", 1000);
    store.transitionExecutionAttempt(executionAttemptId, "open", "opened_by_stub", 1000);

    for (let index = 0; index < fillCountPerLeg; index += 1) {
        store.applySimulatedUpdate({
            executionAttemptId,
            ts: 1100 + index,
            legUpdates: [
                {
                    legId: `${executionAttemptId}-yes`,
                    terminalState: index === fillCountPerLeg - 1 ? "filled" : "partially_filled",
                    reason: "filled_by_replay_simulation",
                    filledSize: 1 / fillCountPerLeg,
                    averageFillPrice: 0.4,
                },
                {
                    legId: `${executionAttemptId}-no`,
                    terminalState: index === fillCountPerLeg - 1 ? "filled" : "partially_filled",
                    reason: "filled_by_replay_simulation",
                    filledSize: 1 / fillCountPerLeg,
                    averageFillPrice: 0.4,
                },
            ],
            reconciliationPending: index === fillCountPerLeg - 1,
            reconcileNow: index === fillCountPerLeg - 1,
        });
    }

    if (externalIdentifierMode !== "none") {
        store.attachOrderExternalIdentifiers(created[0]!.orderId, {
            externalOrderId: "ext-order-yes",
            externalExecutionId: externalIdentifierMode === "synthetic_full" ? "ext-exec-yes" : null,
            venueOrderRef: externalIdentifierMode === "synthetic_full" ? "venue-ref-yes" : null,
            provenance: "synthetic_fixture",
        }, 1200);
        store.attachOrderExternalIdentifiers(created[1]!.orderId, {
            externalOrderId: "ext-order-no",
            externalExecutionId: externalIdentifierMode === "synthetic_full" ? "ext-exec-no" : null,
            venueOrderRef: externalIdentifierMode === "synthetic_full" ? "venue-ref-no" : null,
            provenance: "synthetic_fixture",
        }, 1200);
        for (let index = 0; index < fillCountPerLeg; index += 1) {
            store.attachFillEventExternalIdentifiers({
                orderId: created[0]!.orderId,
                fillEventIndex: index,
                identifiers: {
                    externalOrderId: "ext-order-yes",
                    externalExecutionId: externalIdentifierMode === "synthetic_full" ? "ext-exec-yes" : null,
                    externalFillId: `ext-fill-yes-${index + 1}`,
                    venueOrderRef: externalIdentifierMode === "synthetic_full" ? "venue-ref-yes" : null,
                    provenance: "synthetic_fixture",
                },
            });
            store.attachFillEventExternalIdentifiers({
                orderId: created[1]!.orderId,
                fillEventIndex: index,
                identifiers: {
                    externalOrderId: "ext-order-no",
                    externalExecutionId: externalIdentifierMode === "synthetic_full" ? "ext-exec-no" : null,
                    externalFillId: `ext-fill-no-${index + 1}`,
                    venueOrderRef: externalIdentifierMode === "synthetic_full" ? "venue-ref-no" : null,
                    provenance: "synthetic_fixture",
                },
            });
        }
    }

    return store;
}

export function buildInternalSnapshots(args?: {
    executionAttemptId?: string;
    fillCountPerLeg?: number;
    externalIdentifierMode?: "none" | "synthetic_full" | "synthetic_partial";
}): InternalOrderReconciliationSnapshot[] {
    const store = buildFilledOrderStore(args);
    return buildInternalReconciliationSnapshots({
        orders: store.getAllOrderRecords(),
        fillEvents: store.getAllFillEvents(),
    });
}

export function buildExternalOrder(args: Partial<ExternalOrderSnapshot> & {
    executionAttemptId?: string | null;
    legId?: string | null;
    externalOrderId?: string | null;
}): ExternalOrderSnapshot {
    return {
        internalOrderId: args.internalOrderId ?? null,
        externalOrderId: args.externalOrderId ?? null,
        externalExecutionId: args.externalExecutionId ?? null,
        venueOrderRef: args.venueOrderRef ?? null,
        executionAttemptId: args.executionAttemptId ?? null,
        correlationId: args.correlationId ?? null,
        legId: args.legId ?? null,
        tokenId: args.tokenId ?? null,
        status: args.status ?? "open",
        filledSize: args.filledSize ?? 1,
        averageFillPrice: args.averageFillPrice ?? 0.4,
        externalFillCount: args.externalFillCount ?? 1,
        totalFilledNotional: args.totalFilledNotional ?? 0.4,
        partialFillObserved: args.partialFillObserved ?? false,
        observedAtMs: args.observedAtMs ?? 1200,
        rawSourceMetadata: args.rawSourceMetadata ?? null,
    };
}

export function buildExternalFill(args: Partial<ExternalFillSnapshot> & {
    externalFillId?: string | null;
}): ExternalFillSnapshot {
    return {
        internalOrderId: args.internalOrderId ?? null,
        externalOrderId: args.externalOrderId ?? null,
        externalExecutionId: args.externalExecutionId ?? null,
        externalFillId: args.externalFillId ?? null,
        venueOrderRef: args.venueOrderRef ?? null,
        executionAttemptId: args.executionAttemptId ?? null,
        legId: args.legId ?? null,
        filledSize: args.filledSize ?? 1,
        averageFillPrice: args.averageFillPrice ?? 0.4,
        observedAtMs: args.observedAtMs ?? 1200,
        rawSourceMetadata: args.rawSourceMetadata ?? null,
    };
}

export function buildSyntheticSnapshot(args: {
    sourceLabel: string;
    orders: ExternalOrderSnapshot[];
    fills?: ExternalFillSnapshot[];
    trustworthy?: boolean;
}): ExternalExecutionSnapshot {
    return {
        provenance: "synthetic_test_snapshot",
        sourceLabel: args.sourceLabel,
        capturedAtMs: 1200,
        maxSnapshotAgeMs: 1000,
        trustworthy: args.trustworthy ?? true,
        orders: args.orders,
        fills: args.fills ?? [],
        rawSourceMetadata: {
            fixtureLabel: args.sourceLabel,
        },
    };
}

export function buildInternalAccountSnapshot(args?: {
    accountId?: string;
    sourceLabel?: string;
    capturedAtMs?: number;
    assets?: InternalAccountBalanceSnapshot["assets"];
}): InternalAccountBalanceSnapshot {
    return {
        accountId: args?.accountId ?? "internal-account-1",
        sourceLabel: args?.sourceLabel ?? "synthetic-internal-account",
        capturedAtMs: args?.capturedAtMs ?? 1200,
        assets: args?.assets ?? [
            {
                assetSymbol: "USDC",
                availableBalance: 100,
                reservedBalance: 10,
                totalBalance: 110,
                rawSourceMetadata: null,
            },
            {
                assetSymbol: "YES_TOKEN",
                availableBalance: 2,
                reservedBalance: 0,
                totalBalance: 2,
                rawSourceMetadata: null,
            },
        ],
        rawSourceMetadata: null,
    };
}

export function buildExternalAccountSnapshot(args?: {
    accountId?: string | null;
    sourceLabel?: string;
    capturedAtMs?: number;
    maxSnapshotAgeMs?: number | null;
    trustworthy?: boolean;
    assets?: ExternalAccountSnapshot["assets"];
    reservedBalances?: ExternalAccountSnapshot["reservedBalances"];
    provenance?: ExternalAccountSnapshot["provenance"];
}): ExternalAccountSnapshot {
    return {
        accountId: args?.accountId ?? "external-account-1",
        provenance: args?.provenance ?? "synthetic_test_snapshot",
        sourceLabel: args?.sourceLabel ?? "synthetic-external-account",
        capturedAtMs: args?.capturedAtMs ?? 1200,
        maxSnapshotAgeMs: args?.maxSnapshotAgeMs ?? 1000,
        trustworthy: args?.trustworthy ?? true,
        assets: args?.assets ?? [
            {
                assetSymbol: "USDC",
                availableBalance: 100,
                reservedBalance: 10,
                totalBalance: 110,
                rawSourceMetadata: null,
            },
            {
                assetSymbol: "YES_TOKEN",
                availableBalance: 2,
                reservedBalance: 0,
                totalBalance: 2,
                rawSourceMetadata: null,
            },
        ],
        reservedBalances: args?.reservedBalances ?? [],
        rawSourceMetadata: null,
    };
}
