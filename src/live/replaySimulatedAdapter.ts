import { ExecutionAdapter } from "./executionAdapter";
import { AccountSnapshotIngestionResult, BalanceReconciliationInput, BalanceReconciliationResult, CancelResult, ExecutionRequest, ExecutionStatusResult, ExecutionSubmitResult, ExternalAccountSnapshotIngestion, ExternalSnapshotExecutionIngestion, ReconciliationInput, ReconciliationResult, ReconciliationSnapshot, SimulatedOrderLifecycleUpdate, SnapshotIngestionResult, TimeoutResult } from "./types";
import { OrderLifecycleStore } from "./orderLifecycle";
import { buildInternalReconciliationSnapshots, ExternalReconciliationStore, runExternalReconciliation } from "./reconciliationModel";
import { ExternalBalanceReconciliationStore, runExternalBalanceReconciliation } from "./balanceReconciliation";
import { normalizeExternalAccountSnapshotIngestion } from "./accountSnapshotIngestion";
import { normalizeExternalSnapshotIngestion } from "./snapshotIngestion";
import { captureRuntimeBaselineFromOrderLifecycle } from "./runtimeBaselineCapture";

export class ReplaySimulatedExecutionAdapter implements ExecutionAdapter {
    readonly mode = "replay_simulated" as const;
    private readonly submitResults = new Map<string, ExecutionSubmitResult>();
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
        this.orderLifecycle.createFromExecutionRequest(request);
        this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "submit_requested", "submit_requested_by_adapter", request.createdAtMs);
        this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "submitted", "submitted_by_replay_simulated", request.createdAtMs);
        this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "acknowledged", "acknowledged_by_stub", request.createdAtMs);
        this.orderLifecycle.transitionExecutionAttempt(request.executionAttemptId, "open", "opened_by_stub", request.createdAtMs);
        const orderStatuses = this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(request.executionAttemptId);
        const result: ExecutionSubmitResult = {
            executionAttemptId: request.executionAttemptId,
            adapterMode: this.mode,
            accepted: true,
            submitStatus: "accepted_replay_simulated",
            message: "replay-simulated adapter accepted request without live submission",
            orderStatuses,
        };
        this.submitResults.set(request.executionAttemptId, result);
        return result;
    }

    cancelExecutionAttempt(executionAttemptId: string): CancelResult {
        if (!this.submitResults.has(executionAttemptId)) {
            return {
                executionAttemptId,
                adapterMode: this.mode,
                cancelStatus: "rejected_not_found",
                cancelledOrderIds: [],
                message: "replay-simulated execution attempt not found",
            };
        }
        return {
            executionAttemptId,
            adapterMode: this.mode,
            cancelStatus: "cancelled_stub",
            cancelledOrderIds: [],
            message: "replay-simulated cancellation acknowledged without exchange side effects",
        };
    }

    getExecutionStatus(executionAttemptId: string): ExecutionStatusResult {
        const result = this.submitResults.get(executionAttemptId);
        return {
            executionAttemptId,
            adapterMode: this.mode,
            found: Boolean(result),
            message: result ? "replay-simulated adapter status snapshot" : "replay-simulated execution attempt not found",
            orderStatuses: result ? this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId) : [],
            fillEvents: result ? this.orderLifecycle.getFillEventsForExecutionAttempt(executionAttemptId) : [],
        };
    }

    recordSimulatedOrderLifecycle(update: SimulatedOrderLifecycleUpdate): ExecutionStatusResult {
        const result = this.submitResults.get(update.executionAttemptId);
        if (!result) {
            return {
                executionAttemptId: update.executionAttemptId,
                adapterMode: this.mode,
                found: false,
                message: "replay-simulated execution attempt not found",
                orderStatuses: [],
                fillEvents: [],
            };
        }
        this.orderLifecycle.applySimulatedUpdate(update);
        return {
            executionAttemptId: update.executionAttemptId,
            adapterMode: this.mode,
            found: true,
            message: "replay-simulated order lifecycle updated from replay outcome",
            orderStatuses: this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(update.executionAttemptId),
            fillEvents: this.orderLifecycle.getFillEventsForExecutionAttempt(update.executionAttemptId),
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
                comparisonMode: "synthetic_external_snapshot_compare",
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
            reconciliation: null,
        };
    }

    reconcileWithExternalState(input: ReconciliationInput): ReconciliationResult {
        const internalOrders = buildInternalReconciliationSnapshots({
            orders: this.orderLifecycle.getAllOrderRecords(),
            fillEvents: this.orderLifecycle.getAllFillEvents(),
        });
        return this.reconciliation.record(runExternalReconciliation({
            adapterMode: this.mode,
            input,
            internalOrders,
        }));
    }

    reconcileAccountBalances(input: BalanceReconciliationInput): BalanceReconciliationResult {
        return this.balanceReconciliation.record(runExternalBalanceReconciliation({
            adapterMode: this.mode,
            input,
        }));
    }

    markExecutionTimedOut(executionAttemptId: string): TimeoutResult {
        if (!this.submitResults.has(executionAttemptId)) {
            return {
                executionAttemptId,
                adapterMode: this.mode,
                timeoutStatus: "rejected_not_found",
                affectedOrderIds: [],
                message: "replay-simulated execution attempt not found",
            };
        }
        this.orderLifecycle.transitionExecutionAttempt(executionAttemptId, "expired", "expired_by_stub_timeout", Date.now());
        return {
            executionAttemptId,
            adapterMode: this.mode,
            timeoutStatus: "timed_out_stub",
            affectedOrderIds: [],
            message: "replay-simulated timeout acknowledged; replay remains lifecycle authority",
        };
    }

    reconcileExecutionState(): ReconciliationSnapshot {
        const submitStatusCounts = Array.from(this.submitResults.values()).reduce<Record<string, number>>((acc, item) => {
            acc[item.submitStatus] = (acc[item.submitStatus] ?? 0) + 1;
            return acc;
        }, {});
        return {
            adapterMode: this.mode,
            liveExecutionEnabled: this.opts.liveExecutionEnabled,
            executionKillSwitch: this.opts.executionKillSwitch,
            totalExecutionRequests: this.submitResults.size,
            totalKnownOrders: this.orderLifecycle.getTotalKnownOrders(),
            submitStatusCounts,
            orderStatusCounts: this.orderLifecycle.getTrackedExecutionAttemptIds()
                .flatMap((executionAttemptId) => this.orderLifecycle.getOrderSnapshotsForExecutionAttempt(executionAttemptId))
                .reduce<Record<string, number>>((acc, item) => {
                    acc[item.status] = (acc[item.status] ?? 0) + 1;
                    return acc;
                }, {}),
            trackedExecutionAttemptIds: this.orderLifecycle.getTrackedExecutionAttemptIds(),
            orderLifecycleSummary: this.orderLifecycle.getSummary(),
            externalReconciliationSummary: this.reconciliation.getSummary(),
            externalBalanceReconciliationSummary: this.balanceReconciliation.getSummary(),
        };
    }

    captureInternalRuntimeBaseline(capturedAtMs = Date.now()) {
        return captureRuntimeBaselineFromOrderLifecycle({
            sourceLabel: "replay_simulated_execution_adapter_runtime",
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
