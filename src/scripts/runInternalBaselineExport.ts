import { createInternalBaselineExport, exportInternalBaseline, loadInternalBaseline } from "../live/internalBaseline";
import { logger } from "../logger";

function getArgValue(flag: string) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return null;
    return process.argv[index + 1] ?? null;
}

async function main() {
    const baselinePath = getArgValue("--baseline");
    const orderInputPath = getArgValue("--order-input");
    const accountInputPath = getArgValue("--account-input");
    const outputPath = getArgValue("--output") ?? "data/baselines/internal-baseline.json";
    const orderOutputPath = getArgValue("--order-output") ?? "data/baselines/internal-baseline.orders.json";
    const accountOutputPath = getArgValue("--account-output") ?? "data/baselines/internal-baseline.account.json";
    const sourceLabel = getArgValue("--source-label") ?? "manual_internal_baseline_export";

    const loaded = loadInternalBaseline({
        baselinePath,
        orderBaselinePath: orderInputPath,
        accountBaselinePath: accountInputPath,
    });

    const baseline = createInternalBaselineExport({
        sourceLabel,
        provenance: loaded.orders.length === 0 && loaded.fills.length === 0 && (!loaded.account || loaded.account.assets.length === 0)
            ? "empty_internal_baseline_export"
            : "manual_internal_baseline_export",
        orders: loaded.orders,
        fills: loaded.fills,
        account: loaded.account,
        rawSourceMetadata: {
            baselineInputPath: baselinePath,
            orderInputPath,
            accountInputPath,
        },
    });

    const result = exportInternalBaseline({
        baseline,
        outputPath,
        orderOutputPath,
        accountOutputPath,
    });

    logger.info({
        msg: "internal baseline export complete",
        source: "internal_baseline_export",
        provenance: result.exportSnapshot.provenance,
        capturedAtMs: result.exportSnapshot.capturedAtMs,
        exportedRecordCounts: result.exportedRecordCounts,
        missingSections: result.missingSections,
        outputPath: result.outputPath,
        orderOutputPath: result.orderOutputPath,
        accountOutputPath: result.accountOutputPath,
    });

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
    logger.error({
        msg: "internal baseline export failed",
        source: "internal_baseline_export",
        error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
});
