import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLiveOrderPilot } from "../src/live/liveOrderPilot";
import { runLivePostSubmitVerification } from "../src/live/livePostSubmitVerification";
import {
    defaultPilotSessionBundleDir,
    readLatestPilotSessionManifest,
    readPilotSessionManifest,
    writePilotSessionManifest,
} from "../src/live/pilotSession";
import { ReadOnlyVenueConfig } from "../src/config/readOnlyVenue";

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

test("live order pilot creates a session manifest linked to result and baseline artifacts", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-session-"));
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
                return { orderID: "external-order-123", status: "open" };
            },
        },
    });

    assert.equal(result.pilotSessionId, "live-order-pilot-1000");
    assert.equal(fs.existsSync(result.pilotSessionManifestPath ?? ""), true);
    const manifest = readPilotSessionManifest(result.pilotSessionManifestPath!);
    assert.equal(path.basename(result.pilotSessionManifestPath!), "session-manifest.json");
    assert.equal(path.basename(result.resultOutputPath!), "pilot-result.json");
    assert.equal(path.basename(result.internalOrderBaselinePath!), "internal-baseline.orders.json");
    assert.equal(manifest.pilotSessionId, result.pilotSessionId);
    assert.equal(manifest.sessionId, result.pilotSessionId);
    assert.equal(manifest.sessionManifestPath, result.pilotSessionManifestPath);
    assert.equal(manifest.sessionBundleDir, defaultPilotSessionBundleDir({ resultDir: tempDir, pilotSessionId: result.pilotSessionId }));
    assert.equal(manifest.market, "market-1");
    assert.equal(manifest.asset, "asset-1");
    assert.equal(manifest.submissionParameters.size, 0.01);
    assert.equal(manifest.latestArtifactPaths.pilotResult, result.resultOutputPath);
    assert.equal(manifest.latestArtifactPaths.orderBaseline, result.internalOrderBaselinePath);
    assert.equal(manifest.artifacts.length, 2);
    assert.equal(manifest.attachmentStatus.verificationAttached, false);
    assert.equal(manifest.missingArtifacts.includes("verification_result"), true);
  });

test("post-submit verification attaches its artifact to the pilot session manifest", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-session-"));
    const pilot = await runLiveOrderPilot({
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
                return { orderID: "external-order-123", status: "open" };
            },
        },
    });
    const verificationPath = path.join(tempDir, "sessions", pilot.pilotSessionId, "verification-result.json");

    const verification = await runLivePostSubmitVerification({
        readOnlyVenueConfig: baseReadOnlyConfig(),
        inputs: {
            pilotResultPath: pilot.resultOutputPath!,
            internalOrderBaselinePath: null,
            internalAccountBaselinePath: null,
            outputPath: verificationPath,
        },
        transport: {
            async getOpenOrders() {
                return [{
                    id: "external-order-123",
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
                return [] as any;
            },
            async getBalanceAllowance() {
                return { balance: "1", allowance: "1" } as any;
            },
        },
        now: 2000,
    });

    assert.equal(verification.pilotSessionId, pilot.pilotSessionId);
    const manifest = readPilotSessionManifest(pilot.pilotSessionManifestPath!);
    assert.equal(manifest.attachmentStatus.verificationAttached, true);
    assert.equal(manifest.latestArtifactPaths.verificationResult, verificationPath);
    assert.equal(manifest.currentTerminalState, "verification_recorded");
    assert.equal(manifest.artifacts.filter((item) => item.artifactType === "verification_result").length, 1);
    assert.equal(manifest.artifacts.length, 3);
});

test("readLatestPilotSessionManifest returns the newest manifest by mtime", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-session-latest-"));
    const olderManifestPath = path.join(tempDir, "sessions", "older-session", "session-manifest.json");
    const newerManifestPath = path.join(tempDir, "sessions", "newer-session", "session-manifest.json");

    writePilotSessionManifest({
        manifestPath: olderManifestPath,
        manifest: {
            sessionId: "older-session",
            pilotSessionId: "older-session",
            sessionManifestPath: olderManifestPath,
            sessionBundleDir: path.dirname(olderManifestPath),
            sourceLabel: "test",
            timestamp: 1000,
            createdAtMs: 1000,
            updatedAtMs: 1000,
            executionAttemptId: "older-exec",
            market: "market-1",
            marketId: "market-1",
            asset: "asset-1",
            assetId: "asset-1",
            externalOrderId: null,
            submissionParameters: {
                side: "buy",
                price: 0.01,
                size: 0.01,
                tickSize: "0.001",
                timeInForce: "GTC",
            },
            currentTerminalState: "submitted_acknowledged",
            artifacts: [],
            latestArtifactPaths: {
                pilotResult: null,
                orderBaseline: null,
                verificationResult: null,
                reconciliationResult: null,
            },
            attachmentStatus: {
                verificationAttached: false,
                reconciliationAttached: false,
            },
            missingArtifacts: ["pilot_result", "order_baseline", "verification_result"],
            rawSourceMetadata: null,
        },
    });

    writePilotSessionManifest({
        manifestPath: newerManifestPath,
        manifest: {
            sessionId: "newer-session",
            pilotSessionId: "newer-session",
            sessionManifestPath: newerManifestPath,
            sessionBundleDir: path.dirname(newerManifestPath),
            sourceLabel: "test",
            timestamp: 2000,
            createdAtMs: 2000,
            updatedAtMs: 2000,
            executionAttemptId: "newer-exec",
            market: "market-2",
            marketId: "market-2",
            asset: "asset-2",
            assetId: "asset-2",
            externalOrderId: "ext-1",
            submissionParameters: {
                side: "buy",
                price: 0.01,
                size: 0.01,
                tickSize: "0.001",
                timeInForce: "GTC",
            },
            currentTerminalState: "verification_recorded",
            artifacts: [],
            latestArtifactPaths: {
                pilotResult: "/tmp/pilot.result.json",
                orderBaseline: "/tmp/pilot.orders.json",
                verificationResult: "/tmp/pilot.verify.json",
                reconciliationResult: null,
            },
            attachmentStatus: {
                verificationAttached: true,
                reconciliationAttached: false,
            },
            missingArtifacts: [],
            rawSourceMetadata: null,
        },
    });

    const now = new Date();
    fs.utimesSync(olderManifestPath, now, new Date(now.getTime() - 5_000));
    fs.utimesSync(newerManifestPath, now, new Date(now.getTime() + 5_000));

    const latest = readLatestPilotSessionManifest(tempDir);
    assert.ok(latest);
    assert.equal(latest.manifest.pilotSessionId, "newer-session");
    assert.equal(latest.manifestPath, newerManifestPath);
    assert.equal(latest.count, 2);
});
