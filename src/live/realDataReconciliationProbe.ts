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
import { loadInternalBaseline } from "./internalBaseline";

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
    pilotSessionId: string | null;
    pilotSessionManifestPath: string | null;
    limitationCounts: Record<string, number>;
    limitations: RealDataReconciliationLimitations;
};

function incrementCounter(target: Record<string, number>, key: string, amount = 1) {
    target[key] = (target[key] ?? 0) + amount;
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
    pilotSessionId?: string | null;
    pilotSessionManifestPath?: string | null;
}): Promise<RealDataReconciliationResult> {
    const capturedAtMs = args.now ?? Date.now();
    const transport = args.transport ?? createPolymarketReadOnlyTransport(args.readOnlyVenueConfig);
    const fetch = await fetchAndNormalizeReadOnlyVenueData({
        config: args.readOnlyVenueConfig,
        transport,
        now: capturedAtMs,
    });

    const baseline = loadInternalBaseline({
        baselinePath: args.probeConfig.baselinePath,
        runtimeCapturePath: args.probeConfig.runtimeCapturePath,
        orderBaselinePath: args.probeConfig.internalOrderSnapshotPath,
        accountBaselinePath: args.probeConfig.internalAccountSnapshotPath,
    });
    const internalOrders = baseline.orders;
    const internalAccount = baseline.account ?? {
        accountId: "real_data_probe_empty_internal_account",
        sourceLabel: "real_data_probe_empty_internal_account",
        capturedAtMs,
        assets: [],
        rawSourceMetadata: null,
    };

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
        pilotSessionId: args.pilotSessionId ?? null,
        pilotSessionManifestPath: args.pilotSessionManifestPath ?? null,
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
