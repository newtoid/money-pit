import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportPilotSessionBundle } from "../src/live/pilotSessionBundle";
import { readPilotSessionManifest, writePilotSessionManifest } from "../src/live/pilotSession";

test("exportPilotSessionBundle copies available artifacts and records bundle export on session manifest", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-session-bundle-"));
    const manifestPath = path.join(tempDir, "sessions", "session-1", "session-manifest.json");
    const pilotResultPath = path.join(tempDir, "sessions", "session-1", "pilot-result.json");
    const orderBaselinePath = path.join(tempDir, "sessions", "session-1", "internal-baseline.orders.json");
    const verificationPath = path.join(tempDir, "sessions", "session-1", "verification-result.json");

    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(pilotResultPath, JSON.stringify({ kind: "pilot" }), "utf8");
    fs.writeFileSync(orderBaselinePath, JSON.stringify([{ orderId: "o-1" }]), "utf8");
    fs.writeFileSync(verificationPath, JSON.stringify({ kind: "verify" }), "utf8");

    writePilotSessionManifest({
        manifestPath,
        manifest: {
            sessionId: "session-1",
            pilotSessionId: "session-1",
            sessionManifestPath: manifestPath,
            sessionBundleDir: path.dirname(manifestPath),
            sourceLabel: "test",
            timestamp: 1000,
            createdAtMs: 1000,
            updatedAtMs: 1000,
            executionAttemptId: "exec-1",
            market: "market-1",
            marketId: "market-1",
            asset: "asset-1",
            assetId: "asset-1",
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
                pilotResult: pilotResultPath,
                orderBaseline: orderBaselinePath,
                verificationResult: verificationPath,
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

    const result = exportPilotSessionBundle({
        manifestPath,
        bundleRootDir: path.join(tempDir, "bundles"),
        exportedAtMs: 2000,
    });

    assert.equal(result.bundleId, "session-1-bundle-2000");
    assert.equal(fs.existsSync(result.bundleManifestPath), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "session-manifest.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "pilot-result.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "internal-baseline.orders.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "verification-result.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "reconciliation-result.json")), false);
    assert.deepEqual(result.bundleManifest.missingArtifactTypes, ["reconciliation_result"]);

    const updatedManifest = readPilotSessionManifest(manifestPath);
    assert.equal(updatedManifest.latestBundleManifestPath, result.bundleManifestPath);
    assert.equal(updatedManifest.bundleExports?.length, 1);
    assert.equal(updatedManifest.bundleExports?.[0]?.bundleId, result.bundleId);
});
