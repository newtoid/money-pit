import { CancelResult, ExecutionRequest, ExecutionStatusResult, ExecutionSubmitResult, ReconciliationSnapshot, SimulatedOrderLifecycleUpdate, TimeoutResult } from "./types";

export interface ExecutionAdapter {
    readonly mode: "dry_run_stub" | "replay_simulated" | "future_live_clob";

    submitExecutionAttempt(request: ExecutionRequest): ExecutionSubmitResult;

    cancelExecutionAttempt(executionAttemptId: string): CancelResult;

    getExecutionStatus(executionAttemptId: string): ExecutionStatusResult;

    recordSimulatedOrderLifecycle(update: SimulatedOrderLifecycleUpdate): ExecutionStatusResult;

    markExecutionTimedOut(executionAttemptId: string): TimeoutResult;

    reconcileExecutionState(): ReconciliationSnapshot;
}
