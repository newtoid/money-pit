import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssetType, Side } from "@polymarket/clob-client";
import { ReadOnlyVenueConfig } from "../src/config/readOnlyVenue";
import { RealDataReconciliationConfig } from "../src/config/realDataReconciliation";
import { runRealDataReconciliationProbe } from "../src/live/realDataReconciliationProbe";
import { ReadOnlyVenueTransport } from "../src/adapters/readOnlyVenue";

function sampleReadOnlyConfig(overrides?: Partial<ReadOnlyVenueConfig>): ReadOnlyVenueConfig {
    return {
        enabled: true,
        mode: "authenticated_clob_read_only",
        host: "https://clob.polymarket.com",
        chainId: 137,
        readOnlyLogLabel: "real_data_probe_test",
        liveExecutionEnabled: false,
        executionKillSwitch: true,
        privateKey: "0xabc",
        apiKey: "key",
        apiSecret: "secret",
        apiPassphrase: "passphrase",
        fetchOpenOrders: true,
        fetchTrades: true,
        fetchAccountBalances: true,
        openOrdersMarket: null,
        openOrdersAssetId: null,
        tradesMarket: null,
        tradesAssetId: null,
        balanceTokenIds: ["token-yes"],
        ...overrides,
    };
}

function sampleProbeConfig(overrides?: Partial<RealDataReconciliationConfig>): RealDataReconciliationConfig {
    return {
        enabled: true,
        outputPath: null,
        internalOrderSnapshotPath: null,
        internalAccountSnapshotPath: null,
        ...overrides,
    };
}

function sampleTransport(): ReadOnlyVenueTransport {
    return {
        async getOpenOrders() {
            return [{
                id: "external-order-1",
                status: "open",
                owner: "owner",
                maker_address: "maker",
                market: "market-1",
                asset_id: "token-yes",
                side: "buy",
                original_size: "10",
                size_matched: "2",
                price: "0.45",
                associate_trades: [],
                outcome: "YES",
                created_at: 1200,
                expiration: "999999",
                order_type: "GTC",
            }];
        },
        async getTrades() {
            return [{
                id: "external-fill-1",
                taker_order_id: "external-order-1",
                market: "market-1",
                asset_id: "token-yes",
                side: Side.BUY,
                size: "2",
                fee_rate_bps: "0",
                price: "0.45",
                status: "MATCHED",
                match_time: new Date(1300).toISOString(),
                last_update: new Date(1301).toISOString(),
                outcome: "YES",
                bucket_index: 0,
                owner: "owner",
                maker_address: "maker",
                maker_orders: [],
                transaction_hash: "tx-1",
                trader_side: "TAKER",
            }];
        },
        async getBalanceAllowance(params) {
            if (params.asset_type === AssetType.COLLATERAL) {
                return { balance: "100", allowance: "90" };
            }
            return { balance: "3", allowance: "0" };
        },
    };
}

test("real-data reconciliation probe reports partial coverage when no internal baselines are provided", async () => {
    const result = await runRealDataReconciliationProbe({
        readOnlyVenueConfig: sampleReadOnlyConfig(),
        probeConfig: sampleProbeConfig(),
        transport: sampleTransport(),
        now: 2000,
    });
    assert.equal(result.fetch.summary.successfulFetchCounts.open_orders, 1);
    assert.equal(result.fetch.summary.successfulFetchCounts.trades, 1);
    assert.equal(result.fetch.summary.successfulFetchCounts.balance_allowance, 2);
    assert.equal(result.internalOrderBaselineCount, 0);
    assert.equal(result.internalAccountBaselineAssetCount, 0);
    assert.equal(result.orderReconciliation?.unexpectedExternalOrderCount, 1);
    assert.equal(result.balanceReconciliation?.unexpectedExternalAssetCount, 2);
    assert.equal(result.limitationCounts.missing_internal_order_baseline, 1);
    assert.equal(result.limitationCounts.missing_internal_account_baseline, 1);
});

test("real-data reconciliation probe uses provided internal baselines and can write output", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "real-data-probe-"));
    const internalOrdersPath = path.join(tempDir, "orders.json");
    const internalAccountPath = path.join(tempDir, "account.json");
    const outputPath = path.join(tempDir, "result.json");

    fs.writeFileSync(internalOrdersPath, JSON.stringify([{
        orderId: "internal-order-1",
        executionAttemptId: "attempt-1",
        correlationId: "corr-1",
        legId: "leg-a",
        tokenId: "token-yes",
        binarySide: "yes",
        currentState: "open",
        comparableStatus: "open",
        filledSize: 2,
        averageFillPrice: 0.45,
        fillEventCount: 1,
        filledNotional: 0.9,
        partialFillObserved: false,
        statusProgressionRank: 2,
        knownExternalOrderId: "external-order-1",
        knownExternalExecutionId: null,
        knownExternalFillIds: ["external-fill-1"],
        knownVenueOrderRef: null,
        externalIdentifierProvenance: "future_external_identifier_scaffold",
    }], null, 2));

    fs.writeFileSync(internalAccountPath, JSON.stringify({
        accountId: "acct-1",
        sourceLabel: "internal_balance_fixture",
        capturedAtMs: 2000,
        assets: [
            { assetSymbol: "USDC", availableBalance: 100, reservedBalance: null, totalBalance: null, rawSourceMetadata: null },
            { assetSymbol: "token-yes", availableBalance: 3, reservedBalance: null, totalBalance: null, rawSourceMetadata: null },
        ],
        rawSourceMetadata: null,
    }, null, 2));

    const result = await runRealDataReconciliationProbe({
        readOnlyVenueConfig: sampleReadOnlyConfig(),
        probeConfig: sampleProbeConfig({
            internalOrderSnapshotPath: internalOrdersPath,
            internalAccountSnapshotPath: internalAccountPath,
            outputPath,
        }),
        transport: sampleTransport(),
        now: 2000,
    });

    assert.equal(result.internalOrderBaselineCount, 1);
    assert.equal(result.internalAccountBaselineAssetCount, 2);
    assert.equal(result.orderReconciliation?.matchCountsByRule.matched_by_external_order_id, 2);
    assert.equal(result.orderReconciliation?.unexpectedExternalOrderCount, 0);
    assert.equal(result.balanceReconciliation?.comparedAssetCount, 1);
    assert.equal(result.balanceReconciliation?.unexpectedExternalAssetCount, 1);
    assert.equal(fs.existsSync(outputPath), true);
});
