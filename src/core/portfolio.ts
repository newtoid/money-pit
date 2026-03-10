import { Opportunity, SimulatedFill, SimulatedPosition } from "../arbScanner/types";
import { SettlementStatus } from "./settlementSource";
import { dayBucketStartMs } from "../util/time";

export type PortfolioSnapshot = {
    realizedPnl: number;
    dailyRealizedPnl: number;
    dayBucketStartMs: number;
    dayUtcOffsetMinutes: number;
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

    openFromFill(opportunity: Opportunity, fill: SimulatedFill, settlementStatus: SettlementStatus): PositionOpenResult {
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
            settlementMode: settlementStatus.settlementMode,
            settlementProvenance: settlementStatus.provenance,
            settlementTrustworthy: settlementStatus.trustworthy,
        };

        this.positions.set(position.id, position);
        return { opened: true, position };
    }

    resolvePositions(now: number, getSettlementStatusForPosition: (position: SimulatedPosition) => SettlementStatus): PositionResolveResult[] {
        const resolved: PositionResolveResult[] = [];
        for (const position of this.positions.values()) {
            if (position.state !== "open") continue;
            const settlementStatus = getSettlementStatusForPosition(position);
            if (!settlementStatus.isResolved || settlementStatus.payoutPerUnit === null) continue;

            const settlementPayoutPerUnit = settlementStatus.payoutPerUnit;
            const settlementGrossPayout = settlementPayoutPerUnit * position.size;
            const realizedPnl = settlementGrossPayout - position.lockedNotional;
            const next: SimulatedPosition = {
                ...position,
                state: "resolved",
                resolvedAt: settlementStatus.resolvedAtMs ?? now,
                settlementPayoutPerUnit,
                settlementGrossPayout,
                realizedPnl,
                settlementMode: settlementStatus.settlementMode,
                settlementProvenance: settlementStatus.provenance,
                settlementTrustworthy: settlementStatus.trustworthy,
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

    getSnapshot(now: number, dayUtcOffsetMinutes: number): PortfolioSnapshot {
        const positions = Array.from(this.positions.values());
        const openPositions = positions.filter((position) => position.state === "open");
        const grossOpenNotional = openPositions.reduce((sum, position) => sum + position.lockedNotional, 0);
        const currentDayBucketStartMs = dayBucketStartMs(now, dayUtcOffsetMinutes);
        const perMarketExposure = openPositions.reduce<Record<string, number>>((acc, position) => {
            acc[position.marketId] = (acc[position.marketId] ?? 0) + position.lockedNotional;
            return acc;
        }, {});
        const dailyRealizedPnl = positions
            .filter((position) => position.state === "resolved" && position.resolvedAt !== null && position.realizedPnl !== null)
            .filter((position) => dayBucketStartMs(position.resolvedAt as number, dayUtcOffsetMinutes) === currentDayBucketStartMs)
            .reduce((sum, position) => sum + (position.realizedPnl ?? 0), 0);

        return {
            realizedPnl: this.realizedPnl,
            dailyRealizedPnl,
            dayBucketStartMs: currentDayBucketStartMs,
            dayUtcOffsetMinutes,
            grossOpenNotional,
            perMarketExposure,
            releasedExposure: this.releasedExposure,
            unrealizedPnlMarkedToMarket: null,
            positions: positions.map((position) => ({ ...position })),
        };
    }
}
