import { ExecutionAdapter } from "./executionAdapter";
import { AccountSnapshotIngestionResult, BalanceReconciliationInput, BalanceReconciliationResult, CancelResult, ExecutionRequest, ExecutionStatusResult, ExecutionSubmitResult, ExternalAccountSnapshotIngestion, ExternalSnapshotExecutionIngestion, ReconciliationInput, ReconciliationResult, ReconciliationSnapshot, SimulatedOrderLifecycleUpdate, SnapshotIngestionResult, TimeoutResult } from "./types";
import { OrderLifecycleStore } from "./orderLifecycle";
import { ExternalReconciliationStore, runNoopReconciliation } from "./reconciliationModel";
import { ExternalBalanceReconciliationStore, runNoopBalanceReconciliation } from "./balanceReconciliation";
import { normalizeExternalAccountSnapshotIngestion } from "./accountSnapshotIngestion";
import { normalizeExternalSnapshotIngestion } from "./snapshotIngestion";
import { captureRuntimeBaselineFromOrderLifecycle } from "./runtimeBaselineCapture";

export class UnsupportedLiveExecutionAdapter implements ExecutionAdapter {
    readonly mode = "future_live_clob" as const;
    private readonly submitStatusCounts = new Map<string, number>();
    private readonly trackedExecutionAttemptIds: string[] = [];
    private readonly orderLifecycle = new OrderLifecycleStore();
    private readonly reconciliation = new ExternalReconciliationStore();
    private readonly balanceReconciliation = new ExternalBalanceReconciliationStore();

    constructor(
        private readonly opts: {
            liveExecutionEnabled: boolean;
            executionKillSwitch: boolean;
        },
    ) {}

    submitExecutionAttempt(request: ExecutionRequest): ExecutionSubmitResult {
        const submitStatus = this.opts.executionKillSwitch
            ? "rejected_execution_kill_switch"
            : (!this.opts.liveExecutionEnabled ? "rejected_live_disabled" : "rejected_live_mode_not_implemented");
        const message = submitStatus === "rejected_execution_kill_switch"
            ? "future_live_clob adapter blocked by execution kill switch"
            : submitStatus === "rejected_live_disabled"
                ? "future_live_clob adapter blocked because LIVE_EXECUTION_ENABLED=false"
                : "future_live_clob adapter is scaffold only and does not place orders";
        this.submitStatusCounts.set(submitStatus, (this.submitStatusCounts.get(submitStatus) ?? 0) + 1);
        this.trackedExecutionAttemptIds.push(request.executionAttemptId);
        this.orderLifecycle.createFromExecutionRequest(request);
        this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "submit_requested", "submit_requested_by_adapter", request.createdAtMs);
        this.orderLifecycle.transitionExecutionAttempt(
            request.executionAttemptId,
            "submit_denied",
            submitStatus === "rejected_execution_kill_switch"
                ? "submit_denied_execution_kill_switch"
                : submitStatus === "rejected_live_disabled"
                    ? "submit_denied_live_disabled"
                    : "submit_denied_live_not_implemented",
            request.createdAtMs,
        );
        return {
            executionAttemptId: request.executionAttemptId,
            adapterMode: this.mode,
            accepted: false,
            submitStatus,
            message,
            orderStatuses: this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(request.executionAttemptId),
        };
    }

    cancelExecutionAttempt(executionAttemptId: string): CancelResult {
        return {
            executionAttemptId,
            adapterMode: this.mode,
            cancelStatus: "rejected_unsupported",
            cancelledOrderIds: [],
            message: "future_live_clob adapter is not implemented",
        };
    }

    getExecutionStatus(executionAttemptId: string): ExecutionStatusResult {
        return {
            executionAttemptId,
            adapterMode: this.mode,
            found: this.trackedExecutionAttemptIds.includes(executionAttemptId),
            message: "future_live_clob adapter is not implemented",
            orderStatuses: this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId),
            fillEvents: [],
        };
    }

    recordSimulatedOrderLifecycle(update: SimulatedOrderLifecycleUpdate): ExecutionStatusResult {
        return {
            executionAttemptId: update.executionAttemptId,
            adapterMode: this.mode,
            found: this.trackedExecutionAttemptIds.includes(update.executionAttemptId),
            message: "future_live_clob adapter does not consume simulated lifecycle updates",
            orderStatuses: this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(update.executionAttemptId),
            fillEvents: [],
        };
    }

    ingestExternalSnapshot(input: ExternalSnapshotExecutionIngestion): SnapshotIngestionResult {
        const normalization = this.reconciliation.recordNormalization(normalizeExternalSnapshotIngestion(input));
        if (!normalization.accepted || !normalization.snapshot) {
            return {
                normalization,
                reconciliation: null,
            };
        }
        return {
            normalization,
            reconciliation: this.reconcileWithExternalState({
                capturedAtMs: normalization.snapshot.capturedAtMs,
                comparisonMode: "noop_stub",
                snapshot: normalization.snapshot,
            }),
        };
    }

    ingestExternalAccountSnapshot(input: ExternalAccountSnapshotIngestion): AccountSnapshotIngestionResult {
        const normalization = this.balanceReconciliation.recordNormalization(normalizeExternalAccountSnapshotIngestion(input));
        if (!normalization.accepted || !normalization.snapshot) {
            return {
                normalization,
                reconciliation: null,
            };
        }
        return {
            normalization,
            reconciliation: this.reconcileAccountBalances({
                capturedAtMs: normalization.snapshot.capturedAtMs,
                comparisonMode: "noop_stub",
                internalAccount: {
                    accountId: "future_live_clob_noop_internal_account",
                    sourceLabel: "future_live_clob_noop",
                    capturedAtMs: normalization.snapshot.capturedAtMs,
                    assets: [],
                    rawSourceMetadata: null,
                },
                externalAccount: normalization.snapshot,
            }),
        };
    }

    reconcileWithExternalState(input: ReconciliationInput): ReconciliationResult {
        return this.reconciliation.record(runNoopReconciliation({
            adapterMode: this.mode,
            input,
        }));
    }

    reconcileAccountBalances(input: BalanceReconciliationInput): BalanceReconciliationResult {
        return this.balanceReconciliation.record(runNoopBalanceReconciliation({
            adapterMode: this.mode,
            input,
        }));
    }

    markExecutionTimedOut(executionAttemptId: string): TimeoutResult {
        return {
            executionAttemptId,
            adapterMode: this.mode,
            timeoutStatus: "rejected_unsupported",
            affectedOrderIds: [],
            message: "future_live_clob adapter is not implemented",
        };
    }

    reconcileExecutionState(): ReconciliationSnapshot {
        return {
            adapterMode: this.mode,
            liveExecutionEnabled: this.opts.liveExecutionEnabled,
            executionKillSwitch: this.opts.executionKillSwitch,
            totalExecutionRequests: this.trackedExecutionAttemptIds.length,
            totalKnownOrders: this.orderLifecycle.getTotalKnownOrders(),
            submitStatusCounts: Object.fromEntries(this.submitStatusCounts.entries()),
            orderStatusCounts: this.orderLifecycle.getTrackedExecutionAttemptIds()
                .flatMap((executionAttemptId) => this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId))
                .reduce<Record<string, number>>((acc, item) => {
                    acc[item.status] = (acc[item.status] ?? 0) + 1;
                    return acc;
                }, {}),
            trackedExecutionAttemptIds: [...this.trackedExecutionAttemptIds],
            orderLifecycleSummary: this.orderLifecycle.getSummary(),
            externalReconciliationSummary: this.reconciliation.getSummary(),
            externalBalanceReconciliationSummary: this.balanceReconciliation.getSummary(),
        };
    }

    captureInternalRuntimeBaseline(capturedAtMs = Date.now()) {
        return captureRuntimeBaselineFromOrderLifecycle({
            sourceLabel: "future_live_clob_execution_adapter_runtime",
            capturedAtMs,
            orderLifecycleStore: this.orderLifecycle,
            accountSnapshot: null,
            rawSourceMetadata: {
                adapterMode: this.mode,
                trackedExecutionAttempts: this.orderLifecycle.getTrackedExecutionAttemptIds().length,
            },
        });
    }
}
