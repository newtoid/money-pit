import { cfg } from "./config.js";
import { log } from "./log.js";

export type GammaMarket = Record<string, any>;

function parseClobTokenIds(v: any): string[] {
    if (!v) return [];
    if (Array.isArray(v)) return v.map(String).filter(Boolean);

    if (typeof v === "string") {
        const s = v.trim();
        // Gamma often returns clobTokenIds as a JSON string like ["id1","id2"] :contentReference[oaicite:2]{index=2}
        if (s.startsWith("[") && s.includes("]")) {
            const end = s.indexOf("]") + 1;
            const maybeJson = s.slice(0, end);
            try {
                const parsed = JSON.parse(maybeJson);
                if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
            } catch {
                // fall through
            }
        }
    }
    return [];
}

export function current5mWindowStartUnix(): number {
    const nowSec = Math.floor(Date.now() / 1000);
    return Math.floor(nowSec / 300) * 300; // 5 min = 300s
}

export function makeBtc5mSlug(windowStartUnix: number): string {
    return `btc-updown-5m-${windowStartUnix}`;
}

export async function getMarketBySlug(slug: string): Promise<GammaMarket> {
    // Gamma: Get market by slug :contentReference[oaicite:3]{index=3}
    const url = `${cfg.GAMMA_HOST}/markets/slug/${encodeURIComponent(slug)}`;
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Gamma get market by slug failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as GammaMarket;
}

export async function findLatest5mBtcMarket(): Promise<{ market: any; tokenIds: string[] } | null> {
    // Try current window, then a couple back/forward to handle timing races.
    const base = current5mWindowStartUnix();
    const candidates = [base, base - 300, base + 300, base - 600, base + 600];

    for (const t of candidates) {
        const slug = makeBtc5mSlug(t);
        try {
            const market = await getMarketBySlug(slug);
            const tokenIds = parseClobTokenIds(market?.clobTokenIds);

            log.info(
                {
                    slug,
                    endDate: market?.endDate ?? market?.endDateIso,
                    clobTokenIdsType: typeof market?.clobTokenIds,
                    tokenIdsCount: tokenIds.length,
                    tokenIdsPreview: tokenIds.slice(0, 4)
                },
                "Fetched BTC 5m market by slug"
            );

            if (tokenIds.length >= 2) return { market, tokenIds };
        } catch (e) {
            log.warn({ slug, err: String(e) }, "Slug not found / not ready yet");
        }
    }

    return null;
}
