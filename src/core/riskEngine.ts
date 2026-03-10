import { ArbScannerConfig } from "../arbScanner/config";
import { Opportunity } from "../arbScanner/types";
import { PortfolioSnapshot } from "./portfolio";

export type TradeRiskReasonCode =
    | "kill_switch_enabled"
    | "daily_loss_limit_reached"
    | "trade_notional_above_limit"
    | "concurrent_exposure_above_limit"
    | "per_market_exposure_above_limit"
    | "stale_market_state"
    | "missing_required_liquidity"
    | "near_market_resolution";

export type TradeRiskMarketState = {
    quoteAgeMs: number | null;
    yesAskSize: number | null;
    noAskSize: number | null;
    marketEndTimeMs: number | null;
};

export type TradeRiskInput = {
    opportunity: Opportunity;
    marketState: TradeRiskMarketState;
    portfolioState: PortfolioSnapshot;
    config: ArbScannerConfig;
    now: number;
};

export type TradeRiskDecision = {
    allow: boolean;
    reasonCodes: TradeRiskReasonCode[];
    details: {
        requestedSize: number;
        proposedTradeNotional: number;
        grossOpenNotional: number;
        dailyRealizedPnl: number;
        dayBucketStartMs: number;
        dayUtcOffsetMinutes: number;
        maxDailyLoss: number;
        resultingGrossOpenNotional: number;
        currentMarketOpenNotional: number;
        resultingMarketOpenNotional: number;
        maxNotionalPerTrade: number;
        maxConcurrentExposure: number;
        perMarketExposureCap: number;
        quoteAgeMs: number | null;
        quoteStaleMs: number;
        yesAskSize: number | null;
        noAskSize: number | null;
        minRequiredLiquidity: number;
        marketEndTimeMs: number | null;
        noTradeBeforeResolutionSec: number;
        secondsToResolution: number | null;
        exposureMode: "gross_notional_locked_capital";
        liquidityMode: "top_of_book_ask_size_only";
    };
};

function secondsToResolution(now: number, marketEndTimeMs: number | null): number | null {
    if (marketEndTimeMs === null || !Number.isFinite(marketEndTimeMs)) return null;
    return Math.floor((marketEndTimeMs - now) / 1000);
}

export function evaluateTradeRisk(input: TradeRiskInput): TradeRiskDecision {
    const { opportunity, marketState, portfolioState, config, now } = input;
    const requestedSize = config.tradeSize;
    const proposedTradeNotional = opportunity.totalAllIn * requestedSize;
    const grossOpenNotional = portfolioState.grossOpenNotional;
    const currentMarketOpenNotional = portfolioState.positions
        .filter((position) => position.marketId === opportunity.market.marketId)
        .reduce((sum, position) => sum + position.lockedNotional, 0);
    const resultingGrossOpenNotional = grossOpenNotional + proposedTradeNotional;
    const resultingMarketOpenNotional = currentMarketOpenNotional + proposedTradeNotional;
    const resolutionSeconds = secondsToResolution(now, marketState.marketEndTimeMs);

    const reasonCodes: TradeRiskReasonCode[] = [];

    if (config.killSwitchEnabled) {
        reasonCodes.push("kill_switch_enabled");
    }
    if (config.riskMaxDailyLoss > 0 && portfolioState.dailyRealizedPnl <= -config.riskMaxDailyLoss) {
        reasonCodes.push("daily_loss_limit_reached");
    }
    if (proposedTradeNotional > config.riskMaxNotionalPerTrade) {
        reasonCodes.push("trade_notional_above_limit");
    }
    if (resultingGrossOpenNotional > config.riskMaxConcurrentExposure) {
        reasonCodes.push("concurrent_exposure_above_limit");
    }
    if (resultingMarketOpenNotional > config.riskPerMarketExposureCap) {
        reasonCodes.push("per_market_exposure_above_limit");
    }
    if (marketState.quoteAgeMs === null || marketState.quoteAgeMs > config.quoteStaleMs) {
        reasonCodes.push("stale_market_state");
    }
    if (
        marketState.yesAskSize === null
        || marketState.noAskSize === null
        || marketState.yesAskSize < requestedSize
        || marketState.noAskSize < requestedSize
    ) {
        reasonCodes.push("missing_required_liquidity");
    }
    if (
        resolutionSeconds !== null
        && resolutionSeconds <= config.riskNoTradeBeforeResolutionSec
    ) {
        reasonCodes.push("near_market_resolution");
    }

    return {
        allow: reasonCodes.length === 0,
        reasonCodes,
        details: {
            requestedSize,
            proposedTradeNotional: Number(proposedTradeNotional.toFixed(6)),
            grossOpenNotional: Number(grossOpenNotional.toFixed(6)),
            dailyRealizedPnl: Number(portfolioState.dailyRealizedPnl.toFixed(6)),
            dayBucketStartMs: portfolioState.dayBucketStartMs,
            dayUtcOffsetMinutes: portfolioState.dayUtcOffsetMinutes,
            maxDailyLoss: config.riskMaxDailyLoss,
            resultingGrossOpenNotional: Number(resultingGrossOpenNotional.toFixed(6)),
            currentMarketOpenNotional: Number(currentMarketOpenNotional.toFixed(6)),
            resultingMarketOpenNotional: Number(resultingMarketOpenNotional.toFixed(6)),
            maxNotionalPerTrade: config.riskMaxNotionalPerTrade,
            maxConcurrentExposure: config.riskMaxConcurrentExposure,
            perMarketExposureCap: config.riskPerMarketExposureCap,
            quoteAgeMs: marketState.quoteAgeMs,
            quoteStaleMs: config.quoteStaleMs,
            yesAskSize: marketState.yesAskSize,
            noAskSize: marketState.noAskSize,
            minRequiredLiquidity: requestedSize,
            marketEndTimeMs: marketState.marketEndTimeMs,
            noTradeBeforeResolutionSec: config.riskNoTradeBeforeResolutionSec,
            secondsToResolution: resolutionSeconds,
            exposureMode: "gross_notional_locked_capital",
            liquidityMode: "top_of_book_ask_size_only",
        },
    };
}
