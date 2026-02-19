export type Level = { price: number; size: number };

export class OrderBookL2 {
    bids: Level[] = []; // sorted desc
    asks: Level[] = []; // sorted asc
    lastUpdateTs = Date.now();

    updateFromSnapshot(snapshot: any) {
        // market channel "book" message provides L2 price data :contentReference[oaicite:6]{index=6}
        this.bids = (snapshot?.bids ?? []).map((x: any) => ({ price: Number(x.price), size: Number(x.size) }))
            .sort((a: Level, b: Level) => b.price - a.price);
        this.asks = (snapshot?.asks ?? []).map((x: any) => ({ price: Number(x.price), size: Number(x.size) }))
            .sort((a: Level, b: Level) => a.price - b.price);
        this.lastUpdateTs = Date.now();
    }

    bestBid() { return this.bids[0]?.price ?? null; }
    bestAsk() { return this.asks[0]?.price ?? null; }
    mid() {
        const b = this.bestBid();
        const a = this.bestAsk();
        if (b == null || a == null) return null;
        return (b + a) / 2;
    }
}
