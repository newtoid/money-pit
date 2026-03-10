# BOT_SPEC

## Objective

Build a conservative, testable Polymarket trading system in stages.

Priority order:

1. correctness
2. risk control
3. observability
4. replayability
5. safe execution

## Strategy Scope

Current strategy is binary full-set arbitrage only.

For a binary market, an opportunity exists only when:

`edge = 1 - (yes_ask + no_ask + fees + slippage + execution_buffer)`

Trade only when total all-in cost for the full mutually exclusive set is below `1`.

Out of scope for now:

- directional bets
- market making
- ML
- live order placement

## Non-Negotiable Rules

- Parse external API and websocket payloads defensively.
- Isolate fee logic; do not bury fee assumptions inside strategy logic.
- Treat partial fills as a first-class risk.
- Treat stale quotes as unsafe by default.
- Keep modules small and explicit.
- Prefer replayable JSONL recording over opaque logs.
- Record reasons for both actions and inactions.

## Current Phase

This repo currently implements:

- project structure aligned to staged development
- recorder for market metadata, websocket traffic, derived top-of-book, and opportunities
- replay/backtest skeleton with simulated execution assumptions
- deterministic risk engine shared by replay and paper trading
- explicit simulated position lifecycle with settlement and exposure release
- explicit settlement-source abstraction with visible fallback behavior
- trusted settlement-event ingestion path that records normalized `resolution_event` entries
- replay execution model with explicit detection latency, leg drift, and partial-fill modes
- replay depth-aware leg fills using visible ask ladders when recordings preserve them
- replay-only queue/fill-priority haircut model over visible depth
- operator reporting for unresolved exposure, day rollover, and execution damage
- explicit execution-attempt state machine shared by replay and paper paths
- explicit stranded-damage lifecycle separate from portfolio positions
- future live-execution abstraction boundary with non-live stub adapters only
- explicit non-live order lifecycle scaffolding behind the execution adapter boundary
- explicit external reconciliation model scaffolding behind the adapter boundary
- explicit external identifier and snapshot-ingestion scaffolding behind the reconciliation model
- explicit partial-identifier matching-rules scaffolding behind reconciliation
- explicit external-state reconciliation accounting refinements behind matching
- explicit internal external-identifier carriage plus richer synthetic reconciliation fixtures behind reconciliation
- explicit external account / balance reconciliation scaffolding behind the adapter boundary
- explicit raw external account snapshot ingestion / normalization scaffolding behind balance reconciliation
- explicit authenticated read-only venue integration scaffolding that fetches real venue data into existing normalization layers without enabling trading
- explicit real-data reconciliation probe/orchestration that runs authenticated read-only snapshots through existing normalization and reconciliation layers on demand
- explicit internal baseline export/capture scaffolding so reconciliation probes can consume repeatable internal baseline files without inventing internal truth
- explicit runtime-state baseline capture hooks so baseline export can populate order/fill baselines from existing internal runtime state where that state already exists
- explicit live-order submission scaffolding with deny-by-default guards and a safe probe path

Not yet implemented in this phase:

- live trading
- real order submission
- authenticated exchange reconciliation
- metrics pipeline
- real order submission

## Known Uncertainties

- Gamma `fee` field semantics are not treated as authoritative yet.
- Gamma `outcomes` and `clobTokenIds` are assumed to map YES/NO, but code falls back defensively if the mapping is ambiguous.
- Displayed top-of-book size is not assumed to be truly fillable liquidity.
- Stale data is currently defined as quote age above `QUOTE_STALE_MS`.
- Required liquidity is currently measured only from top-of-book ask sizes on both legs.
- Near resolution is currently defined as `seconds_to_resolution <= RISK_NO_TRADE_BEFORE_RESOLUTION_SEC`.
- Exposure is currently measured as gross locked notional capital across open simulated positions.
- Settlement is currently sourced from a placeholder full-set assumption:
  - supported modes are `placeholder_end_time_full_set_assumption` and `explicit_recorded_resolution_event`
  - paper mode currently uses the placeholder path for settlement decisions, but can record explicit external resolution events
  - replay prefers explicit recorded resolution events when present
  - if placeholder fallback is enabled and no explicit resolution event exists, a complete YES+NO set is assumed to pay `1.0 * size` at market end
  - if explicit resolution is unavailable and market end time is unavailable, the position remains open and unresolved
  - placeholder settlement is marked untrustworthy in logs and reports
  - explicit external resolution ingestion currently uses Gamma market polling and stable machine-readable provenance values
- Unrealized PnL is not currently marked to market.
- Daily loss is currently evaluated from realized PnL only.
- Daily boundary is a fixed calendar day under `RISK_DAY_UTC_OFFSET` (for example `+00:00`).
- Replay execution is event-quantized:
  - leg attempts happen on or after their scheduled timestamps when the next replay event arrives
  - unmatched legs are reported as execution damage, not promoted into portfolio positions
- Replay depth modeling is limited by recorded data:
  - raw `ws_market` events may preserve ladders for depth-aware replay
  - `book_top`-only recordings cannot support real depth sweep simulation
  - top-only deltas do not reconstruct a full ladder by themselves
- Queue realism is also limited by recorded data:
  - recordings do not contain true queue position
  - queue/fill-priority realism is a conservative haircut model over visible size, not a fill oracle
- Operator reporting must keep unresolved risk visible:
  - current open/unresolved counts
  - unresolved locked exposure
  - missing trustworthy settlement coverage
  - position aging
  - rollover bucket summaries
- Execution lifecycle modeling is explicit but still simplified:
  - replay and paper both create execution-attempt records
  - paper uses the same state machine for audit/reporting consistency, not because replay-only queue/depth behavior leaked into paper execution
  - paper still follows an atomic simulated-fill path
  - replay drives leg-by-leg states, invalidation, and expiry from simulated outcomes
  - stranded one-leg outcomes remain execution damage, not portfolio positions
- Stranded damage is now modeled explicitly:
  - damage states are `detected_damage`, `open_damage`, `resolved_damage`, and `expired_damage`
  - replay resolves open damage into a summarized loss bucket at replay lifecycle end
  - paper keeps damage open unless `STRANDED_DAMAGE_REPORTING_WINDOW_MS` expires it
  - stranded damage is auditable by record, type, state, age, and originating execution terminal state
- Execution adapter boundary is now explicit:
  - replay simulation remains the fill authority for replay
  - paper mode still uses local simulation for fills
  - `dry_run_stub` and `replay_simulated` adapters are implemented as non-live scaffolding only
  - `future_live_clob` is intentionally not implemented and must deny submissions
  - no code path in this phase submits a real order
- Live submission scaffolding is now explicit and remains non-executing:
  - it lives in a dedicated live-submission layer under `src/live/`
  - it defines explicit live submission request, guard, ack, result, and summary types
  - the future-live adapter can now construct live-style leg requests and evaluate machine-readable guards
  - required guard categories currently include:
    - `LIVE_EXECUTION_ENABLED=true`
    - `EXECUTION_KILL_SWITCH=false`
    - explicit live submission mode selection
    - explicit allowlisted market/asset checks when configured
    - explicit max order size cap
    - explicit environment confirmation when configured
  - even when every guard passes, the effective result in this phase is still deny-only with `live_submission_not_implemented_in_phase`
  - current stable live-submission modes are:
    - `disabled`
    - `future_live_clob_guarded`
  - current stable live-submission guard reasons include:
    - `live_execution_disabled`
    - `execution_kill_switch_enabled`
    - `live_submission_mode_not_selected`
    - `market_not_allowlisted`
    - `asset_not_allowlisted`
    - `order_size_above_cap`
    - `max_order_size_cap_missing`
    - `environment_confirmation_missing`
    - `live_submission_not_implemented_in_phase`
  - a safe manual probe now exists to exercise the denied path without placing orders
- Order lifecycle scaffolding is now explicit and separate from execution attempts:
  - execution attempts model the strategy-level arb attempt lifecycle
  - order lifecycle records model per-leg order objects that would sit behind the adapter boundary
  - order lifecycle lives under `src/live/` and is non-live only in this phase
  - `dry_run_stub` records placeholder submit/open/reconciliation states
  - `replay_simulated` records placeholder order submission plus replay-driven fill/reject/expire transitions
  - `future_live_clob` remains deny-only
  - no exchange acknowledgement or reconciliation source exists yet
- External reconciliation scaffolding is now explicit and separate from both execution attempts and order lifecycle:
  - reconciliation compares internal order records to external-style snapshots
  - supported concepts now include external order snapshots, external fill snapshots, reconciliation inputs, diffs, issues, and results
  - dry-run and deny-only adapters expose a noop reconciliation path
  - replay-simulated adapters can consume synthetic external snapshots for test reconciliation
  - no authenticated venue polling or exchange truth source exists yet
  - reconciliation results must be treated as model output, not venue truth
- External identifier and snapshot-ingestion scaffolding is now explicit:
  - external-style identifiers such as `externalOrderId`, `externalExecutionId`, `externalFillId`, and `venueOrderRef` are modeled as optional non-live fields only
  - a normalization layer converts raw synthetic/external-style snapshot inputs into reconciliation-ready snapshot types
  - stable provenance values currently include:
    - `synthetic_test_snapshot`
    - `replay_generated_snapshot`
    - `future_external_api_shape`
  - malformed or stale ingested snapshots are surfaced through explicit warnings or reject counts
  - no missing external ids are invented silently
- Internal external-identifier population scaffolding is now explicit:
  - internal order records can now carry optional `externalOrderId`, `externalExecutionId`, and `venueOrderRef`
  - internal fill records can now carry optional `externalFillId` plus related external order/execution refs
  - those internal ids are empty by default in normal runtime paths
  - synthetic tests and scaffolding can attach them explicitly with machine-readable provenance
  - current stable internal identifier provenance values are:
    - `none`
    - `synthetic_fixture`
    - `future_external_identifier_scaffold`
  - runtime code does not fabricate venue ids silently
- Partial-identifier reconciliation matching is now explicit:
  - matching rules live in a separate deterministic layer
  - precedence is explicit and machine-readable
  - ambiguous or conflicting matches remain unresolved instead of being guessed away
  - match outcomes and unmatched reasons are reported separately from normalization warnings
- External-state reconciliation accounting is now richer but still non-live:
  - matched orders can compare external fill count, average fill price, filled notional, status progression, and partial-fill state against internal accounting snapshots
  - insufficient accounting data is reported explicitly through skipped-field counts
  - reconciliation remains read-only and does not mutate portfolio or order state
- External account / balance reconciliation is now scaffolded separately and remains non-live:
  - it is separate from order lifecycle, matching, order-level reconciliation, and portfolio mutation
  - it compares explicit internal account snapshots to external-style account snapshots
  - current comparison fields are available balance, reserved balance, and total balance
  - missing external asset balances, unexpected external asset balances, stale account snapshots, and insufficient comparison coverage are surfaced explicitly
  - balance reconciliation remains read-only and does not mutate internal portfolio/accounting state
- Raw external account snapshot ingestion is now scaffolded separately and remains non-live:
  - it normalizes raw external-style account/balance payloads into the balance reconciliation snapshot types
  - it preserves provenance, source labels, freshness metadata, and raw source metadata
  - it warns or rejects malformed inputs explicitly
  - it never invents missing balance values or reserved-balance keys
  - current stable account-snapshot provenance values are:
    - `synthetic_test_account_snapshot`
    - `replay_generated_account_snapshot`
    - `future_external_account_api_shape`
- Authenticated read-only venue integration is now scaffolded and remains strictly non-trading:
  - it lives in a dedicated read-only integration layer and does not share submit/cancel paths
  - it may use authenticated CLOB reads for open orders, trades, and balance/allowance data only
  - strict safety gates require `LIVE_EXECUTION_ENABLED=false` and `EXECUTION_KILL_SWITCH=true`
  - fetched order/trade snapshots are normalized through the existing external snapshot ingestion path
  - fetched account balance data is normalized through the existing account snapshot ingestion path
  - current stable real-data provenance values are:
    - `real_readonly_clob_open_orders_trades_api`
    - `real_readonly_clob_balance_allowance_api`
  - current balance reads expose `balance` and `allowance`, but not authoritative reserved/total balance fields
  - missing reserved/total values remain explicit warnings instead of being invented
  - fetched data does not mutate internal accounting, order state, or portfolio truth
- Real-data reconciliation probe/orchestration is now scaffolded and remains strictly non-trading:
  - it is an on-demand orchestration path, not a live loop
  - it reuses the existing read-only fetch layer, order snapshot normalization, account snapshot normalization, order reconciliation, accounting comparison, and balance reconciliation modules
  - it can run with optional internal baseline JSON files for order/account comparison
  - if no internal baselines are provided, it still runs and reports missing/partial comparison coverage explicitly
  - it can emit a structured JSON result to disk
  - it does not mutate internal accounting or portfolio state
  - it does not enable any submit/cancel capability
- Internal baseline export/capture is now scaffolded and remains strictly non-trading:
  - it lives in a separate internal-baseline layer
  - it exports explicit combined and split JSON baseline files for orders, fills, and account state
  - current baseline provenance values are:
    - `manual_internal_baseline_export`
    - `empty_internal_baseline_export`
    - `future_runtime_internal_baseline_capture`
  - if no internal source inputs are provided, the exporter writes an explicit empty baseline and reports missing sections
  - if a runtime capture file exists, `baseline:export` can now consume it automatically and preserve `future_runtime_internal_baseline_capture` provenance
  - current runtime capture sources are:
    - execution-adapter order lifecycle state
    - execution-adapter fill-event state
    - paper-trader runtime metadata only
  - current runtime account/balance capture is still unavailable and remains explicit/missing
  - runtime capture provenance is distinct from empty scaffolds and manual baseline files
  - the real-data reconciliation probe can now consume:
    - `--baseline <combined-file>`
    - `--order-baseline <orders-file>`
    - `--account-baseline <account-file>`
  - no internal identifiers are fabricated
  - exporting a baseline does not mutate internal portfolio/accounting state
- Synthetic reconciliation fixture coverage is now richer:
  - full external-id matches
  - partial-id matches and partial-id insufficiency
  - conflicting identifiers
  - duplicate external identifiers
  - missing identifiers with otherwise valid accounting fields
  - differing fill/event shapes for partial fills
  - status progression disagreement with otherwise comparable quantities
  - account/balance fixtures for matching balances, mismatched balances, missing assets, unexpected assets, partial coverage, and stale snapshots
  - raw account-ingestion fixtures for valid complete inputs, valid partial inputs, malformed inputs, stale inputs, and missing key balance fields
