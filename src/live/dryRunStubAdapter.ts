import { ExecutionAdapter } from "./executionAdapter";
import { AccountSnapshotIngestionResult, BalanceReconciliationInput, BalanceReconciliationResult, CancelResult, ExecutionRequest, ExecutionStatusResult, ExecutionSubmitResult, ExternalAccountSnapshotIngestion, ExternalSnapshotExecutionIngestion, ReconciliationInput, ReconciliationResult, ReconciliationSnapshot, SimulatedOrderLifecycleUpdate, SnapshotIngestionResult, TimeoutResult } from "./types";
import { OrderLifecycleStore } from "./orderLifecycle";
import { ExternalReconciliationStore, runNoopReconciliation } from "./reconciliationModel";
import { ExternalBalanceReconciliationStore, runNoopBalanceReconciliation } from "./balanceReconciliation";
import { normalizeExternalAccountSnapshotIngestion } from "./accountSnapshotIngestion";
import { normalizeExternalSnapshotIngestion } from "./snapshotIngestion";
import { captureRuntimeBaselineFromOrderLifecycle } from "./runtimeBaselineCapture";

type StoredAttempt = {
    request: ExecutionRequest;
    submitResult: ExecutionSubmitResult;
};

export class DryRunStubExecutionAdapter implements ExecutionAdapter {
    readonly mode = "dry_run_stub" as const;
    private readonly attempts = new Map<string, StoredAttempt>();
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
            : (!this.opts.liveExecutionEnabled ? "accepted_dry_run_stub" : "accepted_dry_run_stub");
        const accepted = submitStatus === "accepted_dry_run_stub";
        const message = accepted
            ? "dry-run stub accepted request without placing orders"
            : "execution kill switch blocked dry-run request";
        this.orderLifecycle.createFromExecutionRequest(request);
        this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "submit_requested", "submit_requested_by_adapter", request.createdAtMs);
        if (accepted) {
            this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "submitted", "submitted_by_dry_run_stub", request.createdAtMs);
            this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "acknowledged", "acknowledged_by_stub", request.createdAtMs);
            this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "open", "opened_by_stub", request.createdAtMs);
            this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "reconciliation_pending", "reconciliation_requested", request.createdAtMs);
        } else {
            this.orderLifecycle.transitionExecutionAttempt(
                request.executionAttemptId,
                "submit_denied",
                "submit_denied_execution_kill_switch",
                request.createdAtMs,
            );
        }
        const orderStatuses = this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(request.executionAttemptId);
        const result: ExecutionSubmitResult = {
            executionAttemptId: request.executionAttemptId,
            adapterMode: this.mode,
            accepted,
            submitStatus,
            message,
            orderStatuses,
            liveSubmissionResult: null,
        };
        this.attempts.set(request.executionAttemptId, {
            request,
            submitResult: result,
        });
        return result;
    }

    cancelExecutionAttempt(executionAttemptId: string): CancelResult {
        const attempt = this.attempts.get(executionAttemptId);
        if (!attempt) {
            return {
                executionAttemptId,
                adapterMode: this.mode,
                cancelStatus: "rejected_not_found",
                cancelledOrderIds: [],
                message: "dry-run attempt not found",
            };
        }
        this.orderLifecycle.transitionExecutionAttempt(executionAttemptId, "cancel_requested", "cancel_requested_by_adapter", Date.now());
        this.orderLifecycle.transitionExecutionAttempt(executionAttemptId, "cancelled", "cancelled_by_stub", Date.now());
        return {
            executionAttemptId,
            adapterMode: this.mode,
            cancelStatus: "cancelled_stub",
            cancelledOrderIds: this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId).map((item) => item.orderId),
            message: "dry-run cancellation recorded",
        };
    }

    getExecutionStatus(executionAttemptId: string): ExecutionStatusResult {
        const attempt = this.attempts.get(executionAttemptId);
        return {
            executionAttemptId,
            adapterMode: this.mode,
            found: Boolean(attempt),
            message: attempt ? "dry-run status snapshot" : "dry-run attempt not found",
            orderStatuses: attempt ? this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId) : [],
            fillEvents: attempt ? this.orderLifecycle.getFillEventsForExecutionAttempt(executionAttemptId) : [],
        };
    }

    recordSimulatedOrderLifecycle(update: SimulatedOrderLifecycleUpdate): ExecutionStatusResult {
        const attempt = this.attempts.get(update.executionAttemptId);
        return {
            executionAttemptId: update.executionAttemptId,
            adapterMode: this.mode,
            found: Boolean(attempt),
            message: "dry-run stub does not consume replay lifecycle updates",
            orderStatuses: attempt ? this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(update.executionAttemptId) : [],
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
                    accountId: "noop_internal_account",
                    sourceLabel: "dry_run_stub_noop",
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
        const attempt = this.attempts.get(executionAttemptId);
        if (!attempt) {
            return {
                executionAttemptId,
                adapterMode: this.mode,
                timeoutStatus: "rejected_not_found",
                affectedOrderIds: [],
                message: "dry-run attempt not found",
            };
        }
        this.orderLifecycle.transitionExecutionAttempt(executionAttemptId, "expired", "expired_by_stub_timeout", Date.now());
        return {
            executionAttemptId,
            adapterMode: this.mode,
            timeoutStatus: "timed_out_stub",
            affectedOrderIds: this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId).map((item) => item.orderId),
            message: "dry-run timeout recorded",
        };
    }

    reconcileExecutionState(): ReconciliationSnapshot {
        const submitStatusCounts = Array.from(this.attempts.values()).reduce<Record<string, number>>((acc, attempt) => {
            acc[attempt.submitResult.submitStatus] = (acc[attempt.submitResult.submitStatus] ?? 0) + 1;
            return acc;
        }, {});
        const orderStatusCounts = this.orderLifecycle.getTrackedExecutionAttemptIds()
            .flatMap((executionAttemptId) => this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId))
            .reduce<Record<string, number>>((acc, item) => {
            acc[item.status] = (acc[item.status] ?? 0) + 1;
            return acc;
        }, {});
        return {
            adapterMode: this.mode,
            liveExecutionEnabled: this.opts.liveExecutionEnabled,
            executionKillSwitch: this.opts.executionKillSwitch,
            totalExecutionRequests: this.attempts.size,
            totalKnownOrders: this.orderLifecycle.getTotalKnownOrders(),
            submitStatusCounts,
            orderStatusCounts,
            trackedExecutionAttemptIds: this.orderLifecycle.getTrackedExecutionAttemptIds(),
            orderLifecycleSummary: this.orderLifecycle.getSummary(),
            externalReconciliationSummary: this.reconciliation.getSummary(),
            externalBalanceReconciliationSummary: this.balanceReconciliation.getSummary(),
            liveSubmissionSummary: null,
        };
    }

    captureInternalRuntimeBaseline(capturedAtMs = Date.now()) {
        return captureRuntimeBaselineFromOrderLifecycle({
            sourceLabel: "dry_run_stub_execution_adapter_runtime",
            capturedAtMs,
            orderLifecycleStore: this.orderLifecycle,
            accountSnapshot: null,
            rawSourceMetadata: {
                adapterMode: this.mode,
                trackedExecutionAttempts: this.orderLifecycle.getTrackedExecutionAttemptIds().length,
            },
        });
    }

    getLiveSubmissionSummary() {
        return null;
    }
}
