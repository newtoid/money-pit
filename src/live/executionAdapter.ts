import {
    CancelResult,
    BalanceReconciliationInput,
    BalanceReconciliationResult,
    ExecutionRequest,
    ExecutionStatusResult,
    ExecutionSubmitResult,
    ExternalSnapshotExecutionIngestion,
    ReconciliationInput,
    ReconciliationResult,
    ReconciliationSnapshot,
    SnapshotIngestionResult,
    SimulatedOrderLifecycleUpdate,
    TimeoutResult,
} from "./types";

export interface ExecutionAdapter {
    readonly mode: "dry_run_stub" | "replay_simulated" | "future_live_clob";

    submitExecutionAttempt(request: ExecutionRequest): ExecutionSubmitResult;

    cancelExecutionAttempt(executionAttemptId: string): CancelResult;

    getExecutionStatus(executionAttemptId: string): ExecutionStatusResult;

    recordSimulatedOrderLifecycle(update: SimulatedOrderLifecycleUpdate): ExecutionStatusResult;

    ingestExternalSnapshot(input: ExternalSnapshotExecutionIngestion): SnapshotIngestionResult;

    reconcileWithExternalState(input: ReconciliationInput): ReconciliationResult;

    reconcileAccountBalances(input: BalanceReconciliationInput): BalanceReconciliationResult;

    markExecutionTimedOut(executionAttemptId: string): TimeoutResult;

    reconcileExecutionState(): ReconciliationSnapshot;
}
