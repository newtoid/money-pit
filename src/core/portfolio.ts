import { Opportunity, SimulatedFill, SimulatedPosition } from "../arbScanner/types";

export type PortfolioSnapshot = {
    realizedPnl: number;
    grossOpenNotional: number;
    perMarketExposure: Record<string, number>;
    releasedExposure: number;
    unrealizedPnlMarkedToMarket: null;
    positions: SimulatedPosition[];
};

export type PositionOpenResult =
    | { opened: true; position: SimulatedPosition }
    | { opened: false; reason: string };

export type PositionResolveResult = {
    resolved: true;
    position: SimulatedPosition;
    releasedExposure: number;
    realizedPnlDelta: number;
};

export class SimulatedPortfolio {
    private readonly positions = new Map<string, SimulatedPosition>();
    private nextId = 1;
    private realizedPnl = 0;
    private releasedExposure = 0;

    openFromFill(opportunity: Opportunity, fill: SimulatedFill): PositionOpenResult {
        if (fill.status === "rejected" || fill.filledSize <= 0 || fill.totalAllInPerUnit === null) {
            return { opened: false, reason: "fill_not_openable" };
        }

        const position: SimulatedPosition = {
            id: `pos-${this.nextId++}`,
            state: "open",
            marketId: opportunity.market.marketId,
            slug: opportunity.market.slug,
            yesTokenId: opportunity.market.yesTokenId,
            noTokenId: opportunity.market.noTokenId,
            size: fill.filledSize,
            entryYesPrice: fill.yesPrice ?? 0,
            entryNoPrice: fill.noPrice ?? 0,
            entryTotalAllInPerUnit: fill.totalAllInPerUnit,
            lockedNotional: fill.totalAllInPerUnit * fill.filledSize,
            openedAt: fill.ts,
            marketEndTimeMs: opportunity.market.endDate ? Date.parse(opportunity.market.endDate) : null,
            resolvedAt: null,
            settlementPayoutPerUnit: null,
            settlementGrossPayout: null,
            realizedPnl: null,
            resolutionSource: opportunity.market.endDate
                ? "market_end_full_set_assumption"
                : "unresolved_missing_end_time",
        };

        this.positions.set(position.id, position);
        return { opened: true, position };
    }

    resolveMaturedPositions(now: number): PositionResolveResult[] {
        const resolved: PositionResolveResult[] = [];
        for (const position of this.positions.values()) {
            if (position.state !== "open") continue;
            if (position.marketEndTimeMs === null || !Number.isFinite(position.marketEndTimeMs)) continue;
            if (now < position.marketEndTimeMs) continue;

            // Placeholder settlement rule for full-set arb:
            // one complete binary YES+NO set settles to 1.0 total payout.
            const settlementPayoutPerUnit = 1;
            const settlementGrossPayout = settlementPayoutPerUnit * position.size;
            const realizedPnl = settlementGrossPayout - position.lockedNotional;
            const next: SimulatedPosition = {
                ...position,
                state: "resolved",
                resolvedAt: now,
                settlementPayoutPerUnit,
                settlementGrossPayout,
                realizedPnl,
                resolutionSource: "market_end_full_set_assumption",
            };
            this.positions.set(next.id, next);
            this.realizedPnl += realizedPnl;
            this.releasedExposure += position.lockedNotional;
            resolved.push({
                resolved: true,
                position: next,
                releasedExposure: position.lockedNotional,
                realizedPnlDelta: realizedPnl,
            });
        }
        return resolved;
    }

    getSnapshot(): PortfolioSnapshot {
        const positions = Array.from(this.positions.values());
        const openPositions = positions.filter((position) => position.state === "open");
        const grossOpenNotional = openPositions.reduce((sum, position) => sum + position.lockedNotional, 0);
        const perMarketExposure = openPositions.reduce<Record<string, number>>((acc, position) => {
            acc[position.marketId] = (acc[position.marketId] ?? 0) + position.lockedNotional;
            return acc;
        }, {});

        return {
            realizedPnl: this.realizedPnl,
            grossOpenNotional,
            perMarketExposure,
            releasedExposure: this.releasedExposure,
            unrealizedPnlMarkedToMarket: null,
            positions: positions.map((position) => ({ ...position })),
        };
    }
}
