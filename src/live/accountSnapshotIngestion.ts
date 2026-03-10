import {
    AccountSnapshotNormalizationResult,
    AccountSnapshotNormalizationWarning,
    ExternalAccountSnapshot,
    ExternalAccountSnapshotIngestion,
    ExternalAssetBalanceIngestion,
    ExternalAssetBalanceSnapshot,
    ExternalReservedBalanceIngestion,
    ExternalReservedBalanceSnapshot,
} from "./types";

function parseNumberLike(value: number | string | null | undefined) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function parseStringLike(value: string | null | undefined) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeAsset(
    asset: ExternalAssetBalanceIngestion,
    index: number,
    warnings: AccountSnapshotNormalizationWarning[],
): ExternalAssetBalanceSnapshot | null {
    const assetSymbol = parseStringLike(asset.assetSymbol);
    if (!assetSymbol) {
        warnings.push({
            warningType: "missing_asset_symbol",
            scope: "asset",
            message: "asset entry missing assetSymbol and was skipped",
            details: { index },
        });
        return null;
    }

    const availableBalance = parseNumberLike(asset.availableBalance);
    const reservedBalance = parseNumberLike(asset.reservedBalance);
    const totalBalance = parseNumberLike(asset.totalBalance);

    if (asset.availableBalance !== undefined && asset.availableBalance !== null && availableBalance === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "asset",
            message: "invalid available balance normalized to null",
            details: { index, field: "availableBalance", assetSymbol },
        });
    }
    if (asset.reservedBalance !== undefined && asset.reservedBalance !== null && reservedBalance === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "asset",
            message: "invalid reserved balance normalized to null",
            details: { index, field: "reservedBalance", assetSymbol },
        });
    }
    if (asset.totalBalance !== undefined && asset.totalBalance !== null && totalBalance === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "asset",
            message: "invalid total balance normalized to null",
            details: { index, field: "totalBalance", assetSymbol },
        });
    }

    if (availableBalance === null || reservedBalance === null || totalBalance === null) {
        warnings.push({
            warningType: "missing_balance_field",
            scope: "asset",
            message: "asset balance entry is missing one or more comparable balance fields",
            details: {
                index,
                assetSymbol,
                hasAvailableBalance: availableBalance !== null,
                hasReservedBalance: reservedBalance !== null,
                hasTotalBalance: totalBalance !== null,
            },
        });
    }

    return {
        assetSymbol,
        availableBalance,
        reservedBalance,
        totalBalance,
        rawSourceMetadata: asset.rawSourceMetadata ?? null,
    };
}

function normalizeReservedBalance(
    reservedBalance: ExternalReservedBalanceIngestion,
    index: number,
    warnings: AccountSnapshotNormalizationWarning[],
): ExternalReservedBalanceSnapshot | null {
    const assetSymbol = parseStringLike(reservedBalance.assetSymbol);
    const reservationType = parseStringLike(reservedBalance.reservationType);
    if (!assetSymbol || !reservationType) {
        warnings.push({
            warningType: "missing_reserved_balance_key",
            scope: "reserved_balance",
            message: "reserved balance entry missing assetSymbol or reservationType and was skipped",
            details: {
                index,
                hasAssetSymbol: Boolean(assetSymbol),
                hasReservationType: Boolean(reservationType),
            },
        });
        return null;
    }
    const amount = parseNumberLike(reservedBalance.amount);
    if (reservedBalance.amount !== undefined && reservedBalance.amount !== null && amount === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "reserved_balance",
            message: "invalid reserved balance amount normalized to null",
            details: { index, assetSymbol, reservationType, field: "amount" },
        });
    }
    return {
        assetSymbol,
        reservationType,
        amount,
        rawSourceMetadata: reservedBalance.rawSourceMetadata ?? null,
    };
}

export function normalizeExternalAccountSnapshotIngestion(input: ExternalAccountSnapshotIngestion): AccountSnapshotNormalizationResult {
    const warnings: AccountSnapshotNormalizationWarning[] = [];
    const sourceLabel = parseStringLike(input.sourceLabel);
    if (!sourceLabel) {
        return {
            accepted: false,
            rejectReason: "missing_source_label",
            snapshot: null,
            warnings,
        };
    }

    const capturedAtMs = parseNumberLike(input.capturedAtMs);
    if (capturedAtMs === null) {
        return {
            accepted: false,
            rejectReason: "invalid_captured_at",
            snapshot: null,
            warnings,
        };
    }

    if (!input.assets && !input.reservedBalances) {
        return {
            accepted: false,
            rejectReason: "missing_account_snapshot_payload",
            snapshot: null,
            warnings,
        };
    }

    const ingestedAtMs = parseNumberLike(input.ingestedAtMs);
    const maxSnapshotAgeMs = parseNumberLike(input.maxSnapshotAgeMs);
    if (input.ingestedAtMs !== undefined && input.ingestedAtMs !== null && ingestedAtMs === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "snapshot",
            message: "invalid ingestedAtMs normalized to null",
            details: { field: "ingestedAtMs" },
        });
    }
    if (input.maxSnapshotAgeMs !== undefined && input.maxSnapshotAgeMs !== null && maxSnapshotAgeMs === null) {
        warnings.push({
            warningType: "invalid_numeric_field",
            scope: "snapshot",
            message: "invalid maxSnapshotAgeMs normalized to null",
            details: { field: "maxSnapshotAgeMs" },
        });
    }

    const assets = (input.assets ?? [])
        .map((asset, index) => normalizeAsset(asset, index, warnings))
        .filter((item): item is ExternalAssetBalanceSnapshot => item !== null);
    const reservedBalances = (input.reservedBalances ?? [])
        .map((item, index) => normalizeReservedBalance(item, index, warnings))
        .filter((entry): entry is ExternalReservedBalanceSnapshot => entry !== null);

    const snapshot: ExternalAccountSnapshot = {
        accountId: parseStringLike(input.accountId),
        provenance: input.provenance,
        sourceLabel,
        capturedAtMs,
        maxSnapshotAgeMs,
        trustworthy: input.trustworthy ?? false,
        assets,
        reservedBalances,
        rawSourceMetadata: input.rawSourceMetadata ?? null,
    };

    if (ingestedAtMs !== null && maxSnapshotAgeMs !== null && (ingestedAtMs - capturedAtMs) > maxSnapshotAgeMs) {
        warnings.push({
            warningType: "stale_account_snapshot_input",
            scope: "snapshot",
            message: "account snapshot was ingested already stale",
            details: {
                capturedAtMs,
                ingestedAtMs,
                maxSnapshotAgeMs,
            },
        });
    }

    return {
        accepted: true,
        rejectReason: null,
        snapshot,
        warnings,
    };
}
