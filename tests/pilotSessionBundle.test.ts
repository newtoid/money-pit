import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportPilotSessionBundle } from "../src/live/pilotSessionBundle";
import { readPilotSessionManifest, writePilotSessionManifest } from "../src/live/pilotSession";

test("exportPilotSessionBundle copies available artifacts and records bundle export on session manifest", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pilot-session-bundle-"));
    const manifestPath = path.join(tempDir, "session-1.session.json");
    const pilotResultPath = path.join(tempDir, "session-1.result.json");
    const orderBaselinePath = path.join(tempDir, "session-1.orders.json");
    const verificationPath = path.join(tempDir, "session-1.verify.json");

    fs.writeFileSync(pilotResultPath, JSON.stringify({ kind: "pilot" }), "utf8");
    fs.writeFileSync(orderBaselinePath, JSON.stringify([{ orderId: "o-1" }]), "utf8");
    fs.writeFileSync(verificationPath, JSON.stringify({ kind: "verify" }), "utf8");

    writePilotSessionManifest({
        manifestPath,
        manifest: {
            pilotSessionId: "session-1",
            sourceLabel: "test",
            createdAtMs: 1000,
            updatedAtMs: 1000,
            executionAttemptId: "exec-1",
            marketId: "market-1",
            assetId: "asset-1",
            externalOrderId: "ext-1",
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
    assert.equal(fs.existsSync(path.join(result.bundleDir, "session.manifest.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "pilot.result.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "order-baseline.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "verification.result.json")), true);
    assert.equal(fs.existsSync(path.join(result.bundleDir, "reconciliation.result.json")), false);
    assert.deepEqual(result.bundleManifest.missingArtifactTypes, ["reconciliation_result"]);

    const updatedManifest = readPilotSessionManifest(manifestPath);
    assert.equal(updatedManifest.latestBundleManifestPath, result.bundleManifestPath);
    assert.equal(updatedManifest.bundleExports?.length, 1);
    assert.equal(updatedManifest.bundleExports?.[0]?.bundleId, result.bundleId);
});
