export type RealDataReconciliationConfig = {
    enabled: boolean;
    outputPath: string | null;
    baselinePath: string | null;
    internalOrderSnapshotPath: string | null;
    internalAccountSnapshotPath: string | null;
};

function envFlag(value: string | undefined, fallback: boolean) {
    if (value === undefined) return fallback;
    return value.trim().toLowerCase() === "true";
}

function envString(value: string | undefined) {
    if (value === undefined) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function loadRealDataReconciliationConfig(): RealDataReconciliationConfig {
    return {
        enabled: envFlag(process.env.REAL_DATA_RECONCILIATION_ENABLED, true),
        outputPath: envString(process.env.REAL_DATA_RECONCILIATION_OUTPUT_PATH),
        baselinePath: envString(process.env.REAL_DATA_INTERNAL_BASELINE_PATH),
        internalOrderSnapshotPath: envString(process.env.REAL_DATA_INTERNAL_ORDER_SNAPSHOT_PATH),
        internalAccountSnapshotPath: envString(process.env.REAL_DATA_INTERNAL_ACCOUNT_SNAPSHOT_PATH),
    };
}
