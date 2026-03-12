import fs from "node:fs";
import path from "node:path";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { LiveOrderPilotConfig } from "../config/liveOrderPilot";
import { OrderLifecycleStore } from "./orderLifecycle";
import { buildInternalReconciliationSnapshots } from "./reconciliationModel";
import {
    FillEventExternalIdentifiers,
    InternalOrderBaselineSnapshot,
    LiveOrderPilotRequest,
    LiveOrderPilotResult,
    LiveOrderSubmissionRequest,
    LivePilotVenueAckSnapshot,
    OrderExternalIdentifiers,
} from "./types";
import { buildLiveOrderSubmissionRequests, evaluateLiveSubmissionGuard } from "./liveSubmission";
import {
    createPilotSessionId,
    createPilotSessionManifest,
    defaultPilotSessionManifestPath,
    writePilotSessionManifest,
} from "./pilotSession";

export type LiveOrderPilotTransport = {
    createAndPostOrder(
        userOrder: { tokenID: string; side: Side; size: number; price: number },
        options: { tickSize: string; negRisk?: boolean },
        orderType: OrderType.GTC,
        deferExec?: boolean,
        postOnly?: boolean,
    ): Promise<any>;
};

function parseString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractVenueAck(rawResponse: unknown): LivePilotVenueAckSnapshot {
    const payload = rawResponse && typeof rawResponse === "object" ? rawResponse as Record<string, unknown> : null;
    const externalOrderId =
        parseString(payload?.orderID)
        ?? parseString(payload?.orderId)
        ?? parseString(payload?.id)
        ?? parseString(payload?.hash)
        ?? parseString(payload?.order_id);
    const rawStatus =
        parseString(payload?.status)
        ?? parseString(payload?.state)
        ?? parseString(payload?.orderStatus);
    return {
        acknowledged: payload !== null,
        externalOrderId,
        rawStatus,
        rawResponse: payload,
    };
}

function buildPilotExecutionRequest(args: {
    executionAttemptId: string;
    request: LiveOrderSubmissionRequest;
}) {
    return {
        executionAttemptId: args.executionAttemptId,
        correlationId: args.executionAttemptId,
        source: "paper" as const,
        strategyId: "binary_full_set_arb_v1" as const,
        marketId: args.request.marketId,
        slug: args.request.slug,
        createdAtMs: args.request.createdAtMs,
        requestedSize: args.request.size,
        legs: [{
            legId: args.request.legId,
            tokenId: args.request.tokenId,
            binarySide: args.request.binarySide,
            side: args.request.side,
            limitPrice: args.request.limitPrice,
            size: args.request.size,
            timeInForce: args.request.timeInForce,
        }],
        notes: [
            "one_shot_live_order_pilot",
            "manual_invocation_only",
        ],
    };
}

function writePilotOrderBaseline(args: {
    baselineDir: string;
    executionAttemptId: string;
    orderSnapshot: InternalOrderBaselineSnapshot;
}) {
    const outputPath = path.resolve(args.baselineDir, `${args.executionAttemptId}.orders.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify([args.orderSnapshot], null, 2)}\n`, "utf8");
    return outputPath;
}

function writePilotResult(args: {
    resultDir: string;
    executionAttemptId: string;
    result: LiveOrderPilotResult;
}) {
    const outputPath = path.resolve(args.resultDir, `${args.executionAttemptId}.result.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(args.result, null, 2)}\n`, "utf8");
    return outputPath;
}

export async function runLiveOrderPilot(args: {
    config: LiveOrderPilotConfig;
    request: LiveOrderPilotRequest;
    transport: LiveOrderPilotTransport;
}): Promise<LiveOrderPilotResult> {
    const executionAttemptId = `live-order-pilot-${args.request.invokedAtMs}`;
    const pilotSessionId = createPilotSessionId(executionAttemptId);
    const liveRequest: LiveOrderSubmissionRequest = buildLiveOrderSubmissionRequests({
        executionAttemptId,
        correlationId: executionAttemptId,
        source: "paper",
        strategyId: "binary_full_set_arb_v1",
        marketId: args.request.marketId,
        slug: args.request.marketId,
        createdAtMs: args.request.invokedAtMs,
        requestedSize: args.request.size,
        legs: [{
            legId: `${executionAttemptId}-single`,
            tokenId: args.request.assetId,
            binarySide: "yes",
            side: args.request.side,
            limitPrice: args.request.price,
            size: args.request.size,
            timeInForce: args.request.timeInForce,
        }],
        notes: ["one_shot_live_order_pilot"],
    })[0];

    const guard = evaluateLiveSubmissionGuard({
        request: liveRequest,
        config: {
            liveExecutionEnabled: args.config.liveExecutionEnabled,
            executionKillSwitch: args.config.executionKillSwitch,
            liveSubmissionMode: args.config.liveSubmissionMode,
            allowlistedMarkets: args.config.allowlistedMarkets,
            allowlistedAssets: args.config.allowlistedAssets,
            maxOrderSize: args.config.maxOrderSize,
            requiredEnvironmentConfirmation: args.config.requiredConfirmation,
            providedEnvironmentConfirmation: args.request.confirmValue,
        },
        allowedModes: ["one_shot_live_pilot"],
    });

    if (args.config.maxOrderSize > args.config.absoluteMaxOrderSize) {
        guard.allow = false;
        guard.reasonCodes.push("pilot_size_cap_not_tiny_enough");
    }

    const orderLifecycle = new OrderLifecycleStore();
    orderLifecycle.createFromExecutionRequest(buildPilotExecutionRequest({
        executionAttemptId,
        request: liveRequest,
    }));
    orderLifecycle.transitionExecutionAttempt(executionAttemptId, "submit_requested", "submit_requested_by_adapter", liveRequest.createdAtMs);

    let venueAck: LivePilotVenueAckSnapshot | null = null;
    let terminalState: LiveOrderPilotResult["terminalState"] = "denied";
    let requestSent = false;
    let message = `pilot submission denied: ${guard.reasonCodes.join(",")}`;

    if (!guard.allow) {
        orderLifecycle.transitionExecutionAttempt(executionAttemptId, "submit_denied", "submit_denied_live_not_implemented", liveRequest.createdAtMs);
    } else {
        try {
            const response = await args.transport.createAndPostOrder(
                {
                    tokenID: liveRequest.tokenId,
                    side: liveRequest.side === "buy" ? Side.BUY : Side.SELL,
                    size: liveRequest.size,
                    price: liveRequest.limitPrice,
                },
                {
                    tickSize: args.request.tickSize,
                },
                OrderType.GTC,
            );
            requestSent = true;
            venueAck = extractVenueAck(response);
            orderLifecycle.transitionExecutionAttempt(executionAttemptId, "submitted", "submitted_by_live_pilot", liveRequest.createdAtMs);
            orderLifecycle.transitionExecutionAttempt(executionAttemptId, "acknowledged", "acknowledged_by_live_pilot", liveRequest.createdAtMs);
            orderLifecycle.transitionExecutionAttempt(executionAttemptId, "open", "opened_by_live_pilot", liveRequest.createdAtMs);
            if (venueAck.externalOrderId) {
                const identifiers: OrderExternalIdentifiers = {
                    externalOrderId: venueAck.externalOrderId,
                    externalExecutionId: null,
                    venueOrderRef: venueAck.externalOrderId,
                    provenance: "future_external_identifier_scaffold",
                };
                orderLifecycle.attachOrderExternalIdentifiers(`${executionAttemptId}-order-1`, identifiers, liveRequest.createdAtMs);
            }
            terminalState = venueAck.acknowledged ? "submitted_acknowledged" : "submitted_unknown";
            message = venueAck.acknowledged
                ? "pilot submission sent and venue returned an acknowledgment payload"
                : "pilot submission sent but venue acknowledgment shape was unclear";
        } catch (error) {
            terminalState = "failed";
            message = error instanceof Error ? error.message : String(error);
            orderLifecycle.transitionExecutionAttempt(executionAttemptId, "rejected", "rejected_by_live_pilot", liveRequest.createdAtMs);
        }
    }

    const baseline = buildInternalReconciliationSnapshots({
        orders: orderLifecycle.getAllOrderRecords(),
        fillEvents: orderLifecycle.getAllFillEvents(),
    })[0];
    const orderBaselinePath = baseline
        ? writePilotOrderBaseline({
            baselineDir: args.config.baselineDir,
            executionAttemptId: pilotSessionId,
            orderSnapshot: baseline,
        })
        : null;

    const result: LiveOrderPilotResult = {
        pilotSessionId,
        pilotSessionManifestPath: null,
        terminalState,
        requestSent,
        denied: !requestSent,
        submittedAtMs: requestSent ? liveRequest.createdAtMs : null,
        executionAttemptId,
        guard,
        venueAck,
        internalOrderBaselinePath: orderBaselinePath,
        resultOutputPath: null,
        followUp: {
            recommendedReconcileCommand: orderBaselinePath
                ? `npm run venue:reconcile -- --order-baseline ${orderBaselinePath}`
                : "npm run venue:reconcile",
        },
        message,
    };

    const resultOutputPath = writePilotResult({
        resultDir: args.config.resultDir,
        executionAttemptId: pilotSessionId,
        result,
    });
    result.resultOutputPath = resultOutputPath;
    const manifestCapture = writePilotSessionManifest({
        manifestPath: defaultPilotSessionManifestPath({
            resultDir: args.config.resultDir,
            pilotSessionId,
        }),
        manifest: createPilotSessionManifest({
            pilotSessionId,
            executionAttemptId,
            marketId: args.request.marketId,
            assetId: args.request.assetId,
            externalOrderId: result.venueAck?.externalOrderId ?? null,
            terminalState: result.terminalState,
            createdAtMs: args.request.invokedAtMs,
            sourceLabel: args.config.logLabel,
            rawSourceMetadata: {
                requestSent: result.requestSent,
                denied: result.denied,
            },
            artifacts: [
                {
                    artifactType: "pilot_result",
                    artifactPath: resultOutputPath,
                    attachedAtMs: args.request.invokedAtMs,
                    status: "present",
                    provenance: "pilot_runtime_output",
                    notes: ["one_shot_live_order_pilot"],
                },
                ...(orderBaselinePath
                    ? [{
                        artifactType: "order_baseline" as const,
                        artifactPath: orderBaselinePath,
                        attachedAtMs: args.request.invokedAtMs,
                        status: "present" as const,
                        provenance: "pilot_runtime_output" as const,
                        notes: ["internal_order_baseline_for_post_submit_verification"],
                    }]
                    : []),
            ],
        }),
    });
    result.pilotSessionManifestPath = manifestCapture.manifestPath;
    fs.writeFileSync(resultOutputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
}

export function createPilotTransport(client: ClobClient): LiveOrderPilotTransport {
    return {
        createAndPostOrder(userOrder, options, orderType, deferExec, postOnly) {
            return client.createAndPostOrder(userOrder, options, orderType, deferExec, postOnly);
        },
    };
}
