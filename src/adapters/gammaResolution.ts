import { BinaryMarket, RecordedResolutionEvent } from "../arbScanner/types";
import { fetchGammaJson } from "../arbScanner/gammaClient";

type JsonObject = Record<string, unknown>;

function toObject(value: unknown): JsonObject | null {
    return value && typeof value === "object" ? value as JsonObject : null;
}

function toOptionalBoolean(value: unknown): boolean | null {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes"].includes(normalized)) return true;
        if (["false", "0", "no"].includes(normalized)) return false;
    }
    return null;
}

function toOptionalString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseTimestampMs(value: unknown): number | null {
    const raw = toOptionalString(value);
    if (!raw) return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchGammaMarketById(marketId: string, timeoutMs: number): Promise<unknown> {
    return fetchGammaJson(`/markets/${encodeURIComponent(marketId)}`, timeoutMs);
}

export function normalizeGammaResolutionEvent(
    raw: unknown,
    market: BinaryMarket,
    polledAtMs: number,
): RecordedResolutionEvent | null {
    const payload = toObject(raw);
    if (!payload) return null;

    const payloadMarketId = payload.id !== undefined && payload.id !== null ? String(payload.id) : null;
    if (!payloadMarketId || payloadMarketId !== market.marketId) return null;

    const closed = toOptionalBoolean(payload.closed);
    if (closed !== true) return null;

    const closedTimeRaw = toOptionalString(payload.closedTime);
    const closedTimeMs = parseTimestampMs(payload.closedTime);
    const trustworthy = closedTimeMs !== null;

    return {
        marketId: market.marketId,
        resolvedAtMs: closedTimeMs ?? polledAtMs,
        settlementStatus: "resolved",
        settlementMode: "explicit_recorded_resolution_event",
        payoutPerUnit: 1,
        provenance: "recorded_external_resolution_source",
        sourceLabel: "gamma_market_poll",
        trustworthy,
        rawSourceMetadata: {
            gammaMarketId: payloadMarketId,
            closed,
            closedTime: closedTimeRaw,
            resolvedAtMsDerivedFrom: trustworthy ? "gamma_closed_time" : "poll_time_fallback",
            resolutionSource: toOptionalString(payload.resolutionSource),
            umaResolutionStatus: toOptionalString(payload.umaResolutionStatus),
            outcomePrices: toOptionalString(payload.outcomePrices),
            outcomes: toOptionalString(payload.outcomes),
            endDate: toOptionalString(payload.endDate),
        },
    };
}
