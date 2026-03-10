import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLivePostSubmitVerification } from "../src/live/livePostSubmitVerification";
import { ReadOnlyVenueConfig } from "../src/config/readOnlyVenue";

function writeJson(tempDir: string, filename: string, value: unknown) {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return filePath;
}

function baseReadOnlyConfig(): ReadOnlyVenueConfig {
    return {
        enabled: true,
        mode: "authenticated_clob_read_only",
        host: "https://clob.polymarket.com",
        chainId: 137,
        readOnlyLogLabel: "test_read_only_venue",
        liveExecutionEnabled: false,
        executionKillSwitch: true,
        privateKey: "0x123",
        apiKey: "k",
        apiSecret: "s",
        apiPassphrase: "p",
        fetchOpenOrders: true,
        fetchTrades: true,
        fetchAccountBalances: true,
        openOrdersMarket: null,
        openOrdersAssetId: null,
        tradesMarket: null,
        tradesAssetId: null,
        balanceTokenIds: [],
    };
}

test("post-submit verification finds pilot external order id and matches pilot baseline", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-verify-"));
    const pilotResultPath = writeJson(tempDir, "pilot.json", {
        terminalState: "submitted_acknowledged",
        requestSent: true,
        denied: false,
        submittedAtMs: 1000,
        executionAttemptId: "live-order-pilot-1000",
        guard: { allow: true, reasonCodes: [], details: {} },
        venueAck: { acknowledged: true, externalOrderId: "ext-order-1", rawStatus: "open", rawResponse: null },
        internalOrderBaselinePath: path.join(tempDir, "pilot.orders.json"),
        resultOutputPath: null,
        followUp: { recommendedReconcileCommand: "npm run venue:reconcile" },
        message: "ok",
    });
    writeJson(tempDir, "pilot.orders.json", [{
        orderId: "live-order-pilot-1000-order-1",
        executionAttemptId: "live-order-pilot-1000",
        correlationId: "live-order-pilot-1000",
        legId: "live-order-pilot-1000-single",
        tokenId: "asset-1",
        binarySide: "yes",
        currentState: "open",
        terminalState: null,
        comparableStatus: "open",
        createdAtMs: 1000,
        updatedAtMs: 1000,
        filledSize: 0,
        averageFillPrice: null,
        fillEventCount: 0,
        filledNotional: null,
        partialFillObserved: false,
        statusProgressionRank: 3,
        knownExternalOrderId: "ext-order-1",
        knownExternalExecutionId: null,
        knownExternalFillIds: [],
        knownVenueOrderRef: "ext-order-1",
        externalIdentifierProvenance: "future_external_identifier_scaffold",
        marketId: "market-1",
    }]);

    const result = await runLivePostSubmitVerification({
        readOnlyVenueConfig: baseReadOnlyConfig(),
        inputs: {
            pilotResultPath,
            internalOrderBaselinePath: null,
            internalAccountBaselinePath: null,
            outputPath: null,
        },
        transport: {
            async getOpenOrders() {
                return [{
                    id: "ext-order-1",
                    asset_id: "asset-1",
                    status: "open",
                    size_matched: 0,
                    original_size: 1,
                    created_at: 1000,
                    owner: "owner",
                    maker_address: "maker",
                    market: "market-1",
                    side: "buy",
                    price: 0.01,
                    outcome: "YES",
                    order_type: "GTC",
                    expiration: "never",
                }] as any;
            },
            async getTrades() {
                return [{
                    id: "trade-1",
                    taker_order_id: "ext-order-1",
                    transaction_hash: "tx-1",
                    size: 1,
                    price: 0.01,
                    match_time: new Date(1000).toISOString(),
                    market: "market-1",
                    asset_id: "asset-1",
                    side: "buy",
                    status: "matched",
                    outcome: "YES",
                    maker_address: "maker",
                    trader_side: "taker",
                    fee_rate_bps: "0",
                    maker_orders: [],
                }] as any;
            },
            async getBalanceAllowance() {
                return { balance: "1", allowance: "1" } as any;
            },
        },
        now: 2000,
    });

    assert.equal(result.externalOrderIdFound, true);
    assert.equal(result.matchingOrderSnapshotCount, 1);
    assert.equal(result.matchingTradeSnapshotCount, 1);
    assert.equal(result.orderReconciliationMatchedPilotBaseline, true);
});

test("post-submit verification reports missing external visibility and partial account coverage explicitly", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-verify-"));
    const pilotResultPath = writeJson(tempDir, "pilot.json", {
        terminalState: "submitted_unknown",
        requestSent: true,
        denied: false,
        submittedAtMs: 1000,
        executionAttemptId: "live-order-pilot-1001",
        guard: { allow: true, reasonCodes: [], details: {} },
        venueAck: { acknowledged: true, externalOrderId: "missing-order", rawStatus: "open", rawResponse: null },
        internalOrderBaselinePath: path.join(tempDir, "pilot.orders.json"),
        resultOutputPath: null,
        followUp: { recommendedReconcileCommand: "npm run venue:reconcile" },
        message: "ok",
    });
    writeJson(tempDir, "pilot.orders.json", [{
        orderId: "live-order-pilot-1001-order-1",
        executionAttemptId: "live-order-pilot-1001",
        correlationId: "live-order-pilot-1001",
        legId: "live-order-pilot-1001-single",
        tokenId: "asset-2",
        binarySide: "yes",
        currentState: "open",
        terminalState: null,
        comparableStatus: "open",
        createdAtMs: 1000,
        updatedAtMs: 1000,
        filledSize: 0,
        averageFillPrice: null,
        fillEventCount: 0,
        filledNotional: null,
        partialFillObserved: false,
        statusProgressionRank: 3,
        knownExternalOrderId: "missing-order",
        knownExternalExecutionId: null,
        knownExternalFillIds: [],
        knownVenueOrderRef: "missing-order",
        externalIdentifierProvenance: "future_external_identifier_scaffold",
        marketId: "market-2",
    }]);

    const result = await runLivePostSubmitVerification({
        readOnlyVenueConfig: baseReadOnlyConfig(),
        inputs: {
            pilotResultPath,
            internalOrderBaselinePath: null,
            internalAccountBaselinePath: null,
            outputPath: null,
        },
        transport: {
            async getOpenOrders() {
                return [] as any;
            },
            async getTrades() {
                return [] as any;
            },
            async getBalanceAllowance() {
                return { balance: "1", allowance: null } as any;
            },
        },
        now: 2000,
    });

    assert.equal(result.externalOrderIdFound, false);
    assert.equal(result.accountPartialCoverageOnly, true);
    assert.equal(result.limitationCounts.pilot_external_order_id_not_found, 1);
});
