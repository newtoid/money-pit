import {
    AccountSnapshotNormalizationResult,
    BalanceComparisonField,
    BalanceReconciliationComparison,
    BalanceReconciliationInput,
    BalanceReconciliationIssue,
    BalanceReconciliationIssueType,
    BalanceReconciliationResult,
    ExternalAssetBalanceSnapshot,
    ExternalBalanceReconciliationSummary,
    InternalAssetBalanceSnapshot,
} from "./types";

const EPSILON = 1e-9;

function makeIssue(args: {
    issueType: BalanceReconciliationIssueType;
    accountId: string | null;
    assetSymbol: string | null;
    message: string;
    details: Record<string, number | string | boolean | null>;
}): BalanceReconciliationIssue {
    return {
        issueType: args.issueType,
        accountId: args.accountId,
        assetSymbol: args.assetSymbol,
        message: args.message,
        details: args.details,
    };
}

function compareField(args: {
    field: BalanceComparisonField;
    internalValue: number | null;
    externalValue: number | null;
    issueType:
        | "external_internal_available_balance_mismatch"
        | "external_internal_reserved_balance_mismatch"
        | "external_internal_total_balance_mismatch";
    accountId: string | null;
    assetSymbol: string;
    issues: BalanceReconciliationIssue[];
    issueCountsByType: Record<string, number>;
    comparisonCoverageCounts: Record<string, number>;
    skippedComparisonFields: Record<string, number>;
    comparisonIssueTypes: BalanceReconciliationIssueType[];
    comparisonDetails: Record<string, number | string | boolean | null>;
    detailsKeyPrefix: string;
}) {
    if (args.internalValue === null || args.externalValue === null) {
        args.skippedComparisonFields[args.field] = (args.skippedComparisonFields[args.field] ?? 0) + 1;
        return true;
    }
    args.comparisonCoverageCounts[args.field] = (args.comparisonCoverageCounts[args.field] ?? 0) + 1;
    args.comparisonDetails[`internal_${args.detailsKeyPrefix}`] = args.internalValue;
    args.comparisonDetails[`external_${args.detailsKeyPrefix}`] = args.externalValue;
    if (Math.abs(args.internalValue - args.externalValue) > EPSILON) {
        args.comparisonIssueTypes.push(args.issueType);
        args.issueCountsByType[args.issueType] = (args.issueCountsByType[args.issueType] ?? 0) + 1;
        args.issues.push(makeIssue({
            issueType: args.issueType,
            accountId: args.accountId,
            assetSymbol: args.assetSymbol,
            message: `${args.field} differs between internal and external account snapshots`,
            details: {
                [`internal_${args.detailsKeyPrefix}`]: args.internalValue,
                [`external_${args.detailsKeyPrefix}`]: args.externalValue,
            },
        }));
    }
    return false;
}

export function runNoopBalanceReconciliation(args: {
    adapterMode: BalanceReconciliationResult["adapterMode"];
    input: BalanceReconciliationInput;
}): BalanceReconciliationResult {
    return {
        adapterMode: args.adapterMode,
        comparisonMode: "noop_stub",
        capturedAtMs: args.input.capturedAtMs,
        snapshotProvenance: args.input.externalAccount.provenance,
        snapshotSourceLabel: args.input.externalAccount.sourceLabel,
        snapshotTrustworthy: args.input.externalAccount.trustworthy,
        issueCountsByType: {},
        comparisonCoverageCounts: {},
        skippedComparisonFields: {},
        matchedAssetCount: 0,
        mismatchedAssetCount: 0,
        missingExternalAssetCount: 0,
        unexpectedExternalAssetCount: 0,
        staleSnapshotWarningCount: 0,
        insufficientCoverageCount: 0,
        comparedAssetCount: 0,
        skippedAssetCount: 0,
        comparisons: [],
        issues: [],
    };
}

export function runExternalBalanceReconciliation(args: {
    adapterMode: BalanceReconciliationResult["adapterMode"];
    input: BalanceReconciliationInput;
}): BalanceReconciliationResult {
    const issueCountsByType: Record<string, number> = {};
    const comparisonCoverageCounts: Record<string, number> = {};
    const skippedComparisonFields: Record<string, number> = {};
    const comparisons: BalanceReconciliationComparison[] = [];
    const issues: BalanceReconciliationIssue[] = [];

    const externalByAsset = new Map<string, ExternalAssetBalanceSnapshot>();
    for (const asset of args.input.externalAccount.assets) {
        externalByAsset.set(asset.assetSymbol, asset);
    }
    const internalByAsset = new Map<string, InternalAssetBalanceSnapshot>();
    for (const asset of args.input.internalAccount.assets) {
        internalByAsset.set(asset.assetSymbol, asset);
    }

    let matchedAssetCount = 0;
    let mismatchedAssetCount = 0;
    let missingExternalAssetCount = 0;
    let unexpectedExternalAssetCount = 0;
    let staleSnapshotWarningCount = 0;
    let insufficientCoverageCount = 0;
    let comparedAssetCount = 0;
    let skippedAssetCount = 0;

    if (
        args.input.externalAccount.maxSnapshotAgeMs !== null
        && (args.input.capturedAtMs - args.input.externalAccount.capturedAtMs) > args.input.externalAccount.maxSnapshotAgeMs
    ) {
        staleSnapshotWarningCount += 1;
        issueCountsByType.stale_external_account_snapshot = 1;
        issues.push(makeIssue({
            issueType: "stale_external_account_snapshot",
            accountId: args.input.externalAccount.accountId,
            assetSymbol: null,
            message: "external account snapshot is stale",
            details: {
                capturedAtMs: args.input.capturedAtMs,
                snapshotCapturedAtMs: args.input.externalAccount.capturedAtMs,
                maxSnapshotAgeMs: args.input.externalAccount.maxSnapshotAgeMs,
            },
        }));
    }

    for (const internalAsset of args.input.internalAccount.assets) {
        const externalAsset = externalByAsset.get(internalAsset.assetSymbol) ?? null;
        if (!externalAsset) {
            missingExternalAssetCount += 1;
            issueCountsByType.missing_external_asset_balance = (issueCountsByType.missing_external_asset_balance ?? 0) + 1;
            issues.push(makeIssue({
                issueType: "missing_external_asset_balance",
                accountId: args.input.externalAccount.accountId,
                assetSymbol: internalAsset.assetSymbol,
                message: "internal asset has no external balance snapshot",
                details: {
                    internalAccountId: args.input.internalAccount.accountId,
                },
            }));
            comparisons.push({
                accountId: args.input.externalAccount.accountId,
                assetSymbol: internalAsset.assetSymbol,
                matched: false,
                issueTypes: ["missing_external_asset_balance"],
                skippedFields: ["available_balance", "reserved_balance", "total_balance"],
                details: {
                    externalAssetPresent: false,
                },
            });
            skippedAssetCount += 1;
            continue;
        }

        const comparisonIssueTypes: BalanceReconciliationIssueType[] = [];
        const skippedFields: BalanceComparisonField[] = [];
        const comparisonDetails: Record<string, number | string | boolean | null> = {
            externalAssetPresent: true,
        };

        const skippedAvailable = compareField({
            field: "available_balance",
            internalValue: internalAsset.availableBalance,
            externalValue: externalAsset.availableBalance,
            issueType: "external_internal_available_balance_mismatch",
            accountId: args.input.externalAccount.accountId,
            assetSymbol: internalAsset.assetSymbol,
            issues,
            issueCountsByType,
            comparisonCoverageCounts,
            skippedComparisonFields,
            comparisonIssueTypes,
            comparisonDetails,
            detailsKeyPrefix: "available_balance",
        });
        if (skippedAvailable) skippedFields.push("available_balance");

        const skippedReserved = compareField({
            field: "reserved_balance",
            internalValue: internalAsset.reservedBalance,
            externalValue: externalAsset.reservedBalance,
            issueType: "external_internal_reserved_balance_mismatch",
            accountId: args.input.externalAccount.accountId,
            assetSymbol: internalAsset.assetSymbol,
            issues,
            issueCountsByType,
            comparisonCoverageCounts,
            skippedComparisonFields,
            comparisonIssueTypes,
            comparisonDetails,
            detailsKeyPrefix: "reserved_balance",
        });
        if (skippedReserved) skippedFields.push("reserved_balance");

        const skippedTotal = compareField({
            field: "total_balance",
            internalValue: internalAsset.totalBalance,
            externalValue: externalAsset.totalBalance,
            issueType: "external_internal_total_balance_mismatch",
            accountId: args.input.externalAccount.accountId,
            assetSymbol: internalAsset.assetSymbol,
            issues,
            issueCountsByType,
            comparisonCoverageCounts,
            skippedComparisonFields,
            comparisonIssueTypes,
            comparisonDetails,
            detailsKeyPrefix: "total_balance",
        });
        if (skippedTotal) skippedFields.push("total_balance");

        if (skippedFields.length === 3) {
            insufficientCoverageCount += 1;
            issueCountsByType.insufficient_balance_comparison_coverage = (issueCountsByType.insufficient_balance_comparison_coverage ?? 0) + 1;
            issues.push(makeIssue({
                issueType: "insufficient_balance_comparison_coverage",
                accountId: args.input.externalAccount.accountId,
                assetSymbol: internalAsset.assetSymbol,
                message: "balance comparison skipped because comparable fields are missing",
                details: {
                    skippedFieldCount: skippedFields.length,
                },
            }));
            comparisonIssueTypes.push("insufficient_balance_comparison_coverage");
            skippedAssetCount += 1;
        } else {
            comparedAssetCount += 1;
        }

        if (comparisonIssueTypes.length === 0) matchedAssetCount += 1;
        else mismatchedAssetCount += 1;

        comparisons.push({
            accountId: args.input.externalAccount.accountId,
            assetSymbol: internalAsset.assetSymbol,
            matched: comparisonIssueTypes.length === 0,
            issueTypes: comparisonIssueTypes,
            skippedFields,
            details: comparisonDetails,
        });
    }

    for (const externalAsset of args.input.externalAccount.assets) {
        if (internalByAsset.has(externalAsset.assetSymbol)) continue;
        unexpectedExternalAssetCount += 1;
        issueCountsByType.unexpected_external_asset_balance = (issueCountsByType.unexpected_external_asset_balance ?? 0) + 1;
        issues.push(makeIssue({
            issueType: "unexpected_external_asset_balance",
            accountId: args.input.externalAccount.accountId,
            assetSymbol: externalAsset.assetSymbol,
            message: "external asset balance has no internal counterpart",
            details: {
                sourceLabel: args.input.externalAccount.sourceLabel,
            },
        }));
        comparisons.push({
            accountId: args.input.externalAccount.accountId,
            assetSymbol: externalAsset.assetSymbol,
            matched: false,
            issueTypes: ["unexpected_external_asset_balance"],
            skippedFields: ["available_balance", "reserved_balance", "total_balance"],
            details: {
                internalAssetPresent: false,
            },
        });
        skippedAssetCount += 1;
    }

    return {
        adapterMode: args.adapterMode,
        comparisonMode: "synthetic_external_account_snapshot_compare",
        capturedAtMs: args.input.capturedAtMs,
        snapshotProvenance: args.input.externalAccount.provenance,
        snapshotSourceLabel: args.input.externalAccount.sourceLabel,
        snapshotTrustworthy: args.input.externalAccount.trustworthy,
        issueCountsByType,
        comparisonCoverageCounts,
        skippedComparisonFields,
        matchedAssetCount,
        mismatchedAssetCount,
        missingExternalAssetCount,
        unexpectedExternalAssetCount,
        staleSnapshotWarningCount,
        insufficientCoverageCount,
        comparedAssetCount,
        skippedAssetCount,
        comparisons,
        issues,
    };
}

export class ExternalBalanceReconciliationStore {
    private readonly results: BalanceReconciliationResult[] = [];
    private readonly normalizationResults: AccountSnapshotNormalizationResult[] = [];

    record(result: BalanceReconciliationResult) {
        this.results.push(result);
        return result;
    }

    recordNormalization(result: AccountSnapshotNormalizationResult) {
        this.normalizationResults.push(result);
        return result;
    }

    getSummary(): ExternalBalanceReconciliationSummary {
        const summary = this.results.reduce<ExternalBalanceReconciliationSummary>((acc, result) => {
            acc.reconciliationRuns += 1;
            for (const [issueType, count] of Object.entries(result.issueCountsByType)) {
                acc.issueCountsByType[issueType] = (acc.issueCountsByType[issueType] ?? 0) + count;
            }
            for (const [field, count] of Object.entries(result.comparisonCoverageCounts)) {
                acc.comparisonCoverageCounts[field] = (acc.comparisonCoverageCounts[field] ?? 0) + count;
            }
            for (const [field, count] of Object.entries(result.skippedComparisonFields)) {
                acc.skippedComparisonFields[field] = (acc.skippedComparisonFields[field] ?? 0) + count;
            }
            acc.matchedAssetCount += result.matchedAssetCount;
            acc.mismatchedAssetCount += result.mismatchedAssetCount;
            acc.missingExternalAssetCount += result.missingExternalAssetCount;
            acc.unexpectedExternalAssetCount += result.unexpectedExternalAssetCount;
            acc.staleSnapshotWarningCount += result.staleSnapshotWarningCount;
            acc.insufficientCoverageCount += result.insufficientCoverageCount;
            acc.comparedAssetCount += result.comparedAssetCount;
            acc.skippedAssetCount += result.skippedAssetCount;
            acc.lastComparisonMode = result.comparisonMode;
            acc.lastSnapshotSourceLabel = result.snapshotSourceLabel;
            if (result.snapshotTrustworthy) acc.trustworthySnapshotCount += 1;
            else acc.untrustworthySnapshotCount += 1;
            acc.snapshotsByProvenance[result.snapshotProvenance] = (acc.snapshotsByProvenance[result.snapshotProvenance] ?? 0) + 1;
            return acc;
        }, {
            reconciliationRuns: 0,
            issueCountsByType: {},
            comparisonCoverageCounts: {},
            skippedComparisonFields: {},
            matchedAssetCount: 0,
            mismatchedAssetCount: 0,
            missingExternalAssetCount: 0,
            unexpectedExternalAssetCount: 0,
            staleSnapshotWarningCount: 0,
            insufficientCoverageCount: 0,
            comparedAssetCount: 0,
            skippedAssetCount: 0,
            lastComparisonMode: null,
            lastSnapshotSourceLabel: null,
            trustworthySnapshotCount: 0,
            untrustworthySnapshotCount: 0,
            snapshotsByProvenance: {},
            ingestedAccountSnapshotsByProvenance: {},
            malformedAccountSnapshotRejectCount: 0,
            staleAccountSnapshotInputCount: 0,
            accountSnapshotNormalizationWarningCounts: {},
            accountSnapshotsMissingKeyBalanceFields: 0,
        });
        for (const normalization of this.normalizationResults) {
            if (!normalization.accepted) {
                summary.malformedAccountSnapshotRejectCount += 1;
                continue;
            }
            const snapshot = normalization.snapshot;
            if (!snapshot) continue;
            summary.ingestedAccountSnapshotsByProvenance[snapshot.provenance] = (summary.ingestedAccountSnapshotsByProvenance[snapshot.provenance] ?? 0) + 1;
            let missingKeyBalanceFields = false;
            for (const warning of normalization.warnings) {
                summary.accountSnapshotNormalizationWarningCounts[warning.warningType] = (summary.accountSnapshotNormalizationWarningCounts[warning.warningType] ?? 0) + 1;
                if (warning.warningType === "stale_account_snapshot_input") summary.staleAccountSnapshotInputCount += 1;
                if (warning.warningType === "missing_balance_field") missingKeyBalanceFields = true;
            }
            if (missingKeyBalanceFields) summary.accountSnapshotsMissingKeyBalanceFields += 1;
        }
        return summary;
    }
}
