import { cfg } from "./config.js";
import { log } from "./log.js";

type Side = "BUY" | "SELL";

export type DesiredOrder = {
    tokenId: string;
    side: Side;
    price: number;
    size: number;
};

export async function cancelAllIfNeeded(client: any, tokenId: string) {
    if (cfg.DRY_RUN) return;
    // client has L2 methods to manage orders :contentReference[oaicite:10]{index=10}
    try {
        await client.cancelAllOrders({ tokenId });
        log.warn({ tokenId }, "Canceled all orders");
    } catch (e) {
        log.error({ err: String(e), tokenId }, "cancelAllOrders failed");
    }
}

export async function upsertTwoSidedQuotes(params: {
    client: any;
    tokenId: string;
    bid: { price: number; size: number };
    ask: { price: number; size: number };
    tick: number;
    state: BotState;
}) {
    const { client, tokenId, bid, ask, state } = params;

    if (cfg.KILL_SWITCH) {
        log.fatal("KILL_SWITCH enabled; skipping execution");
        return;
    }

    // crude inventory cap
    const pos = state.positions.get(tokenId) ?? 0;
    if (Math.abs(pos) >= cfg.MAX_POSITION) {
        log.warn({ tokenId, pos }, "Max position reached; not quoting");
        return;
    }

    const desired: DesiredOrder[] = [
        { tokenId, side: "BUY",  price: bid.price, size: bid.size },
        { tokenId, side: "SELL", price: ask.price, size: ask.size },
    ];

    // If DRY_RUN, just log what we'd do.
    if (cfg.DRY_RUN) {
        log.info({ tokenId, desired }, "DRY_RUN quotes");
        return;
    }

    // Simple approach: cancel existing and recreate (safe MVP, not optimal)
    // You can later optimize to cancel/replace only when stale.
    await cancelAllIfNeeded(client, tokenId);

    for (const o of desired) {
        try {
            await client.createOrder({
                tokenId: o.tokenId,
                side: o.side,
                price: o.price,
                size: o.size,
            });
            log.info({ o }, "Order placed");
        } catch (e) {
            log.error({ err: String(e), o }, "createOrder failed");
        }
    }
}

export type BotState = {
    positions: Map<string, number>;
    endTimeMs: number | null;
};
