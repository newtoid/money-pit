import fs from "node:fs";
import path from "node:path";
import { OrderLifecycleStore } from "./orderLifecycle";
import { buildInternalReconciliationSnapshots } from "./reconciliationModel";
import {
    InternalAccountBaselineSnapshot,
    InternalFillBaselineSnapshot,
    InternalRuntimeBaselineCapture,
} from "./types";

export function captureRuntimeBaselineFromOrderLifecycle(args: {
    sourceLabel: string;
    capturedAtMs?: number;
    orderLifecycleStore: OrderLifecycleStore;
    accountSnapshot?: InternalAccountBaselineSnapshot | null;
    rawSourceMetadata?: Record<string, unknown> | null;
}): InternalRuntimeBaselineCapture {
    const capturedAtMs = args.capturedAtMs ?? Date.now();
    const orders = buildInternalReconciliationSnapshots({
        orders: args.orderLifecycleStore.getAllOrderRecords(),
        fillEvents: args.orderLifecycleStore.getAllFillEvents(),
    });
    const fills = args.orderLifecycleStore.getAllFillEvents().map<InternalFillBaselineSnapshot>((item) => ({
        executionAttemptId: item.executionAttemptId,
        orderId: item.orderId,
        legId: item.legId,
        filledSize: item.filledSize,
        averageFillPrice: item.averageFillPrice,
        ts: item.ts,
        externalIdentifiers: { ...item.externalIdentifiers },
    }));
    const account = args.accountSnapshot ?? null;
    const unavailableSources: string[] = [];
    if (orders.length === 0) unavailableSources.push("order_lifecycle");
    if (fills.length === 0) unavailableSources.push("fill_events");
    if (!account || account.assets.length === 0) unavailableSources.push("internal_account");

    return {
        provenance: "future_runtime_internal_baseline_capture",
        sourceLabel: args.sourceLabel,
        capturedAtMs,
        orders,
        fills,
        account,
        runtimeSourceStatus: {
            orderLifecycleAvailable: orders.length > 0,
            fillEventsAvailable: fills.length > 0,
            internalAccountAvailable: Boolean(account && account.assets.length > 0),
        },
        unavailableSources,
        rawSourceMetadata: args.rawSourceMetadata ?? null,
    };
}

export function writeInternalRuntimeBaselineCapture(args: {
    capture: InternalRuntimeBaselineCapture;
    outputPath: string;
}) {
    const outputPath = path.resolve(args.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(args.capture, null, 2)}\n`, "utf8");
    return outputPath;
}

export function loadInternalRuntimeBaselineCapture(filePath: string): InternalRuntimeBaselineCapture {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as InternalRuntimeBaselineCapture;
}
