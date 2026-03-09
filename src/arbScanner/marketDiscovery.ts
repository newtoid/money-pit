import { logger } from "../logger";
import { ArbScannerConfig } from "./config";
import { fetchGammaJson } from "./gammaClient";
import { BinaryMarket } from "./types";

type JsonObject = Record<string, unknown>;

function toObject(value: unknown): JsonObject | null {
    return value && typeof value === "object" ? value as JsonObject : null;
}

function toStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
        } catch {
            return [];
        }
    }
    return [];
}

function toOptionalNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
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

function normalizeOutcome(value: string): "yes" | "no" | null {
    const normalized = value.trim().toLowerCase();
    if (normalized === "yes") return "yes";
    if (normalized === "no") return "no";
    return null;
}

function parseTags(raw: unknown): { slugs: string[]; labels: string[] } {
    if (!Array.isArray(raw)) return { slugs: [], labels: [] };
    const slugs: string[] = [];
    const labels: string[] = [];
    for (const entry of raw) {
        const tag = toObject(entry);
        if (!tag) continue;
        if (typeof tag.slug === "string" && tag.slug.trim()) slugs.push(tag.slug.trim().toLowerCase());
        if (typeof tag.label === "string" && tag.label.trim()) labels.push(tag.label.trim().toLowerCase());
    }
    return { slugs, labels };
}

function firstEventSlug(raw: unknown): string | null {
    if (!Array.isArray(raw)) return null;
    for (const entry of raw) {
        const event = toObject(entry);
        if (!event) continue;
        if (typeof event.slug === "string" && event.slug.trim()) return event.slug.trim().toLowerCase();
    }
    return null;
}

function normalizeBinaryMarket(raw: unknown): BinaryMarket | null {
    const market = toObject(raw);
    if (!market) return null;

    const marketId = typeof market.id === "string" || typeof market.id === "number" ? String(market.id) : "";
    const slug = typeof market.slug === "string" ? market.slug.trim() : "";
    const question = typeof market.question === "string" ? market.question.trim() : "";
    if (!marketId || !slug || !question) return null;

    const outcomes = toStringArray(market.outcomes);
    const tokenIds = toStringArray(market.clobTokenIds);
    if (outcomes.length !== 2 || tokenIds.length < 2) return null;

    const normalizedOutcomes = outcomes.map(normalizeOutcome);
    let yesTokenId = "";
    let noTokenId = "";
    let tokenMappingSource: BinaryMarket["tokenMappingSource"] = "outcomes";

    const yesIndex = normalizedOutcomes.indexOf("yes");
    const noIndex = normalizedOutcomes.indexOf("no");
    if (yesIndex >= 0 && noIndex >= 0 && tokenIds[yesIndex] && tokenIds[noIndex]) {
        yesTokenId = tokenIds[yesIndex]!;
        noTokenId = tokenIds[noIndex]!;
    } else {
        // Gamma currently exposes `outcomes` and `clobTokenIds`, but if the mapping drifts
        // we fall back to index order rather than silently inventing a new interpretation.
        tokenMappingSource = "index_fallback";
        yesTokenId = tokenIds[0] ?? "";
        noTokenId = tokenIds[1] ?? "";
    }

    if (!yesTokenId || !noTokenId || yesTokenId === noTokenId) return null;

    const active = Boolean(market.active);
    const closed = Boolean(market.closed);
    const archived = Boolean(market.archived);
    const tags = parseTags(market.tags);

    return {
        marketId,
        conditionId: typeof market.conditionId === "string" ? market.conditionId : null,
        slug,
        question,
        eventSlug: firstEventSlug(market.events),
        tagSlugs: tags.slugs,
        tagLabels: tags.labels,
        yesTokenId,
        noTokenId,
        tokenMappingSource,
        active,
        closed,
        archived,
        endDate: typeof market.endDate === "string" ? market.endDate : null,
        liquidityNum: toOptionalNumber(market.liquidityNum ?? market.liquidity),
        volumeNum: toOptionalNumber(market.volumeNum ?? market.volume),
        feeRaw: market.fee !== undefined && market.fee !== null ? String(market.fee) : null,
        feesEnabled: toOptionalBoolean(market.feesEnabled),
    };
}

function matchesFilters(market: BinaryMarket, config: ArbScannerConfig): boolean {
    if (!market.active || market.closed || market.archived) return false;

    if (config.marketSlugFilter && !market.slug.toLowerCase().includes(config.marketSlugFilter)) return false;
    if (config.eventSlugFilter && !(market.eventSlug ?? "").includes(config.eventSlugFilter)) return false;
    if (config.tagFilter) {
        const haystack = new Set([...market.tagSlugs, ...market.tagLabels]);
        const matched = Array.from(haystack).some((value) => value.includes(config.tagFilter!));
        if (!matched) return false;
    }
    if (config.watchlistSlugs.size > 0 && !config.watchlistSlugs.has(market.slug.toLowerCase())) return false;
    return true;
}

export async function discoverBinaryMarkets(config: ArbScannerConfig): Promise<BinaryMarket[]> {
    const markets: BinaryMarket[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let page = 0;

    while (markets.length < config.maxMarkets) {
        page += 1;
        const payload = await fetchGammaJson(
            `/markets?active=true&closed=false&archived=false&limit=${config.gammaPageSize}&offset=${offset}`,
            config.gammaRequestTimeoutMs,
        );

        if (!Array.isArray(payload) || payload.length === 0) break;

        for (const raw of payload) {
            const market = normalizeBinaryMarket(raw);
            if (!market) continue;
            if (seen.has(market.marketId)) continue;
            seen.add(market.marketId);
            if (!matchesFilters(market, config)) continue;
            markets.push(market);
            if (markets.length >= config.maxMarkets) break;
        }

        offset += payload.length;
        if (payload.length < config.gammaPageSize) break;
    }

    logger.info(
        {
            requestedMaxMarkets: config.maxMarkets,
            discoveredMarkets: markets.length,
            pagesFetched: page,
        },
        "Discovered active binary markets for arbitrage scan",
    );

    const fallbackCount = markets.filter((market) => market.tokenMappingSource === "index_fallback").length;
    if (fallbackCount > 0) {
        logger.warn(
            { fallbackCount },
            "Some markets used fallback YES/NO token mapping because Gamma outcomes/token ordering was ambiguous",
        );
    }

    return markets;
}
