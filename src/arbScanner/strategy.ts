import { ArbScannerConfig } from "./config";
import { FeeModel } from "./feeModel";
import { ArbEvaluation, BinaryMarket, Opportunity, TopOfBook } from "./types";

export function assessBinaryFullSetArb(
    market: BinaryMarket,
    yes: TopOfBook | null,
    no: TopOfBook | null,
    config: ArbScannerConfig,
    feeModel: FeeModel,
    observedAt = Date.now(),
): ArbEvaluation {
    if (!yes || !no) {
        return { market, observedAt, reason: "missing_top_of_book", opportunity: null };
    }
    if (yes.ask === null || no.ask === null) {
        return { market, observedAt, reason: "missing_ask", opportunity: null };
    }

    const quoteAgeMs = Math.max(observedAt - yes.updatedAt, observedAt - no.updatedAt);
    if (quoteAgeMs > config.quoteStaleMs) {
        // Stale cross-leg quotes are one of the easiest ways to hallucinate arb.
        return { market, observedAt, reason: "stale_quote", opportunity: null };
    }

    const cost = feeModel.estimateCost(market);
    const totalAllIn = yes.ask + no.ask + cost.totalCostBuffer;
    const edge = 1 - totalAllIn;

    const opportunity: Opportunity = {
        market,
        quote: {
            yesAsk: yes.ask,
            noAsk: no.ask,
            yesAskSize: yes.askSize,
            noAskSize: no.askSize,
            quoteAgeMs,
        },
        cost,
        totalAllIn,
        edge,
        observedAt,
    };

    if (edge < config.minEdge) {
        return { market, observedAt, reason: "below_min_edge", opportunity };
    }

    return { market, observedAt, reason: "ok", opportunity };
}

export function evaluateBinaryFullSetArb(
    market: BinaryMarket,
    yes: TopOfBook | null,
    no: TopOfBook | null,
    config: ArbScannerConfig,
    feeModel: FeeModel,
    observedAt = Date.now(),
): Opportunity | null {
    const evaluation = assessBinaryFullSetArb(market, yes, no, config, feeModel, observedAt);
    return evaluation.reason === "ok" ? evaluation.opportunity : null;
}
