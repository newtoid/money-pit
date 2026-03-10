# RUNBOOK

## Recorder

Run the read-only scanner with recording enabled:

```bash
ARB_RECORDER_ENABLED=true npm run arb:scan
```

Recorded files are written to:

- `data/recordings`

JSONL event types currently written:

- `session_start`
- `market_metadata`
- `ws_market`
- `book_top`
- `opportunity`
- `sim_fill` (paper trading only)
- `position_open`
- `position_resolve`
- `resolution_event`

Resolution events are now recorded through a real ingestion path:

- `RESOLUTION_POLLING_ENABLED=true` starts a Gamma poller for tracked markets
- the poller fetches market metadata by market ID
- closed markets are normalized into `resolution_event` records
- those records are appended to the same JSONL session file

## Replay

Replay a recorded session:

```bash
npm run arb:replay -- --input data/recordings/arb-scan.jsonl
```

Or:

```bash
tsx scripts/replay.ts --input data/recordings/arb-scan.jsonl
```

## Doctor

List recording files:

```bash
tsx scripts/doctor.ts
```

## Important Operational Notes

- Replay assumes deterministic strategy evaluation over recorded data.
- Replay currently uses simulated fills, not real exchange acknowledgements.
- If websocket payload shape drifts, replay quality depends on whether `ws_market` or `book_top` events remain parseable.
- Replay and paper trading now share the same hard risk gate.
- Replay execution timing is configurable:
  - `EXECUTION_LATENCY_MS`
  - `LEG_EXECUTION_DRIFT_MS`
  - `ORDERBOOK_STALENESS_TOLERANCE_MS`
  - `PARTIAL_FILL_MODE`
- Replay leg execution is event-quantized:
  - scheduled attempts execute when the next relevant replay event arrives
  - there is no interpolated book state between recorded events
- Depth-aware replay is conditional on recorded data:
  - raw `ws_market` payloads may preserve visible ladders for sweep simulation
  - `book_top`-only recordings fall back to one visible level
  - top-only deltas do not reconstruct a full ladder
- Queue realism is also replay-only and data-limited:
  - recordings do not include true queue position
  - queue modes only apply conservative haircuts to visible depth
  - `QUEUE_PRIORITY_MODE` values are:
    - `optimistic_visible_depth`
    - `conservative_queue_haircut`
    - `strict_top_priority_block`
- Replay settlement mode is visible in the final report:
  - it prefers explicit recorded resolution events
  - it can fall back to placeholder end-time settlement if `SETTLEMENT_ALLOW_PLACEHOLDER_FALLBACK=true`
- Replay also reports:
  - explicit resolution events ingested
  - provenance breakdown
  - trustworthy vs untrustworthy explicit events
  - whether the session used only placeholder fallback
  - open positions blocked on missing trustworthy settlement data
  - current day bucket start/end
  - rollover count and bucket summaries
  - unresolved aging stats
  - top unresolved markets by oldest stuck exposure
  - execution damage breakdown by type
  - execution-attempt terminal states and transition-reason counts

## Stranded Damage Lifecycle

- Stranded damage is tracked separately from portfolio positions.
- Damage states are:
  - `detected_damage`
  - `open_damage`
  - `resolved_damage`
  - `expired_damage`
- Stable primary damage types are:
  - `leg_a_only`
  - `leg_b_only`
  - `partial_fill`
  - `stale_execution`
  - `invalidated_opportunity`
  - `queue_limited_partial_fill`
- Damage records also carry machine-readable flags when useful, for example:
  - `invalidated_opportunity`
  - `queue_limited_partial_fill`
  - `stale_execution`
- Resolution rule in this phase:
  - replay resolves open damage at replay lifecycle end with `replay_session_end_summary`
  - paper leaves damage open unless `STRANDED_DAMAGE_REPORTING_WINDOW_MS` expires it with `reporting_window_elapsed`
- Important:
  - stranded damage is not a hedged position
  - no recovery or hedge-out behavior exists yet
  - no mark-to-market exists for damage records

## Execution Adapter Boundary

- Execution adapters live under `src/live/`.
- Implemented modes:
  - `dry_run_stub`
  - `replay_simulated`
  - `future_live_clob`
- Current behavior:
  - `dry_run_stub` accepts requests and records placeholder order statuses without placing orders
  - `replay_simulated` accepts requests as replay-scaffold events; replay engine remains fill authority
  - `future_live_clob` is scaffold only and denies submissions
- Safety env vars:
  - `EXECUTION_MODE`
  - `LIVE_EXECUTION_ENABLED`
  - `EXECUTION_KILL_SWITCH`
- Important:
  - no adapter in this phase talks to authenticated trading endpoints
  - no code path in this phase can submit a real order
  - adapter summaries are for boundary visibility only, not exchange reconciliation

## Order Lifecycle Model

- Order lifecycle lives under `src/live/orderLifecycle.ts`.
- It is separate from the execution-attempt state machine:
  - execution attempts track the high-level arb attempt lifecycle
  - order lifecycle tracks per-leg order objects that would sit behind an adapter
- Order lifecycle states are:
  - `created`
  - `submit_requested`
  - `submit_denied`
  - `submitted`
  - `acknowledged`
  - `open`
  - `partially_filled`
  - `filled`
  - `cancel_requested`
  - `cancelled`
  - `expired`
  - `rejected`
  - `reconciliation_pending`
  - `reconciled`
- Stable transition reasons currently include:
  - `order_created_from_execution_request`
  - `submit_requested_by_adapter`
  - `submit_denied_execution_kill_switch`
  - `submit_denied_live_disabled`
  - `submit_denied_live_not_implemented`
  - `submitted_by_dry_run_stub`
  - `submitted_by_replay_simulated`
  - `acknowledged_by_stub`
  - `opened_by_stub`
  - `partially_filled_by_replay_simulation`
  - `filled_by_replay_simulation`
  - `cancel_requested_by_adapter`
  - `cancelled_by_stub`
  - `expired_by_stub_timeout`
  - `rejected_by_stub`
  - `reconciliation_requested`
  - `reconciled_by_stub`
- Current adapter behavior:
  - `dry_run_stub`
    - records placeholder submit/open/reconciliation flow
    - never submits anything externally
  - `replay_simulated`
    - records placeholder order submission/open states
    - consumes replay-generated simulated fills/rejects/expiries into order lifecycle records
    - replay remains the fill authority
  - `future_live_clob`
    - always denies submission
- Order lifecycle summaries currently include:
  - orders by terminal state
  - transition reason counts
  - submit denied count
  - reconciliation pending count
  - average order lifetime
- Important:
  - this is still not exchange reconciliation
  - no exchange order ids or authenticated order queries exist yet
  - no retry logic exists yet

## External Reconciliation Model

- External reconciliation models live under `src/live/`.
- This model is separate from:
  - execution attempts
  - order lifecycle storage
  - replay fill simulation
  - portfolio accounting
- Current external reconciliation concepts include:
  - `ExternalOrderSnapshot`
  - `ExternalFillSnapshot`
  - `ExternalExecutionSnapshot`
  - raw snapshot ingestion shapes for orders, fills, and execution snapshots
  - `ReconciliationInput`
  - `ReconciliationDiff`
  - `ReconciliationIssue`
  - `ReconciliationResult`
- Optional external identifier fields now modeled include:
  - `externalOrderId`
  - `externalExecutionId`
  - `externalFillId`
  - `venueOrderRef`
- Stable snapshot provenance values currently include:
  - `synthetic_test_snapshot`
  - `replay_generated_snapshot`
  - `future_external_api_shape`
- Stable reconciliation issue types currently include:
  - `status_mismatch`
  - `fill_quantity_mismatch`
  - `fill_price_mismatch`
  - `missing_external_order`
  - `unexpected_external_order`
  - `missing_external_order_id`
  - `stale_external_snapshot`
  - `unresolved_reconciliation_state`
- Current adapter behavior:
  - `dry_run_stub`
    - accepts reconciliation input
    - records a noop reconciliation result only
  - `replay_simulated`
    - accepts synthetic external snapshots
    - compares them against internal order lifecycle records and fill events
    - can ingest raw synthetic/external-style snapshot payloads through the normalization layer
  - `future_live_clob`
    - remains noop/deny-only
- Reconciliation reporting currently includes:
  - issue counts by type
  - matched vs mismatched orders
  - missing external orders
  - unexpected external orders
  - missing external order ids
  - stale snapshot warnings
  - unresolved reconciliation counts
  - snapshots ingested by provenance
  - snapshots missing external identifiers
  - malformed snapshot reject counts
  - normalization warning counts
- Important:
  - this is still fully non-live
  - no authenticated exchange snapshot source exists
  - no external order ids are sourced from a venue
  - reconciliation output is a structured comparison result, not venue truth
  - normalization never invents missing external identifiers

## Execution Attempt Lifecycle

- Replay and paper both emit execution-attempt records.
- State machine states are:
  - `detected`
  - `queued_for_execution`
  - `leg_a_pending`
  - `leg_a_filled`
  - `leg_a_failed`
  - `leg_b_pending`
  - `leg_b_filled`
  - `leg_b_failed`
  - `fully_filled`
  - `partially_filled`
  - `failed`
  - `invalidated`
  - `expired`
- Transition reasons are machine-readable and stable.
- Replay:
  - uses scheduled execution timestamps
  - advances leg states from replayed book data
  - can expire an attempt when it times out before completion
- Paper:
  - uses the same execution-attempt model for audit and reporting consistency
  - still executes through the simpler atomic simulated-fill path
  - does not apply replay-only queue/depth logic as separate live leg attempts
- Important:
  - an execution terminal state is not the same thing as a portfolio position state
  - stranded one-leg outcomes are still tracked as execution damage only

## Position Lifecycle Assumptions

- A simulated full-set fill opens an explicit position.
- Position states are explicit:
  - `pending` reserved for future execution integration
  - `open` for an active simulated position
  - `resolved` after deterministic settlement
- Settlement trigger:
  - driven by the settlement source, not by portfolio code directly
- Settlement modes:
  - `explicit_recorded_resolution_event`
  - `placeholder_end_time_full_set_assumption`
- Paper mode:
  - currently uses `placeholder_end_time_full_set_assumption`
- Replay mode:
  - prefers `explicit_recorded_resolution_event`
  - falls back to placeholder end-time settlement only if enabled
- Placeholder settlement payout:
  - assumed to be `1.0 * size` for a complete binary YES+NO set
- If neither explicit resolution data nor usable end time exists:
  - the position stays open
  - no automatic release occurs
  - the position is counted as having no trustworthy settlement path
- Unrealized PnL:
  - not currently marked to market
  - reported as unavailable rather than guessed

## Risk Engine Assumptions

- Stale data:
  - a quote is stale when `quoteAgeMs > QUOTE_STALE_MS`
- Daily loss:
  - based on realized PnL only
  - current trading day is a fixed calendar day under `RISK_DAY_UTC_OFFSET`
  - block when `dailyRealizedPnl <= -RISK_MAX_DAILY_LOSS`
- Required liquidity:
  - measured only from top-of-book ask size on both legs
  - unknown ask size is treated as insufficient liquidity
  - this is a conservative gate, not proof of real executable depth
- Near resolution:
  - blocked when `seconds_to_resolution <= RISK_NO_TRADE_BEFORE_RESOLUTION_SEC`
- Exposure:
  - measured as gross locked notional capital across open simulated positions
  - per-market exposure uses the same gross-notional basis

## Useful Risk Env Vars

- `KILL_SWITCH_ENABLED`
- `RISK_MAX_NOTIONAL_PER_TRADE`
- `RISK_MAX_CONCURRENT_EXPOSURE`
- `RISK_PER_MARKET_EXPOSURE_CAP`
- `RISK_NO_TRADE_BEFORE_RESOLUTION_SEC`
- `RISK_MAX_DAILY_LOSS`
- `RISK_DAY_UTC_OFFSET`
- `SETTLEMENT_ALLOW_PLACEHOLDER_FALLBACK`
- `RESOLUTION_POLLING_ENABLED`
- `RESOLUTION_POLL_INTERVAL_MS`
- `RESOLUTION_REQUEST_TIMEOUT_MS`
- `PAPER_SUMMARY_INTERVAL_MS`
- `STRANDED_DAMAGE_REPORTING_WINDOW_MS`
- `OPEN_POSITION_AGE_THRESHOLDS_MS`
- `EXECUTION_LATENCY_MS`
- `LEG_EXECUTION_DRIFT_MS`
- `ORDERBOOK_STALENESS_TOLERANCE_MS`
- `MAX_BOOK_LEVELS_TO_SIMULATE`
- `ALLOW_MULTI_LEVEL_SWEEP`
- `DEPTH_SLIPPAGE_BUFFER_TICKS`
- `QUEUE_PRIORITY_MODE`
- `QUEUE_HAIRCUT_RATIO`
- `MIN_VISIBLE_SIZE_TO_ASSUME_FILL`
- `MAX_QUEUE_PENALTY_LEVELS`
- `PARTIAL_FILL_MODE`
- `SIM_PARTIAL_FILL_PROBABILITY`
- `EXECUTION_MODE`
- `LIVE_EXECUTION_ENABLED`
- `EXECUTION_KILL_SWITCH`
