import { logger } from "../logger";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

type GammaMarket = {
    id: string;
    slug: string;
    question: string;
    startDate?: string;
    endDate?: string;
    clobTokenIds?: string[] | string;
};

function parseTokenIds(raw: GammaMarket["clobTokenIds"]): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
        } catch {
            return [];
        }
    }
    return [];
}

export async function resolveMarketIdFromSlug(
    slug: string,
): Promise<{ marketId: string; question: string; tokenIds: string[]; startUnixSec: number | null; endUnixSec: number | null }> {
    const url = `${GAMMA_BASE}/markets?slug=${encodeURIComponent(slug)}`;

    logger.info({ slug }, "Resolving market id from slug");

    const res = await fetch(url);

    if (!res.ok) {
        throw new Error(`Gamma request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as GammaMarket[];

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No market found for slug: ${slug}`);
    }

    const market = data[0];

    if (!market.id) {
        throw new Error(`Market returned without id for slug: ${slug}`);
    }

    logger.info(
        {
            slug,
            marketId: market.id,
            question: market.question,
            startDate: market.startDate ?? null,
            endDate: market.endDate ?? null,
            tokenIds: parseTokenIds(market.clobTokenIds),
        },
        "Resolved market id",
    );

    const startMs = market.startDate ? new Date(market.startDate).getTime() : NaN;
    const endMs = market.endDate ? new Date(market.endDate).getTime() : NaN;
    const startUnixSec = Number.isFinite(startMs) ? Math.floor(startMs / 1000) : null;
    const endUnixSec = Number.isFinite(endMs) ? Math.floor(endMs / 1000) : null;

    return {
        marketId: market.id,
        question: market.question,
        tokenIds: parseTokenIds(market.clobTokenIds),
        startUnixSec,
        endUnixSec,
    };
}

function current5mWindowStartUnix(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.floor(nowSec / 300) * 300;
}

function makeBtc5mSlug(windowStartUnix: number): string {
    return `btc-updown-5m-${windowStartUnix}`;
}

export type UpDownAsset = "btc" | "eth" | "sol" | "xrp";

function makeHourlyUpDownSlug(asset: UpDownAsset, atUnixMs: number): string {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "long",
        day: "numeric",
        hour: "numeric",
        hour12: true,
    }).formatToParts(new Date(atUnixMs));
    const month = (parts.find((p) => p.type === "month")?.value ?? "").toLowerCase();
    const day = (parts.find((p) => p.type === "day")?.value ?? "").toLowerCase();
    const hour = (parts.find((p) => p.type === "hour")?.value ?? "").toLowerCase();
    const dayPeriod = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toLowerCase();
    const assetWord = asset === "eth"
        ? "ethereum"
        : asset === "sol"
            ? "solana"
            : asset === "xrp"
                ? "xrp"
                : "bitcoin";
    return `${assetWord}-up-or-down-${month}-${day}-${hour}${dayPeriod}-et`;
}

export async function resolveLatestBtc5mMarket(): Promise<{
    slug: string;
    marketId: string;
    question: string;
    tokenIds: string[];
    startUnixSec: number | null;
    endUnixSec: number | null;
}> {
    const base = current5mWindowStartUnix();
    const candidates = [base, base - 300, base + 300, base - 600, base + 600];

    for (const t of candidates) {
        const slug = makeBtc5mSlug(t);
        try {
            const resolved = await resolveMarketIdFromSlug(slug);
            if (resolved.tokenIds.length >= 2) {
                return { slug, ...resolved };
            }
        } catch {
            // Try next candidate.
        }
    }

    throw new Error("Unable to resolve a live BTC 5m market from nearby windows");
}

export async function resolveLatestUpDownHourlyMarket(asset: UpDownAsset): Promise<{
    slug: string;
    marketId: string;
    question: string;
    tokenIds: string[];
    startUnixSec: number | null;
    endUnixSec: number | null;
}> {
    const now = Date.now();
    const baseHourMs = Math.floor(now / 3_600_000) * 3_600_000;
    const hourOffsets = [0, -1, 1, -2, 2, -3, 3, -4, 4, -6, 6, -8, 8];
    const tried = new Set<string>();
    for (const off of hourOffsets) {
        const slug = makeHourlyUpDownSlug(asset, baseHourMs + (off * 3_600_000));
        if (tried.has(slug)) continue;
        tried.add(slug);
        try {
            const resolved = await resolveMarketIdFromSlug(slug);
            if (resolved.tokenIds.length < 2) continue;
            if (resolved.endUnixSec !== null && resolved.endUnixSec < Math.floor(Date.now() / 1000) - 60) continue;
            return { slug, ...resolved };
        } catch {
            // Try next candidate.
        }
    }
    throw new Error(`Unable to resolve a live ${asset.toUpperCase()} hourly Up/Down market from nearby windows`);
}
