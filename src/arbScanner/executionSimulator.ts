import { ArbScannerConfig } from "./config";
import { ExecutionSimConfig, Opportunity, SimulatedFill } from "./types";

function roundSize(size: number) {
    return Math.floor(size * 100) / 100;
}

function clampPrice(price: number) {
    return Math.max(0.001, Math.min(0.999, price));
}

export function buildExecutionSimConfig(config: ArbScannerConfig): ExecutionSimConfig {
    return {
        requestedSize: config.tradeSize,
        slippagePerLeg: config.simSlippagePerLeg,
        partialFillRatio: config.simPartialFillRatio,
        requireFullFill: config.simRequireFullFill,
        requireKnownSize: config.simRequireKnownSize,
    };
}

export class ExecutionSimulator {
    constructor(private readonly config: ExecutionSimConfig) {}

    simulateEntry(opportunity: Opportunity, ts = Date.now()): SimulatedFill {
        const yesAvailable = opportunity.quote.yesAskSize;
        const noAvailable = opportunity.quote.noAskSize;
        if (this.config.requireKnownSize && (yesAvailable === null || noAvailable === null)) {
            return this.reject(opportunity, ts, "unknown_leg_size");
        }

        const cappedByBook = Math.min(
            this.config.requestedSize,
            yesAvailable ?? this.config.requestedSize,
            noAvailable ?? this.config.requestedSize,
        );
        const filledSize = roundSize(cappedByBook * this.config.partialFillRatio);
        if (filledSize <= 0) {
            return this.reject(opportunity, ts, "insufficient_size");
        }
        if (this.config.requireFullFill && filledSize < this.config.requestedSize) {
            return this.reject(opportunity, ts, "partial_fill_not_allowed");
        }

        const yesPrice = clampPrice(opportunity.quote.yesAsk + this.config.slippagePerLeg);
        const noPrice = clampPrice(opportunity.quote.noAsk + this.config.slippagePerLeg);
        const totalAllInPerUnit = yesPrice + noPrice + opportunity.cost.totalCostBuffer;
        const edgeAfter = 1 - totalAllInPerUnit;
        const realizedPnl = filledSize * edgeAfter;
        const fullSizePnlEquivalent = this.config.requestedSize * edgeAfter;
        const pnlLostToPartial = fullSizePnlEquivalent - realizedPnl;

        return {
            ts,
            marketId: opportunity.market.marketId,
            slug: opportunity.market.slug,
            status: filledSize < this.config.requestedSize ? "partial" : "filled",
            requestedSize: this.config.requestedSize,
            filledSize,
            yesPrice,
            noPrice,
            totalAllInPerUnit,
            edgeBefore: opportunity.edge,
            edgeAfter,
            realizedPnl,
            fullSizePnlEquivalent,
            pnlLostToPartial,
            quoteAgeMs: opportunity.quote.quoteAgeMs,
            reason: filledSize < this.config.requestedSize ? "partial_fill_assumption" : "filled",
        };
    }

    private reject(opportunity: Opportunity, ts: number, reason: string): SimulatedFill {
        return {
            ts,
            marketId: opportunity.market.marketId,
            slug: opportunity.market.slug,
            status: "rejected",
            requestedSize: this.config.requestedSize,
            filledSize: 0,
            yesPrice: null,
            noPrice: null,
            totalAllInPerUnit: null,
            edgeBefore: opportunity.edge,
            edgeAfter: null,
            realizedPnl: 0,
            fullSizePnlEquivalent: null,
            pnlLostToPartial: null,
            quoteAgeMs: opportunity.quote.quoteAgeMs,
            reason,
        };
    }
}
