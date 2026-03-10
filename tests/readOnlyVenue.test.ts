import { test } from "node:test";
import * as assert from "node:assert/strict";
import { AssetType, Side } from "@polymarket/clob-client";
import { assertReadOnlyVenueSafety, loadReadOnlyVenueConfig, ReadOnlyVenueConfig } from "../src/config/readOnlyVenue";
import { fetchAndNormalizeReadOnlyVenueData, ReadOnlyVenueTransport } from "../src/adapters/readOnlyVenue";

function sampleConfig(overrides?: Partial<ReadOnlyVenueConfig>): ReadOnlyVenueConfig {
    return {
        enabled: true,
        mode: "authenticated_clob_read_only",
        host: "https://clob.polymarket.com",
        chainId: 137,
        readOnlyLogLabel: "test_read_only_venue",
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

function sampleTransport(): ReadOnlyVenueTransport {
    return {
        async getOpenOrders() {
            return [{
                id: "order-1",
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
                id: "fill-1",
                taker_order_id: "order-1",
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
            return { balance: "2", allowance: "0" };
        },
    };
}

test("read-only venue fetch normalizes real fetched data and reports counts", async () => {
    const result = await fetchAndNormalizeReadOnlyVenueData({
        config: sampleConfig(),
        transport: sampleTransport(),
        now: 2000,
    });
    assert.equal(result.summary.successfulFetchCounts.open_orders, 1);
    assert.equal(result.summary.successfulFetchCounts.trades, 1);
    assert.equal(result.summary.successfulFetchCounts.balance_allowance, 2);
    assert.equal(result.executionSnapshotNormalization?.accepted, true);
    assert.equal(result.accountSnapshotNormalization?.accepted, true);
    assert.equal(result.summary.provenanceCounts.real_readonly_clob_open_orders_trades_api, 1);
    assert.equal(result.summary.provenanceCounts.real_readonly_clob_balance_allowance_api, 1);
});

test("read-only venue fetch reports failed fetches and partial real-data warnings", async () => {
    const failingTransport: ReadOnlyVenueTransport = {
        async getOpenOrders() {
            throw new Error("open orders unavailable");
        },
        async getTrades() {
            return [];
        },
        async getBalanceAllowance() {
            return { balance: "5", allowance: "1" };
        },
    };
    const result = await fetchAndNormalizeReadOnlyVenueData({
        config: sampleConfig({
            fetchOpenOrders: true,
            fetchTrades: false,
            balanceTokenIds: [],
        }),
        transport: failingTransport,
        now: 2000,
    });
    assert.equal(result.summary.failedFetchCounts.open_orders, 1);
    assert.equal(result.summary.successfulFetchCounts.balance_allowance, 1);
    assert.equal(result.summary.partialRealDataWarningCounts.account_snapshot, 1);
});

test("read-only safety gates reject unsafe config", () => {
    assert.throws(() => assertReadOnlyVenueSafety(sampleConfig({ liveExecutionEnabled: true })));
    assert.throws(() => assertReadOnlyVenueSafety(sampleConfig({ executionKillSwitch: false })));
});

test("read-only config loader preserves strict safety defaults", () => {
    const previous = {
        READ_ONLY_VENUE_ENABLED: process.env.READ_ONLY_VENUE_ENABLED,
        LIVE_EXECUTION_ENABLED: process.env.LIVE_EXECUTION_ENABLED,
        EXECUTION_KILL_SWITCH: process.env.EXECUTION_KILL_SWITCH,
    };
    process.env.READ_ONLY_VENUE_ENABLED = "true";
    delete process.env.LIVE_EXECUTION_ENABLED;
    delete process.env.EXECUTION_KILL_SWITCH;
    const config = loadReadOnlyVenueConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.liveExecutionEnabled, false);
    assert.equal(config.executionKillSwitch, true);
    process.env.READ_ONLY_VENUE_ENABLED = previous.READ_ONLY_VENUE_ENABLED;
    process.env.LIVE_EXECUTION_ENABLED = previous.LIVE_EXECUTION_ENABLED;
    process.env.EXECUTION_KILL_SWITCH = previous.EXECUTION_KILL_SWITCH;
});
