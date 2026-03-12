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

## Read-Only Venue Probe

Run the authenticated read-only venue probe:

```bash
npm run venue:readonly
```

Required safety env vars:

- `LIVE_EXECUTION_ENABLED=false`
- `EXECUTION_KILL_SWITCH=true`

Read-only venue env vars:

- `READ_ONLY_VENUE_ENABLED=true`
- `READ_ONLY_VENUE_PRIVATE_KEY` or `PRIVATE_KEY`
- `READ_ONLY_VENUE_API_KEY` or `POLYMARKET_CLOB_API_KEY`
- `READ_ONLY_VENUE_API_SECRET` or `POLYMARKET_CLOB_SECRET`
- `READ_ONLY_VENUE_API_PASSPHRASE` or `POLYMARKET_CLOB_PASSPHRASE`

Optional read-only venue env vars:

- `READ_ONLY_VENUE_HOST`
- `READ_ONLY_VENUE_CHAIN_ID`
- `READ_ONLY_VENUE_LOG_LABEL`
- `READ_ONLY_VENUE_FETCH_OPEN_ORDERS`
- `READ_ONLY_VENUE_FETCH_TRADES`
- `READ_ONLY_VENUE_FETCH_ACCOUNT_BALANCES`
- `READ_ONLY_VENUE_OPEN_ORDERS_MARKET`
- `READ_ONLY_VENUE_OPEN_ORDERS_ASSET_ID`
- `READ_ONLY_VENUE_TRADES_MARKET`
- `READ_ONLY_VENUE_TRADES_ASSET_ID`
- `READ_ONLY_VENUE_BALANCE_TOKEN_IDS`

Current real-source provenance values:

- `real_readonly_clob_open_orders_trades_api`
- `real_readonly_clob_balance_allowance_api`

Important:

- this path is authenticated but read-only
- it must not be used to place or cancel orders
- fetched snapshots pass through the existing normalization layers only
- fetched data does not mutate internal accounting or portfolio state
- current balance/allowance reads do not provide authoritative reserved or total balances
- missing reserved/total fields are surfaced as warnings instead of being invented

## Real-Data Reconciliation Probe

Run the on-demand real-data reconciliation probe:

```bash
npm run venue:reconcile
```

Optional probe env vars:

- `REAL_DATA_RECONCILIATION_ENABLED`
- `REAL_DATA_RECONCILIATION_OUTPUT_PATH`
- `REAL_DATA_INTERNAL_BASELINE_PATH`
- `REAL_DATA_INTERNAL_RUNTIME_CAPTURE_PATH`
- `REAL_DATA_INTERNAL_ORDER_SNAPSHOT_PATH`
- `REAL_DATA_INTERNAL_ACCOUNT_SNAPSHOT_PATH`

Behavior:

- confirms read-only mode, `LIVE_EXECUTION_ENABLED=false`, and `EXECUTION_KILL_SWITCH=true`
- fetches authenticated read-only venue data
- reuses existing normalization layers
- runs order/account reconciliation only where normalized data exists
- prints a structured JSON result to stdout
- writes the same structured result to `REAL_DATA_RECONCILIATION_OUTPUT_PATH` if configured

Important:

- internal baselines are optional and explicit
- if no internal order baseline is provided, external orders will only surface as unexpected or unmatched
- if no internal account baseline is provided, external balances will only surface as unexpected or uncovered
- this probe does not mutate internal accounting or portfolio state
- this probe does not enable any trading capability

Example with explicit baseline files:

```bash
npm run venue:reconcile -- --order-baseline data/baselines/internal-baseline.orders.json --account-baseline data/baselines/internal-baseline.account.json
```

Example with a combined baseline file:

```bash
npm run venue:reconcile -- --baseline data/baselines/internal-baseline.json
```

## Internal Baseline Export

Export internal baseline scaffolding:

```bash
npm run baseline:export
```

Current default outputs:

- `data/baselines/internal-baseline.json`
- `data/baselines/internal-baseline.orders.json`
- `data/baselines/internal-baseline.account.json`

Optional flags:

- `--baseline <combined-input>`
- `--runtime-capture <runtime-capture-input>`
- `--order-input <orders-input>`
- `--account-input <account-input>`
- `--output <combined-output>`
- `--order-output <orders-output>`
- `--account-output <account-output>`
- `--source-label <label>`

Important:

- runtime capture can now be written separately from existing runtime state
- if `data/baselines/runtime-baseline.capture.json` exists, `baseline:export` will consume it by default unless `--baseline` is supplied
- with no manual inputs and no runtime capture file, it writes an explicit empty baseline and reports missing sections
- it never fabricates internal identifiers or balances
- it does not mutate strategy, portfolio, or execution state
- current runtime capture automatically populates:
  - order lifecycle state from the execution adapter
  - fill events from the execution adapter
- current runtime capture does not yet populate:
  - internal account/balance state

Runtime capture env vars for paper runs:

- `RUNTIME_BASELINE_CAPTURE_ENABLED`
- `RUNTIME_BASELINE_CAPTURE_PATH`

After a paper run, you can export from captured runtime state with:

```bash
npm run baseline:export
```

And then reconcile with explicit split baselines:

```bash
npm run venue:reconcile -- --order-baseline data/baselines/internal-baseline.orders.json --account-baseline data/baselines/internal-baseline.account.json
```

## Live Submission Probe

Run the deny-by-default live submission probe:

```bash
npm run live:submit-probe
```

Live-submission env vars:

- `LIVE_SUBMISSION_MODE`
- `LIVE_SUBMISSION_ALLOWLIST_MARKETS`
- `LIVE_SUBMISSION_ALLOWLIST_ASSETS`
- `LIVE_SUBMISSION_MAX_ORDER_SIZE`
- `LIVE_SUBMISSION_REQUIRED_CONFIRMATION`
- `LIVE_SUBMISSION_CONFIRMATION`

Important:

- this path is still non-executing
- no real submit or cancel call can succeed in this phase
- `LIVE_EXECUTION_ENABLED=false` and `EXECUTION_KILL_SWITCH=true` remain the safe defaults
- even if all guard checks pass, the probe still returns `live_submission_not_implemented_in_phase`
- the probe is only for validating guard posture and denied-result reporting

## One-Shot Live Order Pilot

Run the one-shot live pilot manually:

```bash
npm run live:submit-once -- --market <market-id> --asset <asset-id> --price <limit-price> --size <tiny-size> --tick-size <tick-size> --confirm <confirmation-value>
```

Pilot env vars:

- `LIVE_ORDER_PILOT_ENABLED`
- `LIVE_EXECUTION_ENABLED`
- `EXECUTION_KILL_SWITCH`
- `LIVE_SUBMISSION_MODE`
- `LIVE_ORDER_PILOT_ALLOWLIST_MARKETS`
- `LIVE_ORDER_PILOT_ALLOWLIST_ASSETS`
- `LIVE_ORDER_PILOT_MAX_ORDER_SIZE`
- `LIVE_ORDER_PILOT_CONFIRMATION_VALUE`
- `LIVE_ORDER_PILOT_RESULT_DIR`
- `LIVE_ORDER_PILOT_BASELINE_DIR`

Required safe posture for any real pilot attempt:

- `LIVE_ORDER_PILOT_ENABLED=true`
- `LIVE_EXECUTION_ENABLED=true`
- `EXECUTION_KILL_SWITCH=false`
- `LIVE_SUBMISSION_MODE=one_shot_live_pilot`
- requested market is in `LIVE_ORDER_PILOT_ALLOWLIST_MARKETS`
- requested asset is in `LIVE_ORDER_PILOT_ALLOWLIST_ASSETS`
- requested size is less than or equal to `LIVE_ORDER_PILOT_MAX_ORDER_SIZE`

Pilot outputs include:

- structured pilot result JSON
- internal order baseline JSON for follow-up reconciliation
- pilot session manifest JSON linking the session artifacts

## One-Shot Post-Submit Verification

Run one-shot read-only verification against a pilot result:

```bash
npm run live:verify-once -- --pilot-result <pilot-result.json>
```

Optional flags:

- `--order-baseline <orders.json>`
- `--account-baseline <account.json>`
- `--output <verification-output.json>`

Behavior:

- confirms read-only mode explicitly
- confirms `LIVE_EXECUTION_ENABLED=false` is required for the read-only fetch path
- confirms `EXECUTION_KILL_SWITCH=true` is required for the read-only fetch path
- loads the pilot result and optional baseline files
- performs a single read-only fetch for relevant orders, trades, and account/balance data
- reuses existing normalization and reconciliation layers
- prints a structured JSON verification result to stdout
- optionally writes the same result to `--output`

Reports include:

- whether the pilot external order id was found
- how many matching order and trade snapshots were visible
- whether the pilot baseline matched visible venue snapshots
- whether account/balance coverage was only partial
- explicit fetch, normalization, and reconciliation limitation counts

Important:

- this helper is manual and one-shot only
- it does not poll, retry, cancel, or submit orders
- it does not mutate portfolio or accounting state
- partial or missing venue visibility is expected and reported explicitly
- it now writes a default verification artifact under `data/pilots`, so the dashboard can show the latest verification status automatically

## Pilot Session Inspection

Show a pilot session manifest:

```bash
npm run live:session-show -- --session <pilot-session-id-or-manifest-path>
```

Behavior:

- loads the session manifest only
- prints the current linked artifact paths
- shows whether verification has been attached
- shows whether reconciliation has been attached
- shows which expected artifacts are still missing

Important:

- this helper is read-only
- it does not fetch venue data
- it does not submit, cancel, verify, or reconcile anything by itself

## Real-Data Reconciliation Attached To A Pilot Session

You can attach a reconciliation output to an existing pilot session explicitly:

```bash
npm run venue:reconcile -- --pilot-session <pilot-session-id-or-manifest-path> --order-baseline data/baselines/internal-baseline.orders.json --account-baseline data/baselines/internal-baseline.account.json
```

Behavior:

- runs the normal read-only reconciliation probe
- writes a reconciliation artifact
- attaches that artifact to the pilot session manifest
- does not mutate internal accounting or submit anything

## Dashboard Visibility

Start the main runtime dashboard:

```bash
npm run start
```

Open:

```text
http://localhost:8787
```

The dashboard now includes read-only cards for:

- latest live pilot result from `data/pilots/*.result.json`
- latest post-submit verification result from `data/pilots/*.verify.json`

Those cards are file-backed status only. They do not submit orders, trigger verification, or poll in the background.
- configured pilot max size is less than or equal to the hard-coded absolute pilot cap
- `--confirm` matches `LIVE_ORDER_PILOT_CONFIRMATION_VALUE`

Important:

- this path submits at most one explicit order per invocation
- no loops, retries, market making, or strategy orchestration exist here
- it writes:
  - a structured result JSON file
  - an internal order baseline JSON file
- the result includes an immediate follow-up reconciliation command when a baseline file is written
- it does not mutate internal portfolio/accounting state
- there is still no autonomous trading behavior

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
- Future live-submission guard env vars:
  - `LIVE_SUBMISSION_MODE`
  - `LIVE_SUBMISSION_ALLOWLIST_MARKETS`
  - `LIVE_SUBMISSION_ALLOWLIST_ASSETS`
  - `LIVE_SUBMISSION_MAX_ORDER_SIZE`
  - `LIVE_SUBMISSION_REQUIRED_CONFIRMATION`
  - `LIVE_SUBMISSION_CONFIRMATION`
- Important:
  - no adapter in this phase talks to authenticated trading endpoints
  - no code path in this phase can submit a real order
  - adapter summaries are for boundary visibility only, not exchange reconciliation
  - `future_live_clob` now records deny-only live-submission summaries:
    - attempts constructed
    - denied submission count
    - guard failure counts
    - configured safety posture
  - the one-shot live pilot is separate from this deny-only adapter path and requires its own explicit pilot mode and CLI invocation

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
- Read-only venue probe reporting currently includes:
  - successful fetch counts by endpoint
  - failed fetch counts by endpoint
  - normalization accepted/reject counts
  - normalization warning counts
  - provenance/source counts
  - stale-input warning counts
  - partial real-data warning counts
- Real-data reconciliation probe reporting currently includes:
  - read-only fetch counts and failures
  - normalization accepted/rejected/warning counts
  - reconciliation issue counts by type
  - balance reconciliation issue counts by type
  - match counts and unmatched counts
  - comparison coverage counts
  - provenance/source counts
  - explicit limitation counts for missing baselines and partial real-data coverage
- Internal baseline export reporting currently includes:
  - exported record counts by type
  - baseline provenance
  - capture timestamp
  - missing baseline sections
  - section source status
  - section source counts
  - output paths written
  - internal identifier coverage:
    - orders with external order ids
    - orders with external execution ids
    - orders with venue refs
    - orders with external fill ids
    - orders without external identifiers
  - internal identifier provenance counts
  - separate account/balance reconciliation summary:
    - balance issue counts by type
    - compared vs skipped assets
    - matched vs mismatched asset balances
    - stale account snapshot warnings
    - provenance/source counts
    - ingested raw account snapshots by provenance
    - malformed account snapshot reject counts
    - stale account snapshot input counts
    - account snapshot normalization warning counts
    - account snapshots missing key balance fields

## Internal External-Identifier Scaffolding

- Internal order lifecycle records can now carry optional future-facing external ids:
  - `externalOrderId`
  - `externalExecutionId`
  - `venueOrderRef`
- Internal fill records can now carry optional:
  - `externalFillId`
  - related external order/execution refs
- Stable internal identifier provenance values are:
  - `none`
  - `synthetic_fixture`
  - `future_external_identifier_scaffold`
- Important:
  - normal runtime does not fabricate these ids
  - synthetic fixture/test paths may attach them explicitly
  - reconciliation reporting now exposes how much internal state has identifier coverage vs none

## External Account / Balance Reconciliation

- Account/balance reconciliation lives separately from order-level reconciliation.
- It currently compares:
  - internal account snapshots
  - external-style account snapshots
- Current compared fields are:
  - `available_balance`
  - `reserved_balance`
  - `total_balance`
- Stable machine-readable balance issue types currently include:
  - `external_internal_available_balance_mismatch`
  - `external_internal_reserved_balance_mismatch`
  - `external_internal_total_balance_mismatch`
  - `missing_external_asset_balance`
  - `unexpected_external_asset_balance`
  - `stale_external_account_snapshot`
  - `insufficient_balance_comparison_coverage`
- Current adapter behavior:
  - `dry_run_stub`
    - records noop balance reconciliation results only
  - `replay_simulated`
    - accepts explicit synthetic internal/external account snapshots
    - records read-only balance comparison results
  - `future_live_clob`
    - remains noop/deny-only
- Important:
  - this does not mutate internal portfolio/accounting state
  - no authenticated account polling exists
  - no venue-truth account view exists
  - missing balance values are not invented
  - missing coverage is reported explicitly rather than guessed through

## Raw External Account Snapshot Ingestion

- Raw account snapshot ingestion lives separately from balance reconciliation.
- It accepts raw external-style inputs for:
  - account snapshot metadata
  - asset balances
  - reserved balances
- It normalizes those inputs into the `ExternalAccountSnapshot` type used by balance reconciliation.
- Stable raw account snapshot provenance values currently include:
  - `synthetic_test_account_snapshot`
  - `replay_generated_account_snapshot`
  - `future_external_account_api_shape`
- Current warning/reject behavior includes:
  - reject if `sourceLabel` is missing
  - reject if `capturedAtMs` is invalid
  - reject if both asset and reserved-balance payloads are missing
  - warn on missing asset symbols
  - warn on missing reserved-balance keys
  - warn on missing key balance fields
  - warn on invalid numeric fields
  - warn when the snapshot was already stale at ingestion time
- Current adapter behavior:
  - `dry_run_stub`
    - normalizes raw account snapshots
    - records noop balance reconciliation only
  - `replay_simulated`
    - normalizes raw account snapshots
    - stores normalization reporting without forcing a balance comparison
  - `future_live_clob`
    - normalizes raw account snapshots
    - records noop balance reconciliation only
- Important:
  - normalization is still fully non-live
  - no authenticated account source exists
  - no missing values are fabricated silently
  - warning/reject reporting is separate from balance mismatch reporting

## Synthetic Reconciliation Fixtures

- Synthetic reconciliation fixtures remain clearly non-live.
- They currently exercise:
  - full external-id matches
  - partial-id matches
  - insufficient-id unmatched cases
  - conflicting identifiers
  - duplicate external identifiers
  - missing identifiers with otherwise valid accounting fields
  - partial fills with differing fill/event shapes
  - status progression disagreement with otherwise comparable quantities
- Fixture provenance stays separate from future real-source concepts:
  - synthetic snapshots use `synthetic_test_snapshot`
  - future external-shape ingestion remains labeled `future_external_api_shape`
- Important:
  - this is still fully non-live
  - no authenticated exchange snapshot source exists
  - no external order ids are sourced from a venue
  - reconciliation output is a structured comparison result, not venue truth
  - normalization never invents missing external identifiers

## Matching Rules Layer

- Matching rules live separately from normalization and reconciliation diffing.
- Current deterministic precedence is:
  - `matched_by_external_order_id`
  - `matched_by_external_execution_id`
  - `matched_by_external_fill_id`
  - `matched_by_execution_attempt_leg`
  - `matched_by_internal_correlation`
- Current machine-readable unmatched/ambiguity/conflict outcomes include:
  - `unmatched_missing_identifiers`
  - `partial_identifier_insufficient`
  - `unmatched_ambiguous_candidates`
  - `conflicting_identifier_data`
  - `duplicate_external_snapshot`
  - `duplicate_internal_candidates`
- Important:
  - ambiguous cases remain unresolved
  - missing identifiers are not invented
  - no probabilistic or venue-inference matching exists in this phase

## External-State Accounting Comparison

- Accounting comparison lives separately from matching and normalization.
- Current machine-readable accounting mismatch types include:
  - `external_internal_fill_count_mismatch`
  - `external_internal_notional_mismatch`
  - `external_internal_avg_price_mismatch`
  - `external_internal_status_progression_mismatch`
  - `external_internal_partial_fill_mismatch`
- Current reporting includes:
  - accounting issue counts by type
  - comparison coverage counts
  - skipped accounting fields due to insufficient data
  - matched orders with accounting agreement
  - matched orders with accounting disagreement
- Important:
  - this is still comparison only
  - no portfolio/accounting mutation happens from reconciliation
  - missing external accounting fields stay missing and are reported as skipped coverage

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
