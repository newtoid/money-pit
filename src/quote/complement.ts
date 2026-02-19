export type Quote = { bid: number; ask: number };

export type ComplementPricing = {
    yesMid: number;
    noMid: number;
    sumMids: number;
    blendedFair: number;
    yesQuote: Quote;
    noQuote: Quote;
};

function mid(q: Quote): number {
    return (q.bid + q.ask) / 2;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function computeComplementPricing(yesQuote: Quote, noQuote: Quote): ComplementPricing {
    const yesMid = mid(yesQuote);
    const noMid = mid(noQuote);
    const sumMids = yesMid + noMid;

    // Your logs treat “blendedFair” as the YES mid.
    // Keep it simple and deterministic: use YES mid as fair (or adjust later).
    const blendedFair = yesMid;

    return {
        yesMid,
        noMid,
        sumMids,
        blendedFair,
        yesQuote: { bid: round2(yesQuote.bid), ask: round2(yesQuote.ask) },
        noQuote: { bid: round2(noQuote.bid), ask: round2(noQuote.ask) },
    };
}
