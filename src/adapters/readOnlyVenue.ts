import { AssetType, ClobClient } from "@polymarket/clob-client";
import type { BalanceAllowanceResponse, OpenOrder, Trade } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { logger } from "../logger";
import { ReadOnlyVenueConfig, assertReadOnlyVenueSafety } from "../config/readOnlyVenue";
import { normalizeExternalSnapshotIngestion } from "../live/snapshotIngestion";
import { normalizeExternalAccountSnapshotIngestion } from "../live/accountSnapshotIngestion";
import {
    AccountSnapshotNormalizationResult,
    SnapshotNormalizationResult,
} from "../live/types";

export type ReadOnlyVenueFetchType =
    | "open_orders"
    | "trades"
    | "balance_allowance";

export type ReadOnlyVenueFetchSummary = {
    successfulFetchCounts: Record<string, number>;
    failedFetchCounts: Record<string, number>;
    normalizationAcceptedCounts: Record<string, number>;
    normalizationRejectCounts: Record<string, number>;
    normalizationWarningCounts: Record<string, number>;
    provenanceCounts: Record<string, number>;
    staleWarningCounts: Record<string, number>;
    partialRealDataWarningCounts: Record<string, number>;
};

export type ReadOnlyVenueFetchResult = {
    executionSnapshotNormalization: SnapshotNormalizationResult | null;
    accountSnapshotNormalization: AccountSnapshotNormalizationResult | null;
    summary: ReadOnlyVenueFetchSummary;
};

export type BalanceAllowanceRecord = {
    assetType: "COLLATERAL" | "CONDITIONAL";
    tokenId: string | null;
    response: BalanceAllowanceResponse;
};

export interface ReadOnlyVenueTransport {
    getOpenOrders(params?: { market?: string; asset_id?: string }): Promise<OpenOrder[]>;
    getTrades(params?: { market?: string; asset_id?: string }): Promise<Trade[]>;
    getBalanceAllowance(params: { asset_type: AssetType; token_id?: string }): Promise<BalanceAllowanceResponse>;
}

export function createPolymarketReadOnlyTransport(config: ReadOnlyVenueConfig): ReadOnlyVenueTransport {
    assertReadOnlyVenueSafety(config);
    if (!config.privateKey) throw new Error("read-only venue integration requires READ_ONLY_VENUE_PRIVATE_KEY or PRIVATE_KEY");
    if (!config.apiKey || !config.apiSecret || !config.apiPassphrase) {
        throw new Error("read-only venue integration requires read-only CLOB credentials");
    }

    const signer = new Wallet(config.privateKey);
    const client = new ClobClient(
        config.host,
        config.chainId as any,
        signer,
        {
            key: config.apiKey,
            secret: config.apiSecret,
            passphrase: config.apiPassphrase,
        } as any,
    );

    return {
        getOpenOrders(params) {
            return client.getOpenOrders(params);
        },
        getTrades(params) {
            return client.getTrades(params);
        },
        getBalanceAllowance(params) {
            return client.getBalanceAllowance(params as any);
        },
    };
}

function incrementCounter(target: Record<string, number>, key: string, amount = 1) {
    target[key] = (target[key] ?? 0) + amount;
}

function summarizeNormalization(args: {
    summary: ReadOnlyVenueFetchSummary;
    scope: "execution_snapshot" | "account_snapshot";
    provenance: string;
    warnings: Array<{ warningType: string }>;
    accepted: boolean;
    rejectReason: string | null;
}) {
    if (args.accepted) incrementCounter(args.summary.normalizationAcceptedCounts, args.scope);
    else incrementCounter(args.summary.normalizationRejectCounts, args.scope);
    incrementCounter(args.summary.provenanceCounts, args.provenance);
    if (args.rejectReason) incrementCounter(args.summary.normalizationRejectCounts, args.rejectReason);
    for (const warning of args.warnings) {
        incrementCounter(args.summary.normalizationWarningCounts, warning.warningType);
        if (warning.warningType.includes("stale")) {
            incrementCounter(args.summary.staleWarningCounts, args.scope);
        }
        if (
            warning.warningType === "missing_internal_match_keys"
            || warning.warningType === "missing_balance_field"
            || warning.warningType === "missing_external_identifiers"
            || warning.warningType === "missing_reserved_balance_key"
        ) {
            incrementCounter(args.summary.partialRealDataWarningCounts, args.scope);
        }
    }
}

function mapOrderStatus(rawStatus: string | null | undefined) {
    if (!rawStatus) return "unknown";
    const normalized = rawStatus.trim().toLowerCase();
    switch (normalized) {
        case "open":
        case "filled":
        case "cancelled":
        case "expired":
        case "rejected":
            return normalized;
        case "matched":
        case "partially_filled":
        case "partially filled":
            return "partial";
        default:
            return "unknown";
    }
}

export async function fetchAndNormalizeReadOnlyVenueData(args: {
    config: ReadOnlyVenueConfig;
    transport: ReadOnlyVenueTransport;
    now?: number;
}): Promise<ReadOnlyVenueFetchResult> {
    assertReadOnlyVenueSafety(args.config);
    const now = args.now ?? Date.now();
    const summary: ReadOnlyVenueFetchSummary = {
        successfulFetchCounts: {},
        failedFetchCounts: {},
        normalizationAcceptedCounts: {},
        normalizationRejectCounts: {},
        normalizationWarningCounts: {},
        provenanceCounts: {},
        staleWarningCounts: {},
        partialRealDataWarningCounts: {},
    };

    let openOrders: OpenOrder[] = [];
    let trades: Trade[] = [];
    let balanceRecords: BalanceAllowanceRecord[] = [];

    if (args.config.fetchOpenOrders) {
        try {
            openOrders = await args.transport.getOpenOrders({
                market: args.config.openOrdersMarket ?? undefined,
                asset_id: args.config.openOrdersAssetId ?? undefined,
            });
            incrementCounter(summary.successfulFetchCounts, "open_orders");
        } catch (error) {
            incrementCounter(summary.failedFetchCounts, "open_orders");
            logger.warn({
                msg: "read-only open orders fetch failed",
                source: args.config.readOnlyLogLabel,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (args.config.fetchTrades) {
        try {
            trades = await args.transport.getTrades({
                market: args.config.tradesMarket ?? undefined,
                asset_id: args.config.tradesAssetId ?? undefined,
            });
            incrementCounter(summary.successfulFetchCounts, "trades");
        } catch (error) {
            incrementCounter(summary.failedFetchCounts, "trades");
            logger.warn({
                msg: "read-only trades fetch failed",
                source: args.config.readOnlyLogLabel,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (args.config.fetchAccountBalances) {
        const balanceFetches = [
            { assetType: AssetType.COLLATERAL as const, tokenId: null },
            ...args.config.balanceTokenIds.map((tokenId) => ({ assetType: AssetType.CONDITIONAL as const, tokenId })),
        ];
        for (const fetchArgs of balanceFetches) {
            try {
                const response = await args.transport.getBalanceAllowance({
                    asset_type: fetchArgs.assetType,
                    token_id: fetchArgs.tokenId ?? undefined,
                });
                balanceRecords.push({
                    assetType: fetchArgs.assetType,
                    tokenId: fetchArgs.tokenId,
                    response,
                });
                incrementCounter(summary.successfulFetchCounts, "balance_allowance");
            } catch (error) {
                incrementCounter(summary.failedFetchCounts, "balance_allowance");
                logger.warn({
                    msg: "read-only balance allowance fetch failed",
                    source: args.config.readOnlyLogLabel,
                    assetType: fetchArgs.assetType,
                    tokenId: fetchArgs.tokenId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }

    const executionSnapshotNormalization = (openOrders.length > 0 || trades.length > 0)
        ? normalizeExternalSnapshotIngestion({
            provenance: "real_readonly_clob_open_orders_trades_api",
            sourceLabel: "clob_readonly_open_orders_trades",
            capturedAtMs: now,
            ingestedAtMs: now,
            trustworthy: true,
            orders: openOrders.map((order) => ({
                externalOrderId: order.id,
                tokenId: order.asset_id,
                status: mapOrderStatus(order.status),
                filledSize: order.size_matched,
                averageFillPrice: null,
                externalFillCount: null,
                totalFilledNotional: null,
                partialFillObserved: Number(order.size_matched) > 0 && Number(order.size_matched) < Number(order.original_size),
                observedAtMs: order.created_at,
                rawSourceMetadata: {
                    owner: order.owner,
                    makerAddress: order.maker_address,
                    market: order.market,
                    side: order.side,
                    price: order.price,
                    originalSize: order.original_size,
                    outcome: order.outcome,
                    orderType: order.order_type,
                    expiration: order.expiration,
                },
            })),
            fills: trades.map((trade) => ({
                externalOrderId: trade.taker_order_id || null,
                externalExecutionId: trade.transaction_hash || null,
                externalFillId: trade.id,
                executionAttemptId: null,
                legId: null,
                filledSize: trade.size,
                averageFillPrice: trade.price,
                observedAtMs: Date.parse(trade.match_time),
                rawSourceMetadata: {
                    market: trade.market,
                    assetId: trade.asset_id,
                    side: trade.side,
                    status: trade.status,
                    outcome: trade.outcome,
                    makerAddress: trade.maker_address,
                    traderSide: trade.trader_side,
                    feeRateBps: trade.fee_rate_bps,
                    makerOrders: trade.maker_orders,
                },
            })),
            rawSourceMetadata: {
                fetchSource: "authenticated_clob_read_only",
            },
        })
        : null;

    if (executionSnapshotNormalization) {
        summarizeNormalization({
            summary,
            scope: "execution_snapshot",
            provenance: executionSnapshotNormalization.snapshot?.provenance ?? "real_readonly_clob_open_orders_trades_api",
            warnings: executionSnapshotNormalization.warnings,
            accepted: executionSnapshotNormalization.accepted,
            rejectReason: executionSnapshotNormalization.rejectReason,
        });
    }

    const accountSnapshotNormalization = balanceRecords.length > 0
        ? normalizeExternalAccountSnapshotIngestion({
            provenance: "real_readonly_clob_balance_allowance_api",
            sourceLabel: "clob_readonly_balance_allowance",
            accountId: null,
            capturedAtMs: now,
            ingestedAtMs: now,
            trustworthy: true,
            assets: balanceRecords.map((record) => ({
                assetSymbol: record.assetType === AssetType.COLLATERAL ? "COLLATERAL" : (record.tokenId ?? "CONDITIONAL"),
                availableBalance: record.response.balance,
                reservedBalance: null,
                totalBalance: null,
                rawSourceMetadata: {
                    assetType: record.assetType,
                    tokenId: record.tokenId,
                    allowance: record.response.allowance,
                },
            })),
            reservedBalances: [],
            rawSourceMetadata: {
                fetchSource: "authenticated_clob_read_only",
            },
        })
        : null;

    if (accountSnapshotNormalization) {
        summarizeNormalization({
            summary,
            scope: "account_snapshot",
            provenance: accountSnapshotNormalization.snapshot?.provenance ?? "real_readonly_clob_balance_allowance_api",
            warnings: accountSnapshotNormalization.warnings,
            accepted: accountSnapshotNormalization.accepted,
            rejectReason: accountSnapshotNormalization.rejectReason,
        });
    }

    return {
        executionSnapshotNormalization,
        accountSnapshotNormalization,
        summary,
    };
}
