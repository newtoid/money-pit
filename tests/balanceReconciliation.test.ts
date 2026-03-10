import { test } from "node:test";
import * as assert from "node:assert/strict";
import { runExternalBalanceReconciliation } from "../src/live/balanceReconciliation";
import { buildExternalAccountSnapshot, buildInternalAccountSnapshot } from "./helpers/reconciliationFixtures";

test("balance reconciliation reports agreement for matching asset balances", () => {
    const result = runExternalBalanceReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 1200,
            comparisonMode: "synthetic_external_account_snapshot_compare",
            internalAccount: buildInternalAccountSnapshot(),
            externalAccount: buildExternalAccountSnapshot(),
        },
    });
    assert.equal(result.matchedAssetCount, 2);
    assert.equal(result.mismatchedAssetCount, 0);
    assert.equal(result.issueCountsByType.external_internal_available_balance_mismatch ?? 0, 0);
    assert.equal(result.comparisonCoverageCounts.available_balance, 2);
});

test("balance reconciliation reports available and reserved mismatches explicitly", () => {
    const result = runExternalBalanceReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 1200,
            comparisonMode: "synthetic_external_account_snapshot_compare",
            internalAccount: buildInternalAccountSnapshot(),
            externalAccount: buildExternalAccountSnapshot({
                assets: [
                    {
                        assetSymbol: "USDC",
                        availableBalance: 95,
                        reservedBalance: 12,
                        totalBalance: 107,
                        rawSourceMetadata: null,
                    },
                    {
                        assetSymbol: "YES_TOKEN",
                        availableBalance: 2,
                        reservedBalance: 0,
                        totalBalance: 2,
                        rawSourceMetadata: null,
                    },
                ],
            }),
        },
    });
    assert.equal(result.issueCountsByType.external_internal_available_balance_mismatch, 1);
    assert.equal(result.issueCountsByType.external_internal_reserved_balance_mismatch, 1);
    assert.equal(result.issueCountsByType.external_internal_total_balance_mismatch, 1);
    assert.equal(result.mismatchedAssetCount, 1);
});

test("balance reconciliation reports missing and unexpected asset balances", () => {
    const result = runExternalBalanceReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 1200,
            comparisonMode: "synthetic_external_account_snapshot_compare",
            internalAccount: buildInternalAccountSnapshot(),
            externalAccount: buildExternalAccountSnapshot({
                assets: [
                    {
                        assetSymbol: "USDC",
                        availableBalance: 100,
                        reservedBalance: 10,
                        totalBalance: 110,
                        rawSourceMetadata: null,
                    },
                    {
                        assetSymbol: "NO_TOKEN",
                        availableBalance: 1,
                        reservedBalance: 0,
                        totalBalance: 1,
                        rawSourceMetadata: null,
                    },
                ],
            }),
        },
    });
    assert.equal(result.missingExternalAssetCount, 1);
    assert.equal(result.unexpectedExternalAssetCount, 1);
    assert.equal(result.issueCountsByType.missing_external_asset_balance, 1);
    assert.equal(result.issueCountsByType.unexpected_external_asset_balance, 1);
});

test("balance reconciliation reports insufficient coverage when all comparable fields are missing", () => {
    const result = runExternalBalanceReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 1200,
            comparisonMode: "synthetic_external_account_snapshot_compare",
            internalAccount: buildInternalAccountSnapshot({
                assets: [{
                    assetSymbol: "USDC",
                    availableBalance: null,
                    reservedBalance: null,
                    totalBalance: null,
                    rawSourceMetadata: null,
                }],
            }),
            externalAccount: buildExternalAccountSnapshot({
                assets: [{
                    assetSymbol: "USDC",
                    availableBalance: null,
                    reservedBalance: null,
                    totalBalance: null,
                    rawSourceMetadata: null,
                }],
            }),
        },
    });
    assert.equal(result.insufficientCoverageCount, 1);
    assert.equal(result.issueCountsByType.insufficient_balance_comparison_coverage, 1);
    assert.equal(result.skippedComparisonFields.available_balance, 1);
    assert.equal(result.skippedAssetCount, 1);
});

test("balance reconciliation reports stale external account snapshots", () => {
    const result = runExternalBalanceReconciliation({
        adapterMode: "replay_simulated",
        input: {
            capturedAtMs: 5000,
            comparisonMode: "synthetic_external_account_snapshot_compare",
            internalAccount: buildInternalAccountSnapshot(),
            externalAccount: buildExternalAccountSnapshot({
                capturedAtMs: 1000,
                maxSnapshotAgeMs: 100,
                trustworthy: false,
            }),
        },
    });
    assert.equal(result.staleSnapshotWarningCount, 1);
    assert.equal(result.issueCountsByType.stale_external_account_snapshot, 1);
});
