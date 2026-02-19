import { cfg } from "./config.js";

export function clamp01(x: number) {
    return Math.max(0.0001, Math.min(0.9999, x));
}

export function roundToTick(price: number, tick: number) {
    const n = Math.round(price / tick);
    return n * tick;
}

export function computeQuotes(fair: number, tick: number) {
    const bid = roundToTick(clamp01(fair - cfg.HALF_SPREAD), tick);
    const ask = roundToTick(clamp01(fair + cfg.HALF_SPREAD), tick);
    return { bid: Math.min(bid, ask - tick), ask: Math.max(ask, bid + tick) };
}
