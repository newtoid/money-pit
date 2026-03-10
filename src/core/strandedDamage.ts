import type { ExecutionAttemptRecord } from "./executionStateMachine";
import type { ReplayExecutionOutcome } from "../arbScanner/types";

export type StrandedDamageState =
    | "detected_damage"
    | "open_damage"
    | "resolved_damage"
    | "expired_damage";

export type StrandedDamageType =
    | "leg_a_only"
    | "leg_b_only"
    | "partial_fill"
    | "stale_execution"
    | "invalidated_opportunity"
    | "queue_limited_partial_fill";

export type StrandedDamageFlag =
    | "stale_execution"
    | "invalidated_opportunity"
    | "queue_limited_partial_fill";

export type StrandedDamageResolutionReason =
    | "damage_opened_for_accounting"
    | "replay_session_end_summary"
    | "reporting_window_elapsed";

export type StrandedDamageTransition = {
    fromState: StrandedDamageState | null;
    toState: StrandedDamageState;
    reason: "damage_detected" | StrandedDamageResolutionReason;
    ts: number;
};

export type StrandedDamageRecord = {
    id: string;
    attemptId: string;
    marketId: string;
    slug: string;
    legSide: "yes" | "no" | null;
    intendedSize: number;
    filledSize: number;
    averageFillPrice: number | null;
    damageType: StrandedDamageType;
    damageFlags: StrandedDamageFlag[];
    amount: number;
    outstandingExposure: number;
    originatingTerminalExecutionState: string;
    createdAtMs: number;
    resolvedAtMs: number | null;
    provenance: "replay_execution_outcome" | "paper_execution_outcome";
    resolutionReason: StrandedDamageResolutionReason | null;
    currentState: StrandedDamageState;
    history: StrandedDamageTransition[];
};

export type StrandedDamageSummary = {
    openStrandedDamageCount: number;
    resolvedStrandedDamageCount: number;
    expiredStrandedDamageCount: number;
    totalOutstandingStrandedExposure: number;
    totalRecordedDamageNotional: number;
    totalStrandedNotionalByType: Record<StrandedDamageType, number>;
    outstandingStrandedExposureByType: Record<StrandedDamageType, number>;
    oldestOpenStrandedDamageAgeMs: number | null;
    strandedDamageByOriginatingTerminalState: Record<string, number>;
    stateCounts: Record<StrandedDamageState, number>;
};

const TERMINAL_DAMAGE_STATES = new Set<StrandedDamageState>(["resolved_damage", "expired_damage"]);

function isTerminal(state: StrandedDamageState) {
    return TERMINAL_DAMAGE_STATES.has(state);
}

function roundAmount(value: number) {
    return Math.round(value * 1_000_000) / 1_000_000;
}

function emptyTypeMap() {
    return {
        leg_a_only: 0,
        leg_b_only: 0,
        partial_fill: 0,
        stale_execution: 0,
        invalidated_opportunity: 0,
        queue_limited_partial_fill: 0,
    } satisfies Record<StrandedDamageType, number>;
}

function emptyStateMap() {
    return {
        detected_damage: 0,
        open_damage: 0,
        resolved_damage: 0,
        expired_damage: 0,
    } satisfies Record<StrandedDamageState, number>;
}

function hasFlag(outcome: ReplayExecutionOutcome, flag: StrandedDamageFlag) {
    if (flag === "stale_execution") {
        return [outcome.legA.reason, outcome.legB?.reason].filter(Boolean).includes("stale_orderbook");
    }
    if (flag === "invalidated_opportunity") {
        return outcome.invalidatedBeforeSecondLeg || outcome.opportunityInvalidated;
    }
    return outcome.legA.queueLimitedReason === "queue_limited_partial_fill"
        || outcome.legB?.queueLimitedReason === "queue_limited_partial_fill";
}

function buildFlags(outcome: ReplayExecutionOutcome): StrandedDamageFlag[] {
    const flags: StrandedDamageFlag[] = [];
    if (hasFlag(outcome, "stale_execution")) flags.push("stale_execution");
    if (hasFlag(outcome, "invalidated_opportunity")) flags.push("invalidated_opportunity");
    if (hasFlag(outcome, "queue_limited_partial_fill")) flags.push("queue_limited_partial_fill");
    return flags;
}

export function buildStrandedDamageRecords(args: {
    attempt: ExecutionAttemptRecord;
    outcome: ReplayExecutionOutcome;
    provenance: "replay_execution_outcome" | "paper_execution_outcome";
    nextId: () => string;
}): StrandedDamageRecord[] {
    const { attempt, outcome, provenance, nextId } = args;
    const createdAtMs = outcome.legBAttemptedAt ?? outcome.legAAttemptedAt;
    const originatingTerminalExecutionState = attempt.terminalState ?? "non_terminal";
    const flags = buildFlags(outcome);
    const records: StrandedDamageRecord[] = [];

    const pushRecord = (record: Omit<StrandedDamageRecord, "id" | "currentState" | "resolvedAtMs" | "resolutionReason" | "history">) => {
        if (record.amount <= 0) return;
        records.push({
            ...record,
            id: nextId(),
            currentState: "open_damage",
            resolvedAtMs: null,
            resolutionReason: null,
            history: [
                {
                    fromState: null,
                    toState: "detected_damage",
                    reason: "damage_detected",
                    ts: record.createdAtMs,
                },
                {
                    fromState: "detected_damage",
                    toState: "open_damage",
                    reason: "damage_opened_for_accounting",
                    ts: record.createdAtMs,
                },
            ],
        });
    };

    if (outcome.outcome === "leg_a_fill_only" && outcome.strandedNotional > 0) {
        pushRecord({
            attemptId: attempt.id,
            marketId: outcome.marketId,
            slug: outcome.slug,
            legSide: outcome.legA.side,
            intendedSize: outcome.legA.requestedSize,
            filledSize: Math.max(0, outcome.legA.filledSize - outcome.matchedSize),
            averageFillPrice: outcome.legA.averageFillPrice,
            damageType: "leg_a_only",
            damageFlags: flags,
            amount: roundAmount(outcome.strandedNotional),
            outstandingExposure: roundAmount(outcome.strandedNotional),
            originatingTerminalExecutionState,
            createdAtMs,
            provenance,
        });
    }

    if (outcome.outcome === "leg_b_fill_only" && outcome.strandedNotional > 0 && outcome.legB) {
        pushRecord({
            attemptId: attempt.id,
            marketId: outcome.marketId,
            slug: outcome.slug,
            legSide: outcome.legB.side,
            intendedSize: outcome.legB.requestedSize,
            filledSize: Math.max(0, outcome.legB.filledSize - outcome.matchedSize),
            averageFillPrice: outcome.legB.averageFillPrice,
            damageType: "leg_b_only",
            damageFlags: flags,
            amount: roundAmount(outcome.strandedNotional),
            outstandingExposure: roundAmount(outcome.strandedNotional),
            originatingTerminalExecutionState,
            createdAtMs,
            provenance,
        });
    }

    if (
        outcome.partialFillDamage > 0
        && (outcome.outcome === "partial_both" || outcome.outcome === "partial_fill_insufficient_depth" || outcome.fullSetFill?.status === "partial")
    ) {
        const damageType: StrandedDamageType = hasFlag(outcome, "queue_limited_partial_fill")
            ? "queue_limited_partial_fill"
            : "partial_fill";
        pushRecord({
            attemptId: attempt.id,
            marketId: outcome.marketId,
            slug: outcome.slug,
            legSide: null,
            intendedSize: outcome.legA.requestedSize,
            filledSize: outcome.matchedSize,
            averageFillPrice: null,
            damageType,
            damageFlags: flags,
            amount: roundAmount(outcome.partialFillDamage),
            outstandingExposure: roundAmount(outcome.partialFillDamage),
            originatingTerminalExecutionState,
            createdAtMs,
            provenance,
        });
    }

    return records;
}

export class StrandedDamageTracker {
    private readonly records: StrandedDamageRecord[] = [];
    private nextRecordId = 1;

    private nextId() {
        return `damage-${this.nextRecordId++}`;
    }

    recordExecutionOutcome(args: {
        attempt: ExecutionAttemptRecord;
        outcome: ReplayExecutionOutcome;
        provenance: "replay_execution_outcome" | "paper_execution_outcome";
    }) {
        const created = buildStrandedDamageRecords({
            ...args,
            nextId: () => this.nextId(),
        });
        this.records.push(...created);
        return created;
    }

    expireOpenDamageOlderThan(now: number, windowMs: number) {
        if (windowMs <= 0) return;
        for (const record of this.records) {
            if (record.currentState !== "open_damage") continue;
            if ((now - record.createdAtMs) < windowMs) continue;
            this.transition(record, "expired_damage", "reporting_window_elapsed", now);
        }
    }

    resolveAllOpen(now: number, reason: Extract<StrandedDamageResolutionReason, "replay_session_end_summary">) {
        for (const record of this.records) {
            if (record.currentState !== "open_damage") continue;
            this.transition(record, "resolved_damage", reason, now);
        }
    }

    private transition(
        record: StrandedDamageRecord,
        toState: StrandedDamageState,
        reason: StrandedDamageResolutionReason,
        ts: number,
    ) {
        if (isTerminal(record.currentState)) {
            throw new Error(`Stranded damage record ${record.id} is already terminal`);
        }
        const fromState = record.currentState;
        record.currentState = toState;
        record.resolvedAtMs = ts;
        record.resolutionReason = reason;
        if (toState !== "open_damage") {
            record.outstandingExposure = 0;
        }
        record.history.push({
            fromState,
            toState,
            reason,
            ts,
        });
    }

    getRecords() {
        return this.records.map((record) => ({
            ...record,
            damageFlags: [...record.damageFlags],
            history: record.history.map((item) => ({ ...item })),
        }));
    }

    getSummary(now: number): StrandedDamageSummary {
        const totalByType = emptyTypeMap();
        const outstandingByType = emptyTypeMap();
        const stateCounts = emptyStateMap();
        const byOriginatingTerminalState = this.records.reduce<Record<string, number>>((acc, record) => {
            acc[record.originatingTerminalExecutionState] = (acc[record.originatingTerminalExecutionState] ?? 0) + roundAmount(record.amount);
            return acc;
        }, {});

        let oldestOpenAgeMs: number | null = null;
        let totalOutstandingStrandedExposure = 0;
        let totalRecordedDamageNotional = 0;
        for (const record of this.records) {
            stateCounts[record.currentState] += 1;
            totalByType[record.damageType] += roundAmount(record.amount);
            outstandingByType[record.damageType] += roundAmount(record.outstandingExposure);
            totalOutstandingStrandedExposure += roundAmount(record.outstandingExposure);
            totalRecordedDamageNotional += roundAmount(record.amount);
            if (record.currentState === "open_damage") {
                const ageMs = Math.max(0, now - record.createdAtMs);
                oldestOpenAgeMs = oldestOpenAgeMs === null ? ageMs : Math.max(oldestOpenAgeMs, ageMs);
            }
        }

        return {
            openStrandedDamageCount: stateCounts.open_damage,
            resolvedStrandedDamageCount: stateCounts.resolved_damage,
            expiredStrandedDamageCount: stateCounts.expired_damage,
            totalOutstandingStrandedExposure: roundAmount(totalOutstandingStrandedExposure),
            totalRecordedDamageNotional: roundAmount(totalRecordedDamageNotional),
            totalStrandedNotionalByType: totalByType,
            outstandingStrandedExposureByType: outstandingByType,
            oldestOpenStrandedDamageAgeMs: oldestOpenAgeMs,
            strandedDamageByOriginatingTerminalState: byOriginatingTerminalState,
            stateCounts,
        };
    }
}
