import fs from "node:fs";
import path from "node:path";
import { fetchAndNormalizeReadOnlyVenueData, ReadOnlyVenueTransport, createPolymarketReadOnlyTransport } from "../adapters/readOnlyVenue";
import { ReadOnlyVenueConfig } from "../config/readOnlyVenue";
import { runExternalReconciliation } from "./reconciliationModel";
import { runExternalBalanceReconciliation } from "./balanceReconciliation";
import { loadInternalBaseline } from "./internalBaseline";
import { LiveOrderPilotResult, ReconciliationResult, BalanceReconciliationResult } from "./types";
import { logger } from "../logger";

export type LivePostSubmitVerificationResult = {
    verifiedAtMs: number;
    pilotExecutionAttemptId: string;
    pilotResultPath: string;
    pilotExternalOrderId: string | null;
    pilotMarketId: string | null;
    pilotAssetId: string | null;
    fetchSummary: ReturnType<typeof emptyCounts>;
    externalOrderIdFound: boolean;
    matchingOrderSnapshotCount: number;
    matchingTradeSnapshotCount: number;
    orderReconciliationMatchedPilotBaseline: boolean;
    accountPartialCoverageOnly: boolean;
    orderReconciliation: ReconciliationResult | null;
    balanceReconciliation: BalanceReconciliationResult | null;
    limitationCounts: Record<string, number>;
    limitations: string[];
    followUp: {
        recommendedReconcileCommand: string;
    };
};

type VerificationInputs = {
    pilotResultPath: string;
    internalOrderBaselinePath: string | null;
    internalAccountBaselinePath: string | null;
    outputPath: string | null;
};

function emptyCounts() {
    return {
        successfulFetchCounts: {},
        failedFetchCounts: {},
        normalizationAcceptedCounts: {},
        normalizationRejectCounts: {},
        normalizationWarningCounts: {},
        provenanceCounts: {},
        staleWarningCounts: {},
        partialRealDataWarningCounts: {},
    };
}

function readPilotResult(filePath: string): LiveOrderPilotResult {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as LiveOrderPilotResult;
}

function findPilotContext(result: LiveOrderPilotResult) {
    const baselinePath = result.internalOrderBaselinePath;
    let marketId: string | null = null;
    let assetId: string | null = null;
    if (baselinePath && fs.existsSync(path.resolve(baselinePath))) {
        const rows = JSON.parse(fs.readFileSync(path.resolve(baselinePath), "utf8")) as Array<{
            marketId?: string;
            tokenId?: string;
        }>;
        marketId = rows[0]?.marketId ?? null;
        assetId = rows[0]?.tokenId ?? null;
    }
    return { marketId, assetId };
}

function incrementCounter(target: Record<string, number>, key: string, amount = 1) {
    target[key] = (target[key] ?? 0) + amount;
}

export async function runLivePostSubmitVerification(args: {
    readOnlyVenueConfig: ReadOnlyVenueConfig;
    inputs: VerificationInputs;
    transport?: ReadOnlyVenueTransport;
    now?: number;
}): Promise<LivePostSubmitVerificationResult> {
    const verifiedAtMs = args.now ?? Date.now();
    const pilot = readPilotResult(args.inputs.pilotResultPath);
    const context = findPilotContext(pilot);
    const transport = args.transport ?? createPolymarketReadOnlyTransport(args.readOnlyVenueConfig);
    const fetch = await fetchAndNormalizeReadOnlyVenueData({
        config: {
            ...args.readOnlyVenueConfig,
            fetchOpenOrders: true,
            fetchTrades: true,
            fetchAccountBalances: true,
            openOrdersMarket: context.marketId,
            openOrdersAssetId: context.assetId,
            tradesMarket: context.marketId,
            tradesAssetId: context.assetId,
        },
        transport,
        now: verifiedAtMs,
    });

    const baseline = loadInternalBaseline({
        orderBaselinePath: args.inputs.internalOrderBaselinePath ?? pilot.internalOrderBaselinePath,
        accountBaselinePath: args.inputs.internalAccountBaselinePath,
    });

    const executionSnapshot = fetch.executionSnapshotNormalization?.accepted ? fetch.executionSnapshotNormalization.snapshot : null;
    const accountSnapshot = fetch.accountSnapshotNormalization?.accepted ? fetch.accountSnapshotNormalization.snapshot : null;

    const orderReconciliation = executionSnapshot
        ? runExternalReconciliation({
            adapterMode: "replay_simulated",
            input: {
                capturedAtMs: verifiedAtMs,
                comparisonMode: "synthetic_external_snapshot_compare",
                snapshot: executionSnapshot,
            },
            internalOrders: baseline.orders,
        })
        : null;

    const internalAccount = baseline.account ?? {
        accountId: "live_post_submit_empty_internal_account",
        sourceLabel: "live_post_submit_empty_internal_account",
        capturedAtMs: verifiedAtMs,
        assets: [],
        rawSourceMetadata: null,
    };

    const balanceReconciliation = accountSnapshot
        ? runExternalBalanceReconciliation({
            adapterMode: "replay_simulated",
            input: {
                capturedAtMs: verifiedAtMs,
                comparisonMode: "synthetic_external_account_snapshot_compare",
                internalAccount,
                externalAccount: accountSnapshot,
            },
        })
        : null;

    const pilotExternalOrderId = pilot.venueAck?.externalOrderId ?? null;
    const matchingOrderSnapshotCount = executionSnapshot
        ? executionSnapshot.orders.filter((item) => item.externalOrderId === pilotExternalOrderId).length
        : 0;
    const matchingTradeSnapshotCount = executionSnapshot
        ? executionSnapshot.fills.filter((item) => item.externalOrderId === pilotExternalOrderId).length
        : 0;
    const externalOrderIdFound = Boolean(pilotExternalOrderId && (matchingOrderSnapshotCount > 0 || matchingTradeSnapshotCount > 0));
    const matchedPilotBaseline = Boolean(
        orderReconciliation && orderReconciliation.diffs.some((diff) =>
            diff.matched && (
                (pilotExternalOrderId !== null && diff.externalOrderId === pilotExternalOrderId)
                || diff.executionAttemptId === pilot.executionAttemptId
            )),
    );

    const limitationCounts: Record<string, number> = {};
    const limitations: string[] = [];
    if (!pilotExternalOrderId) {
        limitations.push("pilot result had no external order id");
        incrementCounter(limitationCounts, "missing_pilot_external_order_id");
    }
    if (!executionSnapshot) {
        limitations.push("execution snapshot normalization was not accepted");
        incrementCounter(limitationCounts, "execution_snapshot_not_accepted");
    }
    if (!accountSnapshot) {
        limitations.push("account snapshot normalization was not accepted");
        incrementCounter(limitationCounts, "account_snapshot_not_accepted");
    }
    if (baseline.orders.length === 0) {
        limitations.push("no internal order baseline was available for pilot verification");
        incrementCounter(limitationCounts, "missing_internal_order_baseline");
    }
    if (internalAccount.assets.length === 0) {
        limitations.push("no internal account baseline was available for balance verification");
        incrementCounter(limitationCounts, "missing_internal_account_baseline");
    }
    if (!externalOrderIdFound && pilotExternalOrderId) {
        limitations.push("pilot external order id was not visible in current read-only venue snapshots");
        incrementCounter(limitationCounts, "pilot_external_order_id_not_found");
    }

    const result: LivePostSubmitVerificationResult = {
        verifiedAtMs,
        pilotExecutionAttemptId: pilot.executionAttemptId,
        pilotResultPath: path.resolve(args.inputs.pilotResultPath),
        pilotExternalOrderId,
        pilotMarketId: context.marketId,
        pilotAssetId: context.assetId,
        fetchSummary: fetch.summary,
        externalOrderIdFound,
        matchingOrderSnapshotCount,
        matchingTradeSnapshotCount,
        orderReconciliationMatchedPilotBaseline: matchedPilotBaseline,
        accountPartialCoverageOnly: Boolean(
            (fetch.summary.partialRealDataWarningCounts.account_snapshot ?? 0) > 0
            || (balanceReconciliation?.insufficientCoverageCount ?? 0) > 0,
        ),
        orderReconciliation,
        balanceReconciliation,
        limitationCounts,
        limitations,
        followUp: {
            recommendedReconcileCommand: pilot.internalOrderBaselinePath
                ? `npm run venue:reconcile -- --order-baseline ${pilot.internalOrderBaselinePath}`
                : "npm run venue:reconcile",
        },
    };

    if (args.inputs.outputPath) {
        const outputPath = path.resolve(args.inputs.outputPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        logger.info({
            msg: "wrote live post-submit verification output",
            source: args.readOnlyVenueConfig.readOnlyLogLabel,
            outputPath,
        });
    }

    return result;
}
