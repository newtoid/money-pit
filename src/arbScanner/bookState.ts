import { BookLevel, BookState, TopOfBook } from "./types";

type BookUpdate = {
    tokenId: string;
    top: TopOfBook;
};

function toNumber(value: unknown): number | null {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseLevels(raw: unknown): BookLevel[] {
    if (!Array.isArray(raw)) return [];
    const levels: BookLevel[] = [];
    for (const level of raw) {
        if (Array.isArray(level) && level.length >= 2) {
            const price = toNumber(level[0]);
            const size = toNumber(level[1]);
            if (price !== null) levels.push({ price, size });
            continue;
        }
        if (level && typeof level === "object") {
            const obj = level as Record<string, unknown>;
            const price = toNumber(obj.price);
            const size = toNumber(obj.size);
            if (price !== null) levels.push({ price, size });
        }
    }
    return levels;
}

function bestBid(levels: BookLevel[]): { price: number | null; size: number | null } {
    if (levels.length === 0) return { price: null, size: null };
    const best = levels.reduce((winner, level) => (level.price > winner.price ? level : winner));
    return { price: best.price, size: best.size };
}

function bestAsk(levels: BookLevel[]): { price: number | null; size: number | null } {
    if (levels.length === 0) return { price: null, size: null };
    const best = levels.reduce((winner, level) => (level.price < winner.price ? level : winner));
    return { price: best.price, size: best.size };
}

export class BookStateStore {
    private readonly books = new Map<string, BookState>();
    private readonly tokenIdSet: Set<string>;

    constructor(tokenIds: string[]) {
        this.tokenIdSet = new Set(tokenIds);
    }

    getTopOfBook(tokenId: string): TopOfBook | null {
        const book = this.books.get(tokenId);
        if (!book) return null;
        return {
            bid: book.bid,
            ask: book.ask,
            bidSize: book.bidSize,
            askSize: book.askSize,
            updatedAt: book.updatedAt,
        };
    }

    getBookState(tokenId: string): BookState | null {
        return this.books.get(tokenId) ?? null;
    }

    applyMarketMessage(message: unknown, updatedAt = Date.now()): BookUpdate[] {
        const updates: BookUpdate[] = [];
        const events = Array.isArray(message) ? message : [message];
        for (const event of events) {
            if (!event || typeof event !== "object") continue;
            const payload = event as Record<string, unknown>;

            const tokenId = String(payload.asset_id ?? payload.assetId ?? payload.token_id ?? payload.tokenId ?? "");
            const bidLevels = parseLevels(payload.bids ?? payload.buys);
            const askLevels = parseLevels(payload.asks ?? payload.sells);
            if (tokenId && this.tokenIdSet.has(tokenId) && (bidLevels.length > 0 || askLevels.length > 0)) {
                updates.push(this.setBookState(tokenId, bidLevels, askLevels, updatedAt));
                continue;
            }

            const changes = Array.isArray(payload.price_changes) ? payload.price_changes : [];
            for (const change of changes) {
                const item = change && typeof change === "object" ? change as Record<string, unknown> : null;
                if (!item) continue;
                const changeTokenId = String(item.asset_id ?? item.assetId ?? item.token_id ?? item.tokenId ?? "");
                if (!changeTokenId || !this.tokenIdSet.has(changeTokenId)) continue;
                const current = this.books.get(changeTokenId);
                updates.push(this.upsertTopOfBook(changeTokenId, {
                    bid: toNumber(item.best_bid) ?? current?.bid ?? null,
                    ask: toNumber(item.best_ask) ?? current?.ask ?? null,
                    bidSize: toNumber(item.best_bid_size) ?? current?.bidSize ?? null,
                    askSize: toNumber(item.best_ask_size) ?? current?.askSize ?? null,
                    updatedAt,
                }));
            }

            if (payload.event_type === "best_bid_ask") {
                const changeTokenId = String(payload.asset_id ?? payload.assetId ?? "");
                if (!changeTokenId || !this.tokenIdSet.has(changeTokenId)) continue;
                const current = this.books.get(changeTokenId);
                updates.push(this.upsertTopOfBook(changeTokenId, {
                    bid: toNumber(payload.best_bid) ?? current?.bid ?? null,
                    ask: toNumber(payload.best_ask) ?? current?.ask ?? null,
                    bidSize: toNumber(payload.best_bid_size) ?? current?.bidSize ?? null,
                    askSize: toNumber(payload.best_ask_size) ?? current?.askSize ?? null,
                    updatedAt,
                }));
            }
        }
        return updates;
    }

    private setBookState(tokenId: string, bids: BookLevel[], asks: BookLevel[], updatedAt: number): BookUpdate {
        const bestBidLevel = bestBid(bids);
        const bestAskLevel = bestAsk(asks);
        const state: BookState = {
            bid: bestBidLevel.price,
            ask: bestAskLevel.price,
            bidSize: bestBidLevel.size,
            askSize: bestAskLevel.size,
            bids: bids.slice().sort((a, b) => b.price - a.price),
            asks: asks.slice().sort((a, b) => a.price - b.price),
            updatedAt,
        };
        this.books.set(tokenId, state);
        return { tokenId, top: this.getTopOfBook(tokenId)! };
    }

    private upsertTopOfBook(tokenId: string, top: TopOfBook): BookUpdate {
        const current = this.books.get(tokenId);
        const next: BookState = {
            bid: top.bid,
            ask: top.ask,
            bidSize: top.bidSize,
            askSize: top.askSize,
            bids: current?.bids ?? [],
            asks: current?.asks ?? [],
            updatedAt: top.updatedAt,
        };
        this.books.set(tokenId, next);
        return { tokenId, top };
    }
}
