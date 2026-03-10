import { test } from "node:test";
import * as assert from "node:assert/strict";
import { normalizeExternalAccountSnapshotIngestion } from "../src/live/accountSnapshotIngestion";
import { buildExternalAccountSnapshotIngestion } from "./helpers/reconciliationFixtures";

test("account snapshot ingestion normalizes valid complete account snapshots", () => {
    const result = normalizeExternalAccountSnapshotIngestion(buildExternalAccountSnapshotIngestion({
        provenance: "future_external_account_api_shape",
        sourceLabel: "future-account-api-shape",
    }));
    assert.equal(result.accepted, true);
    assert.equal(result.snapshot?.provenance, "future_external_account_api_shape");
    assert.equal(result.snapshot?.assets[0]?.availableBalance, 100);
    assert.equal(result.snapshot?.reservedBalances[0]?.amount, 10);
    assert.equal(result.warnings.length, 0);
});

test("account snapshot ingestion accepts valid partial snapshots and warns on missing balance fields", () => {
    const result = normalizeExternalAccountSnapshotIngestion(buildExternalAccountSnapshotIngestion({
        assets: [
            {
                assetSymbol: "USDC",
                availableBalance: "100",
                reservedBalance: null,
                totalBalance: null,
            },
        ],
        reservedBalances: [],
    }));
    assert.equal(result.accepted, true);
    assert.ok(result.warnings.some((item) => item.warningType === "missing_balance_field"));
});

test("account snapshot ingestion rejects malformed account snapshots", () => {
    const missingSource = normalizeExternalAccountSnapshotIngestion(buildExternalAccountSnapshotIngestion({
        sourceLabel: "",
    }));
    assert.equal(missingSource.accepted, false);
    assert.equal(missingSource.rejectReason, "missing_source_label");

    const missingPayload = normalizeExternalAccountSnapshotIngestion({
        provenance: "synthetic_test_account_snapshot",
        sourceLabel: "missing-payload",
        capturedAtMs: 1000,
        assets: null,
        reservedBalances: null,
    });
    assert.equal(missingPayload.accepted, false);
    assert.equal(missingPayload.rejectReason, "missing_account_snapshot_payload");
});

test("account snapshot ingestion reports stale snapshots and malformed entries", () => {
    const result = normalizeExternalAccountSnapshotIngestion(buildExternalAccountSnapshotIngestion({
        ingestedAtMs: 5000,
        maxSnapshotAgeMs: 100,
        assets: [
            {
                assetSymbol: "",
                availableBalance: "oops",
                reservedBalance: "1",
                totalBalance: "2",
            },
            {
                assetSymbol: "USDC",
                availableBalance: "100",
                reservedBalance: "10",
                totalBalance: "110",
            },
        ],
        reservedBalances: [
            {
                assetSymbol: "USDC",
                reservationType: "",
                amount: "bad",
            },
        ],
    }));
    assert.equal(result.accepted, true);
    assert.ok(result.warnings.some((item) => item.warningType === "stale_account_snapshot_input"));
    assert.ok(result.warnings.some((item) => item.warningType === "missing_asset_symbol"));
    assert.ok(result.warnings.some((item) => item.warningType === "missing_reserved_balance_key"));
});

test("account snapshot ingestion preserves provenance/source metadata", () => {
    const result = normalizeExternalAccountSnapshotIngestion(buildExternalAccountSnapshotIngestion({
        provenance: "replay_generated_account_snapshot",
        sourceLabel: "replay-generated-account",
        rawSourceMetadata: {
            fixtureScenario: "provenance-check",
        },
    }));
    assert.equal(result.accepted, true);
    assert.equal(result.snapshot?.sourceLabel, "replay-generated-account");
    assert.equal(result.snapshot?.provenance, "replay_generated_account_snapshot");
    assert.deepEqual(result.snapshot?.rawSourceMetadata, { fixtureScenario: "provenance-check" });
});
