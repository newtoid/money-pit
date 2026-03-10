import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecutionAdapter } from "../src/live/createExecutionAdapter";
import { buildExecutionRequest } from "../src/live/buildExecutionRequest";
import { captureRuntimeBaselineFromOrderLifecycle, loadInternalRuntimeBaselineCapture, writeInternalRuntimeBaselineCapture } from "../src/live/runtimeBaselineCapture";
import { loadInternalBaseline, mergeRuntimeBaselineCaptures } from "../src/live/internalBaseline";
import { OrderLifecycleStore } from "../src/live/orderLifecycle";

test("execution adapters expose runtime baseline capture from order lifecycle state", () => {
    const adapter = createExecutionAdapter({
        executionMode: "dry_run_stub",
        liveExecutionEnabled: false,
        executionKillSwitch: true,
    });
    const request = buildExecutionRequest({
        executionAttemptId: "attempt-1",
        source: "paper",
        opportunity: {
            market: {
                marketId: "market-1",
                slug: "m1",
                question: "q",
                yesTokenId: "yes",
                noTokenId: "no",
                endDate: null,
                outcomes: ["YES", "NO"],
            },
            observedAt: 1000,
            edge: 0.1,
            totalAllIn: 0.9,
            costBuffer: 0,
            quote: {
                yesAsk: 0.4,
                noAsk: 0.5,
                yesAskSize: 5,
                noAskSize: 5,
                quoteAgeMs: 0,
            },
        } as any,
        requestedSize: 1,
        createdAtMs: 1000,
    });
    adapter.submitExecutionAttempt(request);
    const capture = adapter.captureInternalRuntimeBaseline(2000);
    assert.equal(capture.orders.length, 2);
    assert.equal(capture.runtimeSourceStatus.orderLifecycleAvailable, true);
    assert.equal(capture.runtimeSourceStatus.internalAccountAvailable, false);
});

test("runtime baseline capture can be written and loaded for baseline export", () => {
    const store = new OrderLifecycleStore();
    const request = {
        executionAttemptId: "attempt-1",
        correlationId: "corr-1",
        source: "paper",
        strategyId: "binary_full_set_arb_v1",
        marketId: "market-1",
        slug: "m1",
        createdAtMs: 1000,
        requestedSize: 1,
        legs: [
            { legId: "a", tokenId: "yes", binarySide: "yes", side: "buy", limitPrice: 0.4, size: 1, timeInForce: "FOK" },
            { legId: "b", tokenId: "no", binarySide: "no", side: "buy", limitPrice: 0.5, size: 1, timeInForce: "FOK" },
        ],
        notes: [],
    } as const;
    store.createFromExecutionRequest(request);
    const capture = captureRuntimeBaselineFromOrderLifecycle({
        sourceLabel: "test_runtime",
        capturedAtMs: 2000,
        orderLifecycleStore: store,
        accountSnapshot: null,
    });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-baseline-"));
    const capturePath = path.join(tempDir, "runtime.json");
    writeInternalRuntimeBaselineCapture({ capture, outputPath: capturePath });
    const loadedCapture = loadInternalRuntimeBaselineCapture(capturePath);
    const loadedBaseline = loadInternalBaseline({ runtimeCapturePath: capturePath });
    assert.equal(loadedCapture.orders.length, 2);
    assert.equal(loadedBaseline.orders.length, 2);
    assert.deepEqual(loadedBaseline.missingSections, ["fills", "account"]);
    assert.deepEqual(loadedBaseline.sectionSources, {
        orders: "runtime_capture",
        fills: "empty",
        account: "empty",
    });
    assert.equal(loadedBaseline.sourceUsage.runtimeCaptureLoaded, true);
});

test("runtime baseline merge preserves unavailable account state explicitly", () => {
    const merged = mergeRuntimeBaselineCaptures({
        adapterCapture: {
            provenance: "future_runtime_internal_baseline_capture",
            sourceLabel: "adapter",
            capturedAtMs: 1000,
            orders: [],
            fills: [],
            account: null,
            runtimeSourceStatus: {
                orderLifecycleAvailable: false,
                fillEventsAvailable: false,
                internalAccountAvailable: false,
            },
            unavailableSources: ["order_lifecycle", "fill_events", "internal_account"],
            rawSourceMetadata: null,
        },
        paperTraderCapture: {
            provenance: "future_runtime_internal_baseline_capture",
            sourceLabel: "paper_trader_runtime_state",
            capturedAtMs: 1000,
            account: {
                snapshot: null,
                available: false,
                reason: "unavailable_runtime_account_state",
            },
            rawSourceMetadata: null,
        },
    });
    assert.equal(merged.account, null);
    assert.equal(merged.runtimeSourceStatus.internalAccountAvailable, false);
    assert.equal(merged.unavailableSources.includes("paper_trader_account"), true);
});
