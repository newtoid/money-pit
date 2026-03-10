import { Opportunity } from "../arbScanner/types";
import { ExecutionRequest, ExecutionRequestSource } from "./types";

export function buildExecutionRequest(args: {
    executionAttemptId: string;
    source: ExecutionRequestSource;
    opportunity: Opportunity;
    requestedSize: number;
    createdAtMs: number;
}): ExecutionRequest {
    const { executionAttemptId, source, opportunity, requestedSize, createdAtMs } = args;
    return {
        executionAttemptId,
        correlationId: executionAttemptId,
        source,
        strategyId: "binary_full_set_arb_v1",
        marketId: opportunity.market.marketId,
        slug: opportunity.market.slug,
        createdAtMs,
        requestedSize,
        legs: [
            {
                legId: `${executionAttemptId}-yes`,
                tokenId: opportunity.market.yesTokenId,
                binarySide: "yes",
                side: "buy",
                limitPrice: opportunity.quote.yesAsk,
                size: requestedSize,
                timeInForce: "FOK",
            },
            {
                legId: `${executionAttemptId}-no`,
                tokenId: opportunity.market.noTokenId,
                binarySide: "no",
                side: "buy",
                limitPrice: opportunity.quote.noAsk,
                size: requestedSize,
                timeInForce: "FOK",
            },
        ],
        notes: [
            "scaffold_only_execution_boundary",
            "no_real_order_submission",
        ],
    };
}
