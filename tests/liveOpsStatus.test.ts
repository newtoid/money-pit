import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLiveOpsStatusSnapshot } from "../src/live/liveOpsStatus";
import { writePilotSessionManifest } from "../src/live/pilotSession";

test("readLiveOpsStatusSnapshot summarizes latest session and session gap counts", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-ops-status-"));
    const previousResultDir = process.env.LIVE_ORDER_PILOT_RESULT_DIR;

    try {
        process.env.LIVE_ORDER_PILOT_RESULT_DIR = tempDir;

        const olderManifestPath = path.join(tempDir, "session-a.session.json");
        const newerManifestPath = path.join(tempDir, "session-b.session.json");

        writePilotSessionManifest({
            manifestPath: olderManifestPath,
            manifest: {
                pilotSessionId: "session-a",
                sourceLabel: "test",
                createdAtMs: 1000,
                updatedAtMs: 1000,
                executionAttemptId: "exec-a",
                marketId: "market-a",
                assetId: "asset-a",
                externalOrderId: null,
                currentTerminalState: "submitted_acknowledged",
                artifacts: [],
                latestArtifactPaths: {
                    pilotResult: "/tmp/a.result.json",
                    orderBaseline: "/tmp/a.orders.json",
                    verificationResult: null,
                    reconciliationResult: null,
                },
                attachmentStatus: {
                    verificationAttached: false,
                    reconciliationAttached: false,
                },
                latestBundleManifestPath: null,
                bundleExports: [],
                missingArtifacts: ["verification_result"],
                rawSourceMetadata: null,
            },
        });

        writePilotSessionManifest({
            manifestPath: newerManifestPath,
            manifest: {
                pilotSessionId: "session-b",
                sourceLabel: "test",
                createdAtMs: 2000,
                updatedAtMs: 2000,
                executionAttemptId: "exec-b",
                marketId: "market-b",
                assetId: "asset-b",
                externalOrderId: "ext-b",
                currentTerminalState: "reconciliation_recorded",
                artifacts: [],
                latestArtifactPaths: {
                    pilotResult: "/tmp/b.result.json",
                    orderBaseline: "/tmp/b.orders.json",
                    verificationResult: "/tmp/b.verify.json",
                    reconciliationResult: "/tmp/b.reconcile.json",
                },
                attachmentStatus: {
                    verificationAttached: true,
                    reconciliationAttached: true,
                },
                latestBundleManifestPath: "/tmp/session-b.bundle.json",
                bundleExports: [{
                    bundleId: "session-b-bundle-3000",
                    bundleManifestPath: "/tmp/session-b.bundle.json",
                    bundleDir: "/tmp/session-b.bundle",
                    exportedAtMs: 3000,
                    missingArtifactTypes: [],
                }],
                missingArtifacts: [],
                rawSourceMetadata: null,
            },
        });

        const now = new Date();
        fs.utimesSync(olderManifestPath, now, new Date(now.getTime() - 5_000));
        fs.utimesSync(newerManifestPath, now, new Date(now.getTime() + 5_000));

        const snapshot = readLiveOpsStatusSnapshot();
        assert.equal(snapshot.sessions.count, 2);
        assert.ok(snapshot.sessions.latest);
        assert.equal(snapshot.sessions.latest?.pilotSessionId, "session-b");
        assert.equal(snapshot.sessions.latest?.manifestPath, newerManifestPath);
        assert.equal(snapshot.sessions.latest?.latestBundleManifestPath, "/tmp/session-b.bundle.json");
        assert.equal(snapshot.sessions.latest?.bundleExportCount, 1);
        assert.equal(snapshot.sessions.countsByGap.missingVerification, 1);
        assert.equal(snapshot.sessions.countsByGap.missingReconciliation, 1);
        assert.equal(snapshot.sessions.countsByGap.fullyLinked, 1);
        assert.equal(snapshot.sessions.latestBundle?.bundleManifestPath, "/tmp/session-b.bundle.json");
    } finally {
        if (previousResultDir === undefined) {
            delete process.env.LIVE_ORDER_PILOT_RESULT_DIR;
        } else {
            process.env.LIVE_ORDER_PILOT_RESULT_DIR = previousResultDir;
        }
    }
});
