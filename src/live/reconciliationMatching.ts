import {
    ExternalFillSnapshot,
    ExternalOrderSnapshot,
    InternalOrderReconciliationSnapshot,
    ReconciliationMatchRule,
    ReconciliationMatchingIssueType,
    ReconciliationMatchingOutcome,
} from "./types";

type MatchCandidate = {
    orderId: string;
    rule: ReconciliationMatchRule;
};

function unique(values: string[]) {
    return Array.from(new Set(values));
}

function buildExternalReference(args: {
    candidateType: "order" | "fill";
    externalOrderId: string | null;
    externalExecutionId: string | null;
    externalFillId: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    correlationId: string | null;
}) {
    return [
        args.candidateType,
        args.externalOrderId ?? "no-order-id",
        args.externalExecutionId ?? "no-exec-id",
        args.externalFillId ?? "no-fill-id",
        args.executionAttemptId ?? "no-attempt",
        args.legId ?? "no-leg",
        args.correlationId ?? "no-correlation",
    ].join(":");
}

function findCandidatesByRule(args: {
    candidateType: "order" | "fill";
    externalOrderId: string | null;
    externalExecutionId: string | null;
    externalFillId: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    correlationId: string | null;
    internalOrders: InternalOrderReconciliationSnapshot[];
}) {
    const rules: Array<{ rule: ReconciliationMatchRule; candidates: string[] }> = [];

    if (args.externalOrderId) {
        rules.push({
            rule: "matched_by_external_order_id",
            candidates: args.internalOrders
                .filter((item) => item.knownExternalOrderId === args.externalOrderId)
                .map((item) => item.orderId),
        });
    }
    if (args.externalExecutionId) {
        rules.push({
            rule: "matched_by_external_execution_id",
            candidates: args.internalOrders
                .filter((item) => item.knownExternalExecutionId === args.externalExecutionId)
                .map((item) => item.orderId),
        });
    }
    if (args.candidateType === "fill" && args.externalFillId) {
        rules.push({
            rule: "matched_by_external_fill_id",
            candidates: args.internalOrders
                .filter((item) => item.knownExternalFillIds.includes(args.externalFillId!))
                .map((item) => item.orderId),
        });
    }
    if (args.executionAttemptId && args.legId) {
        rules.push({
            rule: "matched_by_execution_attempt_leg",
            candidates: args.internalOrders
                .filter((item) => item.executionAttemptId === args.executionAttemptId && item.legId === args.legId)
                .map((item) => item.orderId),
        });
    }
    if (args.correlationId && args.legId) {
        rules.push({
            rule: "matched_by_internal_correlation",
            candidates: args.internalOrders
                .filter((item) => item.correlationId === args.correlationId && item.legId === args.legId)
                .map((item) => item.orderId),
        });
    }

    return rules;
}

function identityKey(args: {
    candidateType: "order" | "fill";
    externalOrderId: string | null;
    externalExecutionId: string | null;
    externalFillId: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    correlationId: string | null;
}) {
    if (args.externalFillId) return `${args.candidateType}:fill:${args.externalFillId}`;
    if (args.externalOrderId) return `${args.candidateType}:order:${args.externalOrderId}`;
    if (args.externalExecutionId) return `${args.candidateType}:exec:${args.externalExecutionId}`;
    if (args.executionAttemptId && args.legId) return `${args.candidateType}:attempt-leg:${args.executionAttemptId}:${args.legId}`;
    if (args.correlationId && args.legId) return `${args.candidateType}:correlation:${args.correlationId}:${args.legId}`;
    return null;
}

function evaluateCandidate(args: {
    candidateType: "order" | "fill";
    externalOrderId: string | null;
    externalExecutionId: string | null;
    externalFillId: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    correlationId: string | null;
    internalOrders: InternalOrderReconciliationSnapshot[];
    duplicateExternalIdentity: boolean;
}): ReconciliationMatchingOutcome {
    const rules = findCandidatesByRule(args);
    const reference = buildExternalReference(args);
    const issueTypes: ReconciliationMatchingIssueType[] = [];

    if (args.duplicateExternalIdentity) {
        issueTypes.push("duplicate_external_snapshot");
    }

    const uniqueMatchesByRule = rules
        .filter((entry) => entry.candidates.length > 0)
        .map((entry) => ({
            rule: entry.rule,
            candidates: unique(entry.candidates),
        }));

    const matchedRules = uniqueMatchesByRule.filter((entry) => entry.candidates.length === 1);
    const distinctMatchedOrders = unique(matchedRules.flatMap((entry) => entry.candidates));
    const ambiguousRules = uniqueMatchesByRule.filter((entry) => entry.candidates.length > 1);

    if (ambiguousRules.length > 0) {
        issueTypes.push("duplicate_internal_candidates");
    }
    if (distinctMatchedOrders.length > 1) {
        issueTypes.push("conflicting_identifier_data");
    }
    if (matchedRules.length === 0 && uniqueMatchesByRule.length > 0) {
        issueTypes.push("unmatched_ambiguous_candidates");
    }
    if (rules.length === 0) {
        issueTypes.push("unmatched_missing_identifiers");
    } else if (uniqueMatchesByRule.length === 0) {
        issueTypes.push("partial_identifier_insufficient");
    }

    if (
        issueTypes.includes("conflicting_identifier_data")
        || issueTypes.includes("duplicate_internal_candidates")
        || issueTypes.includes("unmatched_ambiguous_candidates")
        || issueTypes.includes("unmatched_missing_identifiers")
        || issueTypes.includes("partial_identifier_insufficient")
    ) {
        return {
            candidateType: args.candidateType,
            externalReference: reference,
            matchedInternalOrderId: null,
            matchRule: null,
            issueTypes,
            details: {
                rulesChecked: rules.length,
                matchedRules: matchedRules.length,
                distinctMatchedOrders: distinctMatchedOrders.length,
            },
        };
    }

    const firstMatchedRule = matchedRules[0];
    return {
        candidateType: args.candidateType,
        externalReference: reference,
        matchedInternalOrderId: firstMatchedRule?.candidates[0] ?? null,
        matchRule: firstMatchedRule?.rule ?? null,
        issueTypes,
        details: {
            rulesChecked: rules.length,
        },
    };
}

export function matchExternalSnapshots(args: {
    internalOrders: InternalOrderReconciliationSnapshot[];
    externalOrders: ExternalOrderSnapshot[];
    externalFills: ExternalFillSnapshot[];
}) {
    const duplicateCounts = new Map<string, number>();
    const registerIdentity = (key: string | null) => {
        if (!key) return;
        duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
    };

    for (const order of args.externalOrders) {
        registerIdentity(identityKey({
            candidateType: "order",
            externalOrderId: order.externalOrderId,
            externalExecutionId: order.externalExecutionId,
            externalFillId: null,
            executionAttemptId: order.executionAttemptId,
            legId: order.legId,
            correlationId: order.correlationId,
        }));
    }
    for (const fill of args.externalFills) {
        registerIdentity(identityKey({
            candidateType: "fill",
            externalOrderId: fill.externalOrderId,
            externalExecutionId: fill.externalExecutionId,
            externalFillId: fill.externalFillId,
            executionAttemptId: fill.executionAttemptId,
            legId: fill.legId,
            correlationId: null,
        }));
    }

    const orderOutcomes = args.externalOrders.map((order) => {
        const key = identityKey({
            candidateType: "order",
            externalOrderId: order.externalOrderId,
            externalExecutionId: order.externalExecutionId,
            externalFillId: null,
            executionAttemptId: order.executionAttemptId,
            legId: order.legId,
            correlationId: order.correlationId,
        });
        return evaluateCandidate({
            candidateType: "order",
            externalOrderId: order.externalOrderId,
            externalExecutionId: order.externalExecutionId,
            externalFillId: null,
            executionAttemptId: order.executionAttemptId,
            legId: order.legId,
            correlationId: order.correlationId,
            internalOrders: args.internalOrders,
            duplicateExternalIdentity: key !== null && (duplicateCounts.get(key) ?? 0) > 1,
        });
    });

    const fillOutcomes = args.externalFills.map((fill) => {
        const key = identityKey({
            candidateType: "fill",
            externalOrderId: fill.externalOrderId,
            externalExecutionId: fill.externalExecutionId,
            externalFillId: fill.externalFillId,
            executionAttemptId: fill.executionAttemptId,
            legId: fill.legId,
            correlationId: null,
        });
        return evaluateCandidate({
            candidateType: "fill",
            externalOrderId: fill.externalOrderId,
            externalExecutionId: fill.externalExecutionId,
            externalFillId: fill.externalFillId,
            executionAttemptId: fill.executionAttemptId,
            legId: fill.legId,
            correlationId: null,
            internalOrders: args.internalOrders,
            duplicateExternalIdentity: key !== null && (duplicateCounts.get(key) ?? 0) > 1,
        });
    });

    return {
        orderOutcomes,
        fillOutcomes,
        allOutcomes: [...orderOutcomes, ...fillOutcomes],
    };
}
