import { logger } from "../logger";
import { ArbScannerConfig } from "./config";
import { LiveBookTracker } from "./bookTracker";
import { FeeModel } from "./feeModel";
import { BinaryMarket, Opportunity } from "./types";
import { evaluateBinaryFullSetArb } from "./strategy";

type OpportunityScannerOpts = {
    onOpportunity?: (opportunity: Opportunity) => void;
};

export class OpportunityScanner {
    private readonly marketByTokenId = new Map<string, BinaryMarket>();
    private readonly lastOpportunityLogAt = new Map<string, number>();
    private readonly feeModel: FeeModel;

    constructor(
        private readonly markets: BinaryMarket[],
        private readonly tracker: LiveBookTracker,
        private readonly config: ArbScannerConfig,
        private readonly opts?: OpportunityScannerOpts,
    ) {
        for (const market of markets) {
            this.marketByTokenId.set(market.yesTokenId, market);
            this.marketByTokenId.set(market.noTokenId, market);
        }
        this.feeModel = new FeeModel(config);
    }

    onBookChange(tokenId: string) {
        const market = this.marketByTokenId.get(tokenId);
        if (!market) return;

        const opportunity = this.computeOpportunity(market);
        if (!opportunity) return;
        if (opportunity.edge < this.config.minEdge) return;

        const lastLoggedAt = this.lastOpportunityLogAt.get(market.marketId) ?? 0;
        if (this.config.opportunityLogMinMs > 0 && Date.now() - lastLoggedAt < this.config.opportunityLogMinMs) {
            this.opts?.onOpportunity?.(opportunity);
            return;
        }

        this.lastOpportunityLogAt.set(market.marketId, Date.now());
        this.opts?.onOpportunity?.(opportunity);
        logger.info(
            {
                marketId: market.marketId,
                slug: market.slug,
                question: market.question,
                eventSlug: market.eventSlug,
                yesTokenId: market.yesTokenId,
                noTokenId: market.noTokenId,
                yesAsk: opportunity.quote.yesAsk,
                noAsk: opportunity.quote.noAsk,
                yesAskSize: opportunity.quote.yesAskSize,
                noAskSize: opportunity.quote.noAskSize,
                quoteAgeMs: opportunity.quote.quoteAgeMs,
                totalAllIn: Number(opportunity.totalAllIn.toFixed(6)),
                edge: Number(opportunity.edge.toFixed(6)),
                costBuffer: Number(opportunity.cost.totalCostBuffer.toFixed(6)),
                costNotes: opportunity.cost.notes,
                tokenMappingSource: market.tokenMappingSource,
            },
            "Binary arbitrage opportunity",
        );
    }

    private computeOpportunity(market: BinaryMarket): Opportunity | null {
        return evaluateBinaryFullSetArb(
            market,
            this.tracker.getTopOfBook(market.yesTokenId),
            this.tracker.getTopOfBook(market.noTokenId),
            this.config,
            this.feeModel,
        );
    }
}
