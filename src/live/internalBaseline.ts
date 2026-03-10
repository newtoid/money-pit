import fs from "node:fs";
import path from "node:path";
import {
    InternalAccountBaselineSnapshot,
    InternalBaselineCaptureResult,
    InternalBaselineExport,
    InternalFillBaselineSnapshot,
    InternalOrderBaselineSnapshot,
    InternalRuntimeBaselineCapture,
} from "./types";
import type { PaperTraderRuntimeBaselineCapture } from "../arbScanner/types";

export type InternalBaselineLoadResult = {
    baseline: InternalBaselineExport | null;
    orders: InternalOrderBaselineSnapshot[];
    fills: InternalFillBaselineSnapshot[];
    account: InternalAccountBaselineSnapshot | null;
    missingSections: string[];
    sectionSources: {
        orders: "runtime_capture" | "combined_baseline" | "split_input" | "empty";
        fills: "runtime_capture" | "combined_baseline" | "empty";
        account: "runtime_capture" | "combined_baseline" | "split_input" | "empty";
    };
    sourceUsage: {
        runtimeCaptureLoaded: boolean;
        combinedBaselineLoaded: boolean;
        splitOrderInputLoaded: boolean;
        splitAccountInputLoaded: boolean;
    };
};

type RawInternalBaselineExport = Partial<InternalBaselineExport>;

function readJsonFile<T>(filePath: string): T {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8")) as T;
}

function defaultEmptyAccount(capturedAtMs: number): InternalAccountBaselineSnapshot {
    return {
        accountId: "internal_baseline_empty_account",
        sourceLabel: "internal_baseline_empty_account",
        capturedAtMs,
        assets: [],
        rawSourceMetadata: null,
    };
}

export function createInternalBaselineExport(args: {
    sourceLabel: string;
    capturedAtMs?: number;
    provenance: InternalBaselineExport["provenance"];
    orders?: InternalOrderBaselineSnapshot[];
    fills?: InternalFillBaselineSnapshot[];
    account?: InternalAccountBaselineSnapshot | null;
    rawSourceMetadata?: Record<string, unknown> | null;
}): InternalBaselineExport {
    return {
        provenance: args.provenance,
        sourceLabel: args.sourceLabel,
        capturedAtMs: args.capturedAtMs ?? Date.now(),
        orders: args.orders ?? [],
        fills: args.fills ?? [],
        account: args.account ?? null,
        rawSourceMetadata: args.rawSourceMetadata ?? null,
    };
}

export function exportInternalBaseline(args: {
    baseline: InternalBaselineExport;
    loaded?: Pick<InternalBaselineLoadResult, "sectionSources" | "sourceUsage">;
    outputPath?: string | null;
    orderOutputPath?: string | null;
    accountOutputPath?: string | null;
}): InternalBaselineCaptureResult {
    const missingSections: string[] = [];
    if (args.baseline.orders.length === 0) missingSections.push("orders");
    if (args.baseline.fills.length === 0) missingSections.push("fills");
    if (!args.baseline.account || args.baseline.account.assets.length === 0) missingSections.push("account");

    if (args.outputPath) {
        const outputPath = path.resolve(args.outputPath);
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${JSON.stringify(args.baseline, null, 2)}\n`, "utf8");
    }
    if (args.orderOutputPath) {
        const orderOutputPath = path.resolve(args.orderOutputPath);
        fs.mkdirSync(path.dirname(orderOutputPath), { recursive: true });
        fs.writeFileSync(orderOutputPath, `${JSON.stringify(args.baseline.orders, null, 2)}\n`, "utf8");
    }
    if (args.accountOutputPath) {
        const accountOutputPath = path.resolve(args.accountOutputPath);
        fs.mkdirSync(path.dirname(accountOutputPath), { recursive: true });
        fs.writeFileSync(accountOutputPath, `${JSON.stringify(args.baseline.account ?? defaultEmptyAccount(args.baseline.capturedAtMs), null, 2)}\n`, "utf8");
    }

    return {
        exportSnapshot: args.baseline,
        outputPath: args.outputPath ?? null,
        orderOutputPath: args.orderOutputPath ?? null,
        accountOutputPath: args.accountOutputPath ?? null,
        exportedRecordCounts: {
            orders: args.baseline.orders.length,
            fills: args.baseline.fills.length,
            account_assets: args.baseline.account?.assets.length ?? 0,
        },
        missingSections,
        sectionSourceStatus: args.loaded?.sectionSources ?? {
            orders: args.baseline.orders.length > 0 ? "combined_baseline" : "empty",
            fills: args.baseline.fills.length > 0 ? "combined_baseline" : "empty",
            account: args.baseline.account && args.baseline.account.assets.length > 0 ? "combined_baseline" : "empty",
        },
        sourceCounts: (() => {
            const sources = args.loaded?.sectionSources ?? {
                orders: args.baseline.orders.length > 0 ? "combined_baseline" : "empty",
                fills: args.baseline.fills.length > 0 ? "combined_baseline" : "empty",
                account: args.baseline.account && args.baseline.account.assets.length > 0 ? "combined_baseline" : "empty",
            };
            return [sources.orders, sources.fills, sources.account].reduce<Record<string, number>>((acc, source) => {
                acc[source] = (acc[source] ?? 0) + 1;
                return acc;
            }, {});
        })(),
    };
}

export function loadInternalBaseline(args: {
    baselinePath?: string | null;
    runtimeCapturePath?: string | null;
    orderBaselinePath?: string | null;
    accountBaselinePath?: string | null;
}): InternalBaselineLoadResult {
    let baseline: InternalBaselineExport | null = null;
    let orders: InternalOrderBaselineSnapshot[] = [];
    let fills: InternalFillBaselineSnapshot[] = [];
    let account: InternalAccountBaselineSnapshot | null = null;
    let ordersSource: InternalBaselineLoadResult["sectionSources"]["orders"] = "empty";
    let fillsSource: InternalBaselineLoadResult["sectionSources"]["fills"] = "empty";
    let accountSource: InternalBaselineLoadResult["sectionSources"]["account"] = "empty";
    let runtimeCaptureLoaded = false;
    let combinedBaselineLoaded = false;
    let splitOrderInputLoaded = false;
    let splitAccountInputLoaded = false;

    if (args.baselinePath) {
        const raw = readJsonFile<RawInternalBaselineExport>(args.baselinePath);
        baseline = {
            provenance: raw.provenance ?? "manual_internal_baseline_export",
            sourceLabel: raw.sourceLabel ?? "manual_internal_baseline_export",
            capturedAtMs: raw.capturedAtMs ?? Date.now(),
            orders: Array.isArray(raw.orders) ? raw.orders as InternalOrderBaselineSnapshot[] : [],
            fills: Array.isArray(raw.fills) ? raw.fills as InternalFillBaselineSnapshot[] : [],
            account: raw.account ? raw.account as InternalAccountBaselineSnapshot : null,
            rawSourceMetadata: raw.rawSourceMetadata ?? null,
        };
        orders = baseline.orders;
        fills = baseline.fills;
        account = baseline.account;
        combinedBaselineLoaded = true;
        if (orders.length > 0) ordersSource = "combined_baseline";
        if (fills.length > 0) fillsSource = "combined_baseline";
        if (account && account.assets.length > 0) accountSource = "combined_baseline";
    }

    if (!args.baselinePath && args.runtimeCapturePath && fs.existsSync(path.resolve(args.runtimeCapturePath))) {
        const runtime = readJsonFile<InternalRuntimeBaselineCapture>(args.runtimeCapturePath);
        baseline = {
            provenance: runtime.provenance,
            sourceLabel: runtime.sourceLabel,
            capturedAtMs: runtime.capturedAtMs,
            orders: runtime.orders,
            fills: runtime.fills,
            account: runtime.account,
            rawSourceMetadata: runtime.rawSourceMetadata,
        };
        orders = baseline.orders;
        fills = baseline.fills;
        account = baseline.account;
        runtimeCaptureLoaded = true;
        if (orders.length > 0) ordersSource = "runtime_capture";
        if (fills.length > 0) fillsSource = "runtime_capture";
        if (account && account.assets.length > 0) accountSource = "runtime_capture";
    }

    if (args.orderBaselinePath) {
        orders = readJsonFile<InternalOrderBaselineSnapshot[]>(args.orderBaselinePath);
        splitOrderInputLoaded = true;
        ordersSource = orders.length > 0 ? "split_input" : "empty";
    }
    if (args.accountBaselinePath) {
        account = readJsonFile<InternalAccountBaselineSnapshot>(args.accountBaselinePath);
        splitAccountInputLoaded = true;
        accountSource = account && account.assets.length > 0 ? "split_input" : "empty";
    }

    const missingSections: string[] = [];
    if (orders.length === 0) missingSections.push("orders");
    if (fills.length === 0) missingSections.push("fills");
    if (!account || account.assets.length === 0) missingSections.push("account");

    return {
        baseline,
        orders,
        fills,
        account,
        missingSections,
        sectionSources: {
            orders: ordersSource,
            fills: fillsSource,
            account: accountSource,
        },
        sourceUsage: {
            runtimeCaptureLoaded,
            combinedBaselineLoaded,
            splitOrderInputLoaded,
            splitAccountInputLoaded,
        },
    };
}

export function mergeRuntimeBaselineCaptures(args: {
    adapterCapture: InternalRuntimeBaselineCapture;
    paperTraderCapture?: PaperTraderRuntimeBaselineCapture | null;
}): InternalRuntimeBaselineCapture {
    const unavailableSources = [...args.adapterCapture.unavailableSources];
    let account = args.adapterCapture.account;
    if (!account && args.paperTraderCapture?.account.available && args.paperTraderCapture.account.snapshot) {
        account = args.paperTraderCapture.account.snapshot;
    }
    if (!args.paperTraderCapture?.account.available) unavailableSources.push("paper_trader_account");

    return {
        provenance: "future_runtime_internal_baseline_capture",
        sourceLabel: "merged_runtime_internal_baseline_capture",
        capturedAtMs: Math.max(args.adapterCapture.capturedAtMs, args.paperTraderCapture?.capturedAtMs ?? 0),
        orders: args.adapterCapture.orders,
        fills: args.adapterCapture.fills,
        account,
        runtimeSourceStatus: {
            orderLifecycleAvailable: args.adapterCapture.runtimeSourceStatus.orderLifecycleAvailable,
            fillEventsAvailable: args.adapterCapture.runtimeSourceStatus.fillEventsAvailable,
            internalAccountAvailable: Boolean(account && account.assets.length > 0),
        },
        unavailableSources,
        rawSourceMetadata: {
            adapterCapture: args.adapterCapture.rawSourceMetadata,
            paperTraderCapture: args.paperTraderCapture?.rawSourceMetadata ?? null,
        },
    };
}

export function runtimeCaptureToBaselineExport(capture: InternalRuntimeBaselineCapture): InternalBaselineExport {
    return {
        provenance: capture.provenance,
        sourceLabel: capture.sourceLabel,
        capturedAtMs: capture.capturedAtMs,
        orders: capture.orders,
        fills: capture.fills,
        account: capture.account,
        rawSourceMetadata: capture.rawSourceMetadata,
    };
}
