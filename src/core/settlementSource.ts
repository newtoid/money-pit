import { BinaryMarket, RecordedResolutionEvent } from "../arbScanner/types";

export type SettlementStatus = {
    isResolved: boolean;
    resolvedAtMs: number | null;
    settlementMode: "placeholder_end_time_full_set_assumption" | "explicit_recorded_resolution_event";
    payoutPerUnit: number | null;
    provenance: string;
    trustworthy: boolean;
};

export type SettlementSourceMode =
    | "placeholder_end_time_full_set_assumption"
    | "prefer_explicit_recorded_resolution_event";

type SettlementSourceOpts = {
    mode: SettlementSourceMode;
    allowPlaceholderFallback: boolean;
};

function parseMarketEndTimeMs(market: BinaryMarket): number | null {
    if (!market.endDate) return null;
    const value = Date.parse(market.endDate);
    return Number.isFinite(value) ? value : null;
}

export function getSettlementStatus(args: {
    market: BinaryMarket;
    now: number;
    recordedResolution: RecordedResolutionEvent | null;
    config: { settlementAllowPlaceholderFallback: boolean };
}): SettlementStatus {
    const { market, now, recordedResolution, config } = args;

    if (recordedResolution) {
        return {
            isResolved: now >= recordedResolution.resolvedAtMs,
            resolvedAtMs: recordedResolution.resolvedAtMs,
            settlementMode: "explicit_recorded_resolution_event",
            payoutPerUnit: now >= recordedResolution.resolvedAtMs ? recordedResolution.payoutPerUnit : null,
            provenance: recordedResolution.provenance,
            trustworthy: recordedResolution.trustworthy,
        };
    }

    const marketEndTimeMs = parseMarketEndTimeMs(market);
    if (config.settlementAllowPlaceholderFallback && marketEndTimeMs !== null) {
        return {
            isResolved: now >= marketEndTimeMs,
            resolvedAtMs: marketEndTimeMs,
            settlementMode: "placeholder_end_time_full_set_assumption",
            payoutPerUnit: now >= marketEndTimeMs ? 1 : null,
            provenance: "placeholder_end_time_assumption",
            trustworthy: false,
        };
    }

    return {
        isResolved: false,
        resolvedAtMs: null,
        settlementMode: "placeholder_end_time_full_set_assumption",
        payoutPerUnit: null,
        provenance: "placeholder_end_time_assumption",
        trustworthy: false,
    };
}

export class SettlementSource {
    private readonly recordedResolutions = new Map<string, RecordedResolutionEvent>();

    constructor(private readonly opts: SettlementSourceOpts) {}

    recordResolution(resolution: RecordedResolutionEvent) {
        this.recordedResolutions.set(resolution.marketId, resolution);
    }

    getRecordedResolution(marketId: string): RecordedResolutionEvent | null {
        return this.recordedResolutions.get(marketId) ?? null;
    }

    getSettlementStatus(args: { market: BinaryMarket; now: number }): SettlementStatus {
        const recordedResolution = this.opts.mode === "prefer_explicit_recorded_resolution_event"
            ? this.getRecordedResolution(args.market.marketId)
            : null;
        return getSettlementStatus({
            market: args.market,
            now: args.now,
            recordedResolution,
            config: { settlementAllowPlaceholderFallback: this.opts.allowPlaceholderFallback },
        });
    }

    describeSelectionMode(): string {
        if (this.opts.mode === "prefer_explicit_recorded_resolution_event") {
            return this.opts.allowPlaceholderFallback
                ? "prefer_explicit_recorded_resolution_event_with_placeholder_fallback"
                : "prefer_explicit_recorded_resolution_event_without_placeholder_fallback";
        }
        return this.opts.allowPlaceholderFallback
            ? "placeholder_end_time_full_set_assumption"
            : "no_settlement_path_configured";
    }
}
