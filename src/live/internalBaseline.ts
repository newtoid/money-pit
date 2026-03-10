import fs from "node:fs";
import path from "node:path";
import {
    InternalAccountBaselineSnapshot,
    InternalBaselineCaptureResult,
    InternalBaselineExport,
    InternalFillBaselineSnapshot,
    InternalOrderBaselineSnapshot,
} from "./types";

export type InternalBaselineLoadResult = {
    baseline: InternalBaselineExport | null;
    orders: InternalOrderBaselineSnapshot[];
    fills: InternalFillBaselineSnapshot[];
    account: InternalAccountBaselineSnapshot | null;
    missingSections: string[];
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
    };
}

export function loadInternalBaseline(args: {
    baselinePath?: string | null;
    orderBaselinePath?: string | null;
    accountBaselinePath?: string | null;
}): InternalBaselineLoadResult {
    let baseline: InternalBaselineExport | null = null;
    let orders: InternalOrderBaselineSnapshot[] = [];
    let fills: InternalFillBaselineSnapshot[] = [];
    let account: InternalAccountBaselineSnapshot | null = null;

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
    }

    if (args.orderBaselinePath) {
        orders = readJsonFile<InternalOrderBaselineSnapshot[]>(args.orderBaselinePath);
    }
    if (args.accountBaselinePath) {
        account = readJsonFile<InternalAccountBaselineSnapshot>(args.accountBaselinePath);
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
    };
}
