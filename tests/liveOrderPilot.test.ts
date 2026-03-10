import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLiveOrderPilot } from "../src/live/liveOrderPilot";

test("live order pilot denies by default and does not send a request", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-pilot-"));
    let called = false;
    const result = await runLiveOrderPilot({
        config: {
            enabled: true,
            liveExecutionEnabled: false,
            executionKillSwitch: true,
            liveSubmissionMode: "disabled",
            allowlistedMarkets: [],
            allowlistedAssets: [],
            maxOrderSize: 0,
            absoluteMaxOrderSize: 0.1,
            requiredConfirmation: null,
            resultDir: tempDir,
            baselineDir: tempDir,
            logLabel: "test_live_order_pilot",
        },
        request: {
            marketId: "market-1",
            assetId: "asset-1",
            side: "buy",
            price: 0.01,
            size: 0.01,
            tickSize: "0.001",
            timeInForce: "GTC",
            confirmValue: null,
            invokedAtMs: 1000,
        },
        transport: {
            async createAndPostOrder() {
                called = true;
                return { orderID: "should-not-happen" };
            },
        },
    });
    assert.equal(called, false);
    assert.equal(result.terminalState, "denied");
    assert.equal(result.requestSent, false);
    assert.equal(result.guard.reasonCodes.includes("live_execution_disabled"), true);
    assert.equal(result.internalOrderBaselinePath !== null, true);
    assert.equal(fs.existsSync(result.resultOutputPath ?? ""), true);
});

test("live order pilot writes acked result and baseline when transport returns an order id", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-pilot-"));
    const result = await runLiveOrderPilot({
        config: {
            enabled: true,
            liveExecutionEnabled: true,
            executionKillSwitch: false,
            liveSubmissionMode: "one_shot_live_pilot",
            allowlistedMarkets: ["market-1"],
            allowlistedAssets: ["asset-1"],
            maxOrderSize: 0.05,
            absoluteMaxOrderSize: 0.1,
            requiredConfirmation: "CONFIRM",
            resultDir: tempDir,
            baselineDir: tempDir,
            logLabel: "test_live_order_pilot",
        },
        request: {
            marketId: "market-1",
            assetId: "asset-1",
            side: "buy",
            price: 0.01,
            size: 0.01,
            tickSize: "0.001",
            timeInForce: "GTC",
            confirmValue: "CONFIRM",
            invokedAtMs: 1000,
        },
        transport: {
            async createAndPostOrder() {
                return {
                    orderID: "external-order-123",
                    status: "open",
                };
            },
        },
    });
    assert.equal(result.terminalState, "submitted_acknowledged");
    assert.equal(result.requestSent, true);
    assert.equal(result.venueAck?.externalOrderId, "external-order-123");
    assert.equal(result.followUp.recommendedReconcileCommand.includes("venue:reconcile"), true);
    assert.equal(fs.existsSync(result.internalOrderBaselinePath ?? ""), true);
    const baseline = JSON.parse(fs.readFileSync(result.internalOrderBaselinePath!, "utf8"));
    assert.equal(baseline[0].knownExternalOrderId, "external-order-123");
});
