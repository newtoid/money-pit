import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInternalBaselineExport, exportInternalBaseline, loadInternalBaseline } from "../src/live/internalBaseline";

test("internal baseline export writes combined and split files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-baseline-"));
    const combinedPath = path.join(tempDir, "baseline.json");
    const orderPath = path.join(tempDir, "baseline.orders.json");
    const accountPath = path.join(tempDir, "baseline.account.json");
    const baseline = createInternalBaselineExport({
        sourceLabel: "test_baseline",
        provenance: "manual_internal_baseline_export",
        capturedAtMs: 1234,
        orders: [{
            orderId: "order-1",
            executionAttemptId: "attempt-1",
            correlationId: "corr-1",
            legId: "leg-a",
            tokenId: "token-yes",
            binarySide: "yes",
            currentState: "open",
            terminalState: null,
            comparableStatus: "open",
            createdAtMs: 1234,
            updatedAtMs: 1234,
            filledSize: 0,
            averageFillPrice: null,
            fillEventCount: 0,
            filledNotional: null,
            partialFillObserved: false,
            statusProgressionRank: 2,
            knownExternalOrderId: null,
            knownExternalExecutionId: null,
            knownExternalFillIds: [],
            knownVenueOrderRef: null,
            externalIdentifierProvenance: "none",
        }],
        account: {
            accountId: "acct-1",
            sourceLabel: "acct",
            capturedAtMs: 1234,
            assets: [{ assetSymbol: "USDC", availableBalance: 10, reservedBalance: null, totalBalance: null, rawSourceMetadata: null }],
            rawSourceMetadata: null,
        },
    });

    const result = exportInternalBaseline({
        baseline,
        outputPath: combinedPath,
        orderOutputPath: orderPath,
        accountOutputPath: accountPath,
    });

    assert.equal(result.exportedRecordCounts.orders, 1);
    assert.equal(result.exportedRecordCounts.account_assets, 1);
    assert.equal(fs.existsSync(combinedPath), true);
    assert.equal(fs.existsSync(orderPath), true);
    assert.equal(fs.existsSync(accountPath), true);
    assert.deepEqual(result.sectionSourceStatus, {
        orders: "combined_baseline",
        fills: "empty",
        account: "combined_baseline",
    });
    assert.deepEqual(result.sourceCounts, {
        combined_baseline: 2,
        empty: 1,
    });
});

test("internal baseline loader supports combined baseline files", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-baseline-"));
    const combinedPath = path.join(tempDir, "baseline.json");
    fs.writeFileSync(combinedPath, JSON.stringify({
        provenance: "manual_internal_baseline_export",
        sourceLabel: "combined_fixture",
        capturedAtMs: 1234,
        orders: [{
            orderId: "order-1",
            executionAttemptId: "attempt-1",
            correlationId: "corr-1",
            legId: "leg-a",
            tokenId: "token-yes",
            binarySide: "yes",
            currentState: "open",
            terminalState: null,
            comparableStatus: "open",
            createdAtMs: 1234,
            updatedAtMs: 1234,
            filledSize: 0,
            averageFillPrice: null,
            fillEventCount: 0,
            filledNotional: null,
            partialFillObserved: false,
            statusProgressionRank: 2,
            knownExternalOrderId: null,
            knownExternalExecutionId: null,
            knownExternalFillIds: [],
            knownVenueOrderRef: null,
            externalIdentifierProvenance: "none",
        }],
        fills: [],
        account: {
            accountId: "acct-1",
            sourceLabel: "acct",
            capturedAtMs: 1234,
            assets: [],
            rawSourceMetadata: null,
        },
        rawSourceMetadata: null,
    }, null, 2));

    const loaded = loadInternalBaseline({ baselinePath: combinedPath });
    assert.equal(loaded.orders.length, 1);
    assert.equal(loaded.account?.accountId, "acct-1");
    assert.deepEqual(loaded.missingSections, ["fills", "account"]);
    assert.deepEqual(loaded.sectionSources, {
        orders: "combined_baseline",
        fills: "empty",
        account: "empty",
    });
});
