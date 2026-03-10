export type ExecutionMode = "dry_run_stub" | "replay_simulated" | "future_live_clob";
export type LiveSubmissionMode = "disabled" | "future_live_clob_guarded";

export type ExecutionRequestSource = "paper" | "replay";

export type ExecutionStrategyId = "binary_full_set_arb_v1";

export type ExecutionSide = "buy";

export type TimeInForce = "FOK" | "FAK" | "GTC";

export type ExecutionLegOrderRequest = {
    legId: string;
    tokenId: string;
    binarySide: "yes" | "no";
    side: ExecutionSide;
    limitPrice: number;
    size: number;
    timeInForce: TimeInForce;
};

export type InternalExternalIdentifierProvenance =
    | "none"
    | "synthetic_fixture"
    | "future_external_identifier_scaffold";

export type OrderExternalIdentifiers = {
    externalOrderId: string | null;
    externalExecutionId: string | null;
    venueOrderRef: string | null;
    provenance: InternalExternalIdentifierProvenance;
};

export type FillEventExternalIdentifiers = {
    externalOrderId: string | null;
    externalExecutionId: string | null;
    externalFillId: string | null;
    venueOrderRef: string | null;
    provenance: InternalExternalIdentifierProvenance;
};

export type ExecutionRequest = {
    executionAttemptId: string;
    correlationId: string;
    source: ExecutionRequestSource;
    strategyId: ExecutionStrategyId;
    marketId: string;
    slug: string;
    createdAtMs: number;
    requestedSize: number;
    legs: ExecutionLegOrderRequest[];
    notes: string[];
};

export type OrderLifecycleState =
    | "created"
    | "submit_requested"
    | "submit_denied"
    | "submitted"
    | "acknowledged"
    | "open"
    | "partially_filled"
    | "filled"
    | "cancel_requested"
    | "rejected"
    | "cancelled"
    | "expired"
    | "reconciliation_pending"
    | "reconciled";

export type OrderLifecycleTransitionReason =
    | "order_created_from_execution_request"
    | "submit_requested_by_adapter"
    | "submit_denied_execution_kill_switch"
    | "submit_denied_live_disabled"
    | "submit_denied_live_not_implemented"
    | "submitted_by_dry_run_stub"
    | "submitted_by_replay_simulated"
    | "acknowledged_by_stub"
    | "opened_by_stub"
    | "partially_filled_by_replay_simulation"
    | "filled_by_replay_simulation"
    | "cancel_requested_by_adapter"
    | "cancelled_by_stub"
    | "expired_by_stub_timeout"
    | "rejected_by_stub"
    | "reconciliation_requested"
    | "reconciled_by_stub";

export type OrderLifecycleTransition = {
    fromState: OrderLifecycleState | null;
    toState: OrderLifecycleState;
    reason: OrderLifecycleTransitionReason;
    ts: number;
};

export type OrderLifecycleRecord = {
    orderId: string;
    executionAttemptId: string;
    correlationId: string;
    legId: string;
    tokenId: string;
    binarySide: "yes" | "no";
    currentState: OrderLifecycleState;
    terminalState: OrderLifecycleState | null;
    createdAtMs: number;
    updatedAtMs: number;
    externalIdentifiers: OrderExternalIdentifiers;
    history: OrderLifecycleTransition[];
};

export type OrderStatus =
    | "created"
    | "accepted"
    | "open"
    | "partial"
    | "filled"
    | "rejected"
    | "cancelled"
    | "timed_out"
    | "unknown";

export type OrderStatusSnapshot = {
    orderId: string;
    executionAttemptId: string;
    legId: string;
    tokenId: string;
    status: OrderStatus;
    message: string;
    updatedAtMs: number;
};

export type FillEvent = {
    executionAttemptId: string;
    orderId: string;
    legId: string;
    filledSize: number;
    averageFillPrice: number;
    ts: number;
    externalIdentifiers: FillEventExternalIdentifiers;
};

export type CancelResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    cancelStatus: "cancelled_stub" | "rejected_not_found" | "rejected_unsupported";
    cancelledOrderIds: string[];
    message: string;
};

export type TimeoutResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    timeoutStatus: "timed_out_stub" | "rejected_not_found" | "rejected_unsupported";
    affectedOrderIds: string[];
    message: string;
};

export type ExecutionSubmitResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    accepted: boolean;
    submitStatus:
        | "accepted_dry_run_stub"
        | "accepted_replay_simulated"
        | "rejected_live_disabled"
        | "rejected_execution_kill_switch"
        | "rejected_live_mode_not_implemented";
    message: string;
    orderStatuses: OrderStatusSnapshot[];
    liveSubmissionResult?: LiveOrderSubmissionResult | null;
};

export type LiveSubmissionGuardReason =
    | "live_execution_disabled"
    | "execution_kill_switch_enabled"
    | "live_submission_mode_not_selected"
    | "market_not_allowlisted"
    | "asset_not_allowlisted"
    | "order_size_above_cap"
    | "max_order_size_cap_missing"
    | "environment_confirmation_missing"
    | "live_submission_not_implemented_in_phase";

export type LiveOrderSubmissionRequest = {
    executionAttemptId: string;
    correlationId: string;
    marketId: string;
    slug: string;
    legId: string;
    tokenId: string;
    binarySide: "yes" | "no";
    side: ExecutionSide;
    limitPrice: number;
    size: number;
    timeInForce: TimeInForce;
    createdAtMs: number;
    source: ExecutionRequestSource;
};

export type LiveSubmissionGuardResult = {
    allow: boolean;
    reasonCodes: LiveSubmissionGuardReason[];
    details: {
        liveExecutionEnabled: boolean;
        executionKillSwitch: boolean;
        liveSubmissionMode: LiveSubmissionMode;
        maxOrderSize: number;
        requiredEnvironmentConfirmation: string | null;
        providedEnvironmentConfirmation: string | null;
        allowlistedMarkets: string[];
        allowlistedAssets: string[];
        attemptedMarketId: string;
        attemptedAssetId: string;
        attemptedSize: number;
    };
};

export type LiveOrderAckSnapshot = {
    executionAttemptId: string;
    legId: string;
    tokenId: string;
    status: "guard_denied" | "not_submitted";
    reasonCode: LiveSubmissionGuardReason;
    message: string;
    createdAtMs: number;
};

export type LiveOrderSubmissionResult = {
    executionAttemptId: string;
    submissionMode: LiveSubmissionMode;
    accepted: boolean;
    submissionStatus: "denied_by_guard" | "denied_not_implemented";
    guard: LiveSubmissionGuardResult;
    deniedAcks: LiveOrderAckSnapshot[];
    message: string;
};

export type LiveSubmissionSummary = {
    attemptsConstructed: number;
    deniedSubmissionCount: number;
    guardFailureCounts: Record<string, number>;
    configuredSafetyPosture: {
        liveExecutionEnabled: boolean;
        executionKillSwitch: boolean;
        liveSubmissionMode: LiveSubmissionMode;
        maxOrderSize: number;
        allowlistedMarkets: string[];
        allowlistedAssets: string[];
        requiredEnvironmentConfirmationConfigured: boolean;
    };
};

export type ExecutionStatusResult = {
    executionAttemptId: string;
    adapterMode: ExecutionMode;
    found: boolean;
    message: string;
    orderStatuses: OrderStatusSnapshot[];
    fillEvents: FillEvent[];
};

export type SimulatedOrderLifecycleUpdate = {
    executionAttemptId: string;
    ts: number;
    legUpdates: Array<{
        legId: string;
        terminalState: Extract<OrderLifecycleState, "open" | "partially_filled" | "filled" | "rejected" | "expired" | "cancelled">;
        reason: OrderLifecycleTransitionReason;
        filledSize?: number;
        averageFillPrice?: number | null;
    }>;
    reconciliationPending?: boolean;
    reconcileNow?: boolean;
};

export type OrderLifecycleSummary = {
    ordersByTerminalState: Record<string, number>;
    transitionReasonCounts: Record<string, number>;
    submitDeniedCount: number;
    reconciliationPendingCount: number;
    averageOrderLifetimeMs: number | null;
};

export type InternalOrderReconciliationSnapshot = {
    orderId: string;
    executionAttemptId: string;
    correlationId: string;
    legId: string;
    tokenId: string;
    binarySide: "yes" | "no";
    currentState: OrderLifecycleState;
    terminalState: OrderLifecycleState | null;
    comparableStatus: OrderStatus;
    createdAtMs: number;
    updatedAtMs: number;
    filledSize: number;
    averageFillPrice: number | null;
    fillEventCount: number;
    filledNotional: number | null;
    partialFillObserved: boolean;
    statusProgressionRank: number;
    knownExternalOrderId: string | null;
    knownExternalExecutionId: string | null;
    knownExternalFillIds: string[];
    knownVenueOrderRef: string | null;
    externalIdentifierProvenance: InternalExternalIdentifierProvenance;
};

export type ExternalOrderStatus =
    | "accepted"
    | "open"
    | "partial"
    | "filled"
    | "cancelled"
    | "expired"
    | "rejected"
    | "unknown";

export type ExternalOrderSnapshot = {
    internalOrderId: string | null;
    externalOrderId: string | null;
    externalExecutionId: string | null;
    venueOrderRef: string | null;
    executionAttemptId: string | null;
    correlationId: string | null;
    legId: string | null;
    tokenId: string | null;
    status: ExternalOrderStatus;
    filledSize: number | null;
    averageFillPrice: number | null;
    externalFillCount: number | null;
    totalFilledNotional: number | null;
    partialFillObserved: boolean | null;
    observedAtMs: number;
    rawSourceMetadata: Record<string, unknown> | null;
};

export type ExternalFillSnapshot = {
    internalOrderId: string | null;
    externalOrderId: string | null;
    externalExecutionId: string | null;
    externalFillId: string | null;
    venueOrderRef: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    filledSize: number;
    averageFillPrice: number | null;
    observedAtMs: number;
    rawSourceMetadata: Record<string, unknown> | null;
};

export type ExternalSnapshotProvenance =
    | "synthetic_test_snapshot"
    | "replay_generated_snapshot"
    | "future_external_api_shape"
    | "real_readonly_clob_open_orders_trades_api";

export type ExternalAccountSnapshotProvenance =
    | "synthetic_test_account_snapshot"
    | "replay_generated_account_snapshot"
    | "future_external_account_api_shape"
    | "real_readonly_clob_balance_allowance_api";

export type ExternalExecutionSnapshot = {
    provenance: ExternalSnapshotProvenance;
    sourceLabel: string;
    capturedAtMs: number;
    maxSnapshotAgeMs: number | null;
    trustworthy: boolean;
    orders: ExternalOrderSnapshot[];
    fills: ExternalFillSnapshot[];
    rawSourceMetadata: Record<string, unknown> | null;
};

export type ReconciliationInput = {
    capturedAtMs: number;
    comparisonMode: "noop_stub" | "synthetic_external_snapshot_compare";
    snapshot: ExternalExecutionSnapshot;
};

export type ReconciliationIssueType =
    | "status_mismatch"
    | "fill_quantity_mismatch"
    | "fill_price_mismatch"
    | "missing_external_order"
    | "unexpected_external_order"
    | "missing_external_order_id"
    | "stale_external_snapshot"
    | "unresolved_reconciliation_state";

export type ReconciliationIssue = {
    issueType: ReconciliationIssueType;
    orderId: string | null;
    externalOrderId: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    message: string;
    details: Record<string, number | string | boolean | null>;
};

export type ReconciliationMatchRule =
    | "matched_by_external_order_id"
    | "matched_by_external_execution_id"
    | "matched_by_external_fill_id"
    | "matched_by_execution_attempt_leg"
    | "matched_by_internal_correlation";

export type ReconciliationMatchingIssueType =
    | "unmatched_missing_identifiers"
    | "partial_identifier_insufficient"
    | "unmatched_ambiguous_candidates"
    | "conflicting_identifier_data"
    | "duplicate_external_snapshot"
    | "duplicate_internal_candidates";

export type ReconciliationMatchingOutcome = {
    candidateType: "order" | "fill";
    externalReference: string;
    matchedInternalOrderId: string | null;
    matchRule: ReconciliationMatchRule | null;
    issueTypes: ReconciliationMatchingIssueType[];
    details: Record<string, number | string | boolean | null>;
};

export type ReconciliationAccountingIssueType =
    | "external_internal_fill_count_mismatch"
    | "external_internal_notional_mismatch"
    | "external_internal_avg_price_mismatch"
    | "external_internal_status_progression_mismatch"
    | "external_internal_partial_fill_mismatch";

export type ReconciliationAccountingField =
    | "fill_count"
    | "filled_notional"
    | "avg_fill_price"
    | "status_progression"
    | "partial_fill_flag";

export type ReconciliationAccountingComparison = {
    orderId: string;
    externalOrderId: string | null;
    issueTypes: ReconciliationAccountingIssueType[];
    skippedFields: ReconciliationAccountingField[];
    details: Record<string, number | string | boolean | null>;
};

export type ReconciliationDiff = {
    orderId: string | null;
    externalOrderId: string | null;
    executionAttemptId: string | null;
    legId: string | null;
    matched: boolean;
    internalStatus: OrderStatus | null;
    externalStatus: ExternalOrderStatus | null;
    internalFilledSize: number | null;
    externalFilledSize: number | null;
    internalAverageFillPrice: number | null;
    externalAverageFillPrice: number | null;
    issueTypes: ReconciliationIssueType[];
    accountingIssueTypes: ReconciliationAccountingIssueType[];
};

export type ReconciliationResult = {
    adapterMode: ExecutionMode;
    comparisonMode: ReconciliationInput["comparisonMode"];
    capturedAtMs: number;
    snapshotProvenance: ExternalSnapshotProvenance;
    snapshotSourceLabel: string;
    snapshotTrustworthy: boolean;
    issueCountsByType: Record<ReconciliationIssueType, number>;
    accountingIssueCountsByType: Record<string, number>;
    matchCountsByRule: Record<string, number>;
    unmatchedCountsByReason: Record<string, number>;
    ambiguousMatchCount: number;
    conflictingIdentifierCount: number;
    duplicateExternalSnapshotCount: number;
    matchedOrderCount: number;
    mismatchedOrderCount: number;
    missingExternalOrderCount: number;
    unexpectedExternalOrderCount: number;
    missingExternalOrderIdCount: number;
    staleSnapshotWarningCount: number;
    unresolvedReconciliationCount: number;
    comparisonCoverageCounts: Record<string, number>;
    skippedAccountingFields: Record<string, number>;
    internalIdentifierCoverage: Record<string, number>;
    internalIdentifierProvenanceCounts: Record<string, number>;
    matchedOrdersWithAccountingAgreement: number;
    matchedOrdersWithAccountingDisagreement: number;
    matchingOutcomes: ReconciliationMatchingOutcome[];
    accountingComparisons: ReconciliationAccountingComparison[];
    diffs: ReconciliationDiff[];
    issues: ReconciliationIssue[];
};

export type ExternalSnapshotOrderIngestion = {
    internalOrderId?: string | null;
    externalOrderId?: string | null;
    externalExecutionId?: string | null;
    venueOrderRef?: string | null;
    executionAttemptId?: string | null;
    correlationId?: string | null;
    legId?: string | null;
    tokenId?: string | null;
    status?: string | null;
    filledSize?: number | string | null;
    averageFillPrice?: number | string | null;
    externalFillCount?: number | string | null;
    totalFilledNotional?: number | string | null;
    partialFillObserved?: boolean | null;
    observedAtMs?: number | string | null;
    rawSourceMetadata?: Record<string, unknown> | null;
};

export type ExternalSnapshotFillIngestion = {
    internalOrderId?: string | null;
    externalOrderId?: string | null;
    externalExecutionId?: string | null;
    externalFillId?: string | null;
    venueOrderRef?: string | null;
    executionAttemptId?: string | null;
    legId?: string | null;
    filledSize?: number | string | null;
    averageFillPrice?: number | string | null;
    observedAtMs?: number | string | null;
    rawSourceMetadata?: Record<string, unknown> | null;
};

export type ExternalSnapshotExecutionIngestion = {
    provenance: ExternalSnapshotProvenance;
    sourceLabel: string;
    capturedAtMs?: number | string | null;
    ingestedAtMs?: number | string | null;
    maxSnapshotAgeMs?: number | string | null;
    trustworthy?: boolean | null;
    orders?: ExternalSnapshotOrderIngestion[] | null;
    fills?: ExternalSnapshotFillIngestion[] | null;
    rawSourceMetadata?: Record<string, unknown> | null;
};

export type SnapshotNormalizationWarningType =
    | "missing_external_identifiers"
    | "missing_internal_match_keys"
    | "unknown_status_value"
    | "invalid_numeric_field"
    | "missing_timestamp"
    | "stale_snapshot_input";

export type SnapshotNormalizationWarning = {
    warningType: SnapshotNormalizationWarningType;
    scope: "snapshot" | "order" | "fill";
    message: string;
    details: Record<string, number | string | boolean | null>;
};

export type SnapshotIngestionRejectReason =
    | "missing_source_label"
    | "invalid_captured_at"
    | "missing_snapshot_payload";

export type SnapshotNormalizationResult = {
    accepted: boolean;
    rejectReason: SnapshotIngestionRejectReason | null;
    snapshot: ExternalExecutionSnapshot | null;
    warnings: SnapshotNormalizationWarning[];
};

export type SnapshotIngestionResult = {
    normalization: SnapshotNormalizationResult;
    reconciliation: ReconciliationResult | null;
};

export type ExternalReconciliationSummary = {
    reconciliationRuns: number;
    issueCountsByType: Record<string, number>;
    accountingIssueCountsByType: Record<string, number>;
    matchCountsByRule: Record<string, number>;
    unmatchedCountsByReason: Record<string, number>;
    ambiguousMatchCount: number;
    conflictingIdentifierCount: number;
    duplicateExternalSnapshotCount: number;
    matchedOrderCount: number;
    mismatchedOrderCount: number;
    missingExternalOrderCount: number;
    unexpectedExternalOrderCount: number;
    missingExternalOrderIdCount: number;
    staleSnapshotWarningCount: number;
    unresolvedReconciliationCount: number;
    comparisonCoverageCounts: Record<string, number>;
    skippedAccountingFields: Record<string, number>;
    internalIdentifierCoverage: Record<string, number>;
    internalIdentifierProvenanceCounts: Record<string, number>;
    matchedOrdersWithAccountingAgreement: number;
    matchedOrdersWithAccountingDisagreement: number;
    lastComparisonMode: ReconciliationInput["comparisonMode"] | null;
    lastSnapshotSourceLabel: string | null;
    trustworthySnapshotCount: number;
    untrustworthySnapshotCount: number;
    snapshotsIngestedByProvenance: Record<string, number>;
    snapshotsMissingExternalIdentifiers: number;
    malformedSnapshotRejectCount: number;
    staleSnapshotInputCount: number;
    normalizationWarningCounts: Record<string, number>;
};

export type ReconciliationSnapshot = {
    adapterMode: ExecutionMode;
    liveExecutionEnabled: boolean;
    executionKillSwitch: boolean;
    totalExecutionRequests: number;
    totalKnownOrders: number;
    submitStatusCounts: Record<string, number>;
    orderStatusCounts: Record<string, number>;
    trackedExecutionAttemptIds: string[];
    orderLifecycleSummary: OrderLifecycleSummary;
    externalReconciliationSummary: ExternalReconciliationSummary;
    externalBalanceReconciliationSummary: ExternalBalanceReconciliationSummary;
    liveSubmissionSummary: LiveSubmissionSummary | null;
};

export type InternalAssetBalanceSnapshot = {
    assetSymbol: string;
    availableBalance: number | null;
    reservedBalance: number | null;
    totalBalance: number | null;
    rawSourceMetadata: Record<string, unknown> | null;
};

export type InternalAccountBalanceSnapshot = {
    accountId: string;
    sourceLabel: string;
    capturedAtMs: number;
    assets: InternalAssetBalanceSnapshot[];
    rawSourceMetadata: Record<string, unknown> | null;
};

export type InternalBaselineProvenance =
    | "manual_internal_baseline_export"
    | "empty_internal_baseline_export"
    | "future_runtime_internal_baseline_capture";

export type InternalOrderBaselineSnapshot = InternalOrderReconciliationSnapshot;

export type InternalFillBaselineSnapshot = {
    executionAttemptId: string;
    orderId: string;
    legId: string;
    filledSize: number;
    averageFillPrice: number;
    ts: number;
    externalIdentifiers: FillEventExternalIdentifiers;
};

export type InternalAccountBaselineSnapshot = InternalAccountBalanceSnapshot;

export type InternalBaselineExport = {
    provenance: InternalBaselineProvenance;
    sourceLabel: string;
    capturedAtMs: number;
    orders: InternalOrderBaselineSnapshot[];
    fills: InternalFillBaselineSnapshot[];
    account: InternalAccountBaselineSnapshot | null;
    rawSourceMetadata: Record<string, unknown> | null;
};

export type InternalBaselineCaptureResult = {
    exportSnapshot: InternalBaselineExport;
    outputPath: string | null;
    orderOutputPath: string | null;
    accountOutputPath: string | null;
    exportedRecordCounts: Record<string, number>;
    missingSections: string[];
    sectionSourceStatus: {
        orders: "runtime_capture" | "combined_baseline" | "split_input" | "empty";
        fills: "runtime_capture" | "combined_baseline" | "empty";
        account: "runtime_capture" | "combined_baseline" | "split_input" | "empty";
    };
    sourceCounts: Record<string, number>;
};

export type InternalRuntimeBaselineCapture = {
    provenance: "future_runtime_internal_baseline_capture";
    sourceLabel: string;
    capturedAtMs: number;
    orders: InternalOrderBaselineSnapshot[];
    fills: InternalFillBaselineSnapshot[];
    account: InternalAccountBaselineSnapshot | null;
    runtimeSourceStatus: {
        orderLifecycleAvailable: boolean;
        fillEventsAvailable: boolean;
        internalAccountAvailable: boolean;
    };
    unavailableSources: string[];
    rawSourceMetadata: Record<string, unknown> | null;
};

export type ExternalAssetBalanceSnapshot = {
    assetSymbol: string;
    availableBalance: number | null;
    reservedBalance: number | null;
    totalBalance: number | null;
    rawSourceMetadata: Record<string, unknown> | null;
};

export type ExternalReservedBalanceSnapshot = {
    assetSymbol: string;
    reservationType: string;
    amount: number | null;
    rawSourceMetadata: Record<string, unknown> | null;
};

export type ExternalAccountSnapshot = {
    accountId: string | null;
    provenance: ExternalAccountSnapshotProvenance;
    sourceLabel: string;
    capturedAtMs: number;
    maxSnapshotAgeMs: number | null;
    trustworthy: boolean;
    assets: ExternalAssetBalanceSnapshot[];
    reservedBalances: ExternalReservedBalanceSnapshot[];
    rawSourceMetadata: Record<string, unknown> | null;
};

export type BalanceReconciliationInput = {
    capturedAtMs: number;
    comparisonMode: "noop_stub" | "synthetic_external_account_snapshot_compare";
    internalAccount: InternalAccountBalanceSnapshot;
    externalAccount: ExternalAccountSnapshot;
};

export type BalanceReconciliationIssueType =
    | "external_internal_available_balance_mismatch"
    | "external_internal_reserved_balance_mismatch"
    | "external_internal_total_balance_mismatch"
    | "missing_external_asset_balance"
    | "unexpected_external_asset_balance"
    | "stale_external_account_snapshot"
    | "insufficient_balance_comparison_coverage";

export type BalanceReconciliationIssue = {
    issueType: BalanceReconciliationIssueType;
    accountId: string | null;
    assetSymbol: string | null;
    message: string;
    details: Record<string, number | string | boolean | null>;
};

export type BalanceComparisonField =
    | "available_balance"
    | "reserved_balance"
    | "total_balance";

export type BalanceReconciliationComparison = {
    accountId: string | null;
    assetSymbol: string;
    matched: boolean;
    issueTypes: BalanceReconciliationIssueType[];
    skippedFields: BalanceComparisonField[];
    details: Record<string, number | string | boolean | null>;
};

export type BalanceReconciliationResult = {
    adapterMode: ExecutionMode;
    comparisonMode: BalanceReconciliationInput["comparisonMode"];
    capturedAtMs: number;
    snapshotProvenance: ExternalAccountSnapshotProvenance;
    snapshotSourceLabel: string;
    snapshotTrustworthy: boolean;
    issueCountsByType: Record<string, number>;
    comparisonCoverageCounts: Record<string, number>;
    skippedComparisonFields: Record<string, number>;
    matchedAssetCount: number;
    mismatchedAssetCount: number;
    missingExternalAssetCount: number;
    unexpectedExternalAssetCount: number;
    staleSnapshotWarningCount: number;
    insufficientCoverageCount: number;
    comparedAssetCount: number;
    skippedAssetCount: number;
    comparisons: BalanceReconciliationComparison[];
    issues: BalanceReconciliationIssue[];
};

export type ExternalBalanceReconciliationSummary = {
    reconciliationRuns: number;
    issueCountsByType: Record<string, number>;
    comparisonCoverageCounts: Record<string, number>;
    skippedComparisonFields: Record<string, number>;
    matchedAssetCount: number;
    mismatchedAssetCount: number;
    missingExternalAssetCount: number;
    unexpectedExternalAssetCount: number;
    staleSnapshotWarningCount: number;
    insufficientCoverageCount: number;
    comparedAssetCount: number;
    skippedAssetCount: number;
    lastComparisonMode: BalanceReconciliationInput["comparisonMode"] | null;
    lastSnapshotSourceLabel: string | null;
    trustworthySnapshotCount: number;
    untrustworthySnapshotCount: number;
    snapshotsByProvenance: Record<string, number>;
    ingestedAccountSnapshotsByProvenance: Record<string, number>;
    malformedAccountSnapshotRejectCount: number;
    staleAccountSnapshotInputCount: number;
    accountSnapshotNormalizationWarningCounts: Record<string, number>;
    accountSnapshotsMissingKeyBalanceFields: number;
};

export type ExternalAssetBalanceIngestion = {
    assetSymbol?: string | null;
    availableBalance?: number | string | null;
    reservedBalance?: number | string | null;
    totalBalance?: number | string | null;
    rawSourceMetadata?: Record<string, unknown> | null;
};

export type ExternalReservedBalanceIngestion = {
    assetSymbol?: string | null;
    reservationType?: string | null;
    amount?: number | string | null;
    rawSourceMetadata?: Record<string, unknown> | null;
};

export type ExternalAccountSnapshotIngestion = {
    provenance: ExternalAccountSnapshotProvenance;
    sourceLabel: string;
    accountId?: string | null;
    capturedAtMs?: number | string | null;
    ingestedAtMs?: number | string | null;
    maxSnapshotAgeMs?: number | string | null;
    trustworthy?: boolean | null;
    assets?: ExternalAssetBalanceIngestion[] | null;
    reservedBalances?: ExternalReservedBalanceIngestion[] | null;
    rawSourceMetadata?: Record<string, unknown> | null;
};

export type AccountSnapshotNormalizationWarningType =
    | "missing_asset_symbol"
    | "missing_reserved_balance_key"
    | "missing_balance_field"
    | "invalid_numeric_field"
    | "missing_timestamp"
    | "stale_account_snapshot_input";

export type AccountSnapshotNormalizationWarning = {
    warningType: AccountSnapshotNormalizationWarningType;
    scope: "snapshot" | "asset" | "reserved_balance";
    message: string;
    details: Record<string, number | string | boolean | null>;
};

export type AccountSnapshotIngestionRejectReason =
    | "missing_source_label"
    | "invalid_captured_at"
    | "missing_account_snapshot_payload";

export type AccountSnapshotNormalizationResult = {
    accepted: boolean;
    rejectReason: AccountSnapshotIngestionRejectReason | null;
    snapshot: ExternalAccountSnapshot | null;
    warnings: AccountSnapshotNormalizationWarning[];
};

export type AccountSnapshotIngestionResult = {
    normalization: AccountSnapshotNormalizationResult;
    reconciliation: BalanceReconciliationResult | null;
};
