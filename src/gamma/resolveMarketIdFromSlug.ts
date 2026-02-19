import { logger } from "../logger";

const GAMMA_BASE = "https://gamma-api.polymarket.com";

type GammaMarket = {
    id: string;
    slug: string;
    question: string;
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
): Promise<{ marketId: string; question: string; tokenIds: string[] }> {
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
            tokenIds: parseTokenIds(market.clobTokenIds),
        },
        "Resolved market id",
    );

    return {
        marketId: market.id,
        question: market.question,
        tokenIds: parseTokenIds(market.clobTokenIds),
    };
}

function current5mWindowStartUnix(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.floor(nowSec / 300) * 300;
}

function makeBtc5mSlug(windowStartUnix: number): string {
    return `btc-updown-5m-${windowStartUnix}`;
}

export async function resolveLatestBtc5mMarket(): Promise<{
    slug: string;
    marketId: string;
    question: string;
    tokenIds: string[];
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
