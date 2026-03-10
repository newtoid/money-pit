import fs from "node:fs";
import path from "node:path";
import { ReadOnlyVenueConfig } from "../config/readOnlyVenue";
import { RealDataReconciliationConfig } from "../config/realDataReconciliation";
import { logger } from "../logger";
import {
    createPolymarketReadOnlyTransport,
    fetchAndNormalizeReadOnlyVenueData,
    ReadOnlyVenueFetchResult,
    ReadOnlyVenueTransport,
} from "../adapters/readOnlyVenue";
import { runExternalReconciliation } from "./reconciliationModel";
import { runExternalBalanceReconciliation } from "./balanceReconciliation";
import {
    BalanceReconciliationResult,
    InternalAccountBalanceSnapshot,
    InternalOrderReconciliationSnapshot,
    ReconciliationResult,
} from "./types";

export type RealDataReconciliationLimitations = {
    orderComparison: string[];
    balanceComparison: string[];
};

export type RealDataReconciliationResult = {
    capturedAtMs: number;
    readOnlyMode: ReadOnlyVenueConfig["mode"];
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    fetch: ReadOnlyVenueFetchResult;
    orderReconciliation: ReconciliationResult | null;
    balanceReconciliation: BalanceReconciliationResult | null;
    internalOrderBaselineCount: number;
    internalAccountBaselineAssetCount: number;
    limitationCounts: Record<string, number>;
    limitations: RealDataReconciliationLimitations;
};

type RawInternalOrderSnapshot = Partial<InternalOrderReconciliationSnapshot>;
type RawInternalAccountSnapshot = Partial<InternalAccountBalanceSnapshot>;

function incrementCounter(target: Record<string, number>, key: string, amount = 1) {
    target[key] = (target[key] ?? 0) + amount;
}

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as T;
}

function toNumberOrNull(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function loadInternalOrderBaseline(filePath: string | null, capturedAtMs: number): InternalOrderReconciliationSnapshot[] {
    if (!filePath) return [];
    const raw = readJsonFile<unknown>(filePath);
    if (!Array.isArray(raw)) throw new Error("internal order baseline must be a JSON array");
    return raw.map((item, index) => {
        const order = item as RawInternalOrderSnapshot;
        if (!order.orderId || !order.executionAttemptId || !order.legId || !order.tokenId) {
            throw new Error(`internal order baseline entry ${index} is missing required identifiers`);
        }
        return {
            orderId: String(order.orderId),
            executionAttemptId: String(order.executionAttemptId),
            correlationId: typeof order.correlationId === "string" ? order.correlationId : String(order.orderId),
            legId: String(order.legId),
            tokenId: String(order.tokenId),
            binarySide: order.binarySide === "no" ? "no" : "yes",
            currentState: order.currentState ?? "open",
            terminalState: order.terminalState ?? null,
            comparableStatus: order.comparableStatus ?? "open",
            createdAtMs: toNumberOrNull(order.createdAtMs) ?? capturedAtMs,
            updatedAtMs: toNumberOrNull(order.updatedAtMs) ?? capturedAtMs,
            filledSize: toNumberOrNull(order.filledSize) ?? 0,
            averageFillPrice: toNumberOrNull(order.averageFillPrice),
            fillEventCount: toNumberOrNull(order.fillEventCount) ?? 0,
            filledNotional: toNumberOrNull(order.filledNotional),
            partialFillObserved: order.partialFillObserved === true,
            statusProgressionRank: toNumberOrNull(order.statusProgressionRank) ?? 0,
            knownExternalOrderId: typeof order.knownExternalOrderId === "string" ? order.knownExternalOrderId : null,
            knownExternalExecutionId: typeof order.knownExternalExecutionId === "string" ? order.knownExternalExecutionId : null,
            knownExternalFillIds: Array.isArray(order.knownExternalFillIds)
                ? order.knownExternalFillIds.filter((value): value is string => typeof value === "string")
                : [],
            knownVenueOrderRef: typeof order.knownVenueOrderRef === "string" ? order.knownVenueOrderRef : null,
            externalIdentifierProvenance: order.externalIdentifierProvenance ?? "none",
        };
    });
}

function loadInternalAccountBaseline(filePath: string | null, capturedAtMs: number): InternalAccountBalanceSnapshot {
    if (!filePath) {
        return {
            accountId: "real_data_probe_empty_internal_account",
            sourceLabel: "real_data_probe_empty_internal_account",
            capturedAtMs,
            assets: [],
            rawSourceMetadata: null,
        };
    }
    const raw = readJsonFile<unknown>(filePath) as RawInternalAccountSnapshot;
    if (!raw || typeof raw !== "object") throw new Error("internal account baseline must be a JSON object");
    return {
        accountId: typeof raw.accountId === "string" ? raw.accountId : "real_data_probe_internal_account",
        sourceLabel: typeof raw.sourceLabel === "string" ? raw.sourceLabel : "real_data_probe_internal_account",
        capturedAtMs: toNumberOrNull(raw.capturedAtMs) ?? capturedAtMs,
        assets: Array.isArray(raw.assets)
            ? raw.assets.map((asset, index) => {
                if (!asset || typeof asset !== "object" || typeof asset.assetSymbol !== "string" || asset.assetSymbol.trim().length === 0) {
                    throw new Error(`internal account baseline asset ${index} is missing assetSymbol`);
                }
                return {
                    assetSymbol: asset.assetSymbol,
                    availableBalance: toNumberOrNull(asset.availableBalance),
                    reservedBalance: toNumberOrNull(asset.reservedBalance),
                    totalBalance: toNumberOrNull(asset.totalBalance),
                    rawSourceMetadata: asset.rawSourceMetadata ?? null,
                };
            })
            : [],
        rawSourceMetadata: raw.rawSourceMetadata ?? null,
    };
}

function buildLimitations(args: {
    fetch: ReadOnlyVenueFetchResult;
    internalOrders: InternalOrderReconciliationSnapshot[];
    internalAccount: InternalAccountBalanceSnapshot;
    orderReconciliation: ReconciliationResult | null;
    balanceReconciliation: BalanceReconciliationResult | null;
}) {
    const limitationCounts: Record<string, number> = {};
    const orderComparison: string[] = [];
    const balanceComparison: string[] = [];

    if (!args.fetch.executionSnapshotNormalization?.accepted) {
        orderComparison.push("execution snapshot normalization was not accepted");
        incrementCounter(limitationCounts, "order_normalization_not_accepted");
    }
    if (!args.fetch.accountSnapshotNormalization?.accepted) {
        balanceComparison.push("account snapshot normalization was not accepted");
        incrementCounter(limitationCounts, "account_normalization_not_accepted");
    }
    if (args.internalOrders.length === 0) {
        orderComparison.push("no internal order baseline was provided; external orders can only surface as unmatched or unexpected");
        incrementCounter(limitationCounts, "missing_internal_order_baseline");
    }
    if (args.internalAccount.assets.length === 0) {
        balanceComparison.push("no internal account baseline was provided; external balances can only surface as unexpected or uncovered");
        incrementCounter(limitationCounts, "missing_internal_account_baseline");
    }
    if (
        (args.fetch.summary.failedFetchCounts.open_orders ?? 0)
        + (args.fetch.summary.failedFetchCounts.trades ?? 0)
        + (args.fetch.summary.failedFetchCounts.balance_allowance ?? 0) > 0
    ) {
        incrementCounter(
            limitationCounts,
            "real_fetch_failures",
            (args.fetch.summary.failedFetchCounts.open_orders ?? 0)
                + (args.fetch.summary.failedFetchCounts.trades ?? 0)
                + (args.fetch.summary.failedFetchCounts.balance_allowance ?? 0),
        );
    }
    if ((args.fetch.summary.partialRealDataWarningCounts.execution_snapshot ?? 0) > 0) {
        orderComparison.push("real order/trade inputs were partial and produced normalization warnings");
        incrementCounter(limitationCounts, "partial_execution_real_data");
    }
    if ((args.fetch.summary.partialRealDataWarningCounts.account_snapshot ?? 0) > 0) {
        balanceComparison.push("real account inputs were partial and produced normalization warnings");
        incrementCounter(limitationCounts, "partial_account_real_data");
    }
    if ((args.orderReconciliation?.unexpectedExternalOrderCount ?? 0) > 0) {
        orderComparison.push("some external orders could not be matched to internal order baselines");
        incrementCounter(limitationCounts, "unexpected_external_orders");
    }
    if ((args.balanceReconciliation?.unexpectedExternalAssetCount ?? 0) > 0) {
        balanceComparison.push("some external asset balances could not be matched to internal account baselines");
        incrementCounter(limitationCounts, "unexpected_external_assets");
    }
    if ((args.balanceReconciliation?.insufficientCoverageCount ?? 0) > 0) {
        balanceComparison.push("some balance comparisons lacked enough comparable fields");
        incrementCounter(limitationCounts, "insufficient_balance_coverage");
    }

    return {
        limitationCounts,
        limitations: {
            orderComparison,
            balanceComparison,
        } satisfies RealDataReconciliationLimitations,
    };
}

export async function runRealDataReconciliationProbe(args: {
    readOnlyVenueConfig: ReadOnlyVenueConfig;
    probeConfig: RealDataReconciliationConfig;
    transport?: ReadOnlyVenueTransport;
    now?: number;
}): Promise<RealDataReconciliationResult> {
    const capturedAtMs = args.now ?? Date.now();
    const transport = args.transport ?? createPolymarketReadOnlyTransport(args.readOnlyVenueConfig);
    const fetch = await fetchAndNormalizeReadOnlyVenueData({
        config: args.readOnlyVenueConfig,
        transport,
        now: capturedAtMs,
    });

    const internalOrders = loadInternalOrderBaseline(args.probeConfig.internalOrderSnapshotPath, capturedAtMs);
    const internalAccount = loadInternalAccountBaseline(args.probeConfig.internalAccountSnapshotPath, capturedAtMs);

    const orderReconciliation = fetch.executionSnapshotNormalization?.accepted && fetch.executionSnapshotNormalization.snapshot
        ? runExternalReconciliation({
            adapterMode: "replay_simulated",
            input: {
                capturedAtMs,
                comparisonMode: "synthetic_external_snapshot_compare",
                snapshot: fetch.executionSnapshotNormalization.snapshot,
            },
            internalOrders,
        })
        : null;

    const balanceReconciliation = fetch.accountSnapshotNormalization?.accepted && fetch.accountSnapshotNormalization.snapshot
        ? runExternalBalanceReconciliation({
            adapterMode: "replay_simulated",
            input: {
                capturedAtMs,
                comparisonMode: "synthetic_external_account_snapshot_compare",
                internalAccount,
                externalAccount: fetch.accountSnapshotNormalization.snapshot,
            },
        })
        : null;

    const limitationSummary = buildLimitations({
        fetch,
        internalOrders,
        internalAccount,
        orderReconciliation,
        balanceReconciliation,
    });

    const result: RealDataReconciliationResult = {
        capturedAtMs,
        readOnlyMode: args.readOnlyVenueConfig.mode,
        liveExecutionEnabled: args.readOnlyVenueConfig.liveExecutionEnabled,
        executionKillSwitch: args.readOnlyVenueConfig.executionKillSwitch,
        fetch,
        orderReconciliation,
        balanceReconciliation,
        internalOrderBaselineCount: internalOrders.length,
        internalAccountBaselineAssetCount: internalAccount.assets.length,
        limitationCounts: limitationSummary.limitationCounts,
        limitations: limitationSummary.limitations,
    };

    if (args.probeConfig.outputPath) {
        const outputPath = path.resolve(args.probeConfig.outputPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        logger.info({
            msg: "wrote real-data reconciliation probe output",
            source: args.readOnlyVenueConfig.readOnlyLogLabel,
            outputPath,
        });
    }

    return result;
}
