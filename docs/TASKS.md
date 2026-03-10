# TASKS

## Current Phase

- [x] Create conservative project structure for staged development.
- [x] Add JSONL recorder for:
  - market metadata
  - websocket market payloads
  - derived top-of-book state
  - detected opportunities
- [x] Add replay/backtest skeleton that:
  - rebuilds market state
  - reruns strategy deterministically
  - simulates fills with slippage / partial-fill assumptions
  - reports core metrics
- [x] Add deterministic hard risk guards shared by replay and paper paths:
  - max trade notional
  - max concurrent exposure
  - per-market exposure cap
  - stale data guard
  - required-liquidity guard
  - kill switch
  - near-resolution no-trade guard
- [x] Add explicit simulated position lifecycle:
  - open position records
  - settlement through an explicit settlement source
  - realized PnL on settlement
  - exposure release on resolution
  - portfolio snapshot with gross exposure and per-market exposure
- [x] Add max daily loss guard to shared pure risk engine.
- [x] Improve settlement realism:
  - explicit recorded resolution events when available
  - visible placeholder fallback path
  - unresolved/trustworthiness reporting for locked exposure
- [x] Add trusted settlement-event ingestion:
  - Gamma-backed resolution polling for tracked markets
  - normalized `resolution_event` recording
  - provenance and trustworthiness reporting
- [x] Improve replay execution realism:
  - execution latency
  - leg-by-leg drift
  - stale orderbook tolerance
  - explicit partial-fill modes
  - execution outcome reporting
- [x] Add depth-aware replay realism:
  - multi-level visible ask consumption
  - configurable ladder depth limit
  - top-level vs multi-level fill reporting
  - depth-limited partial-fill reporting
- [x] Add replay-only queue / fill-priority realism:
  - visible-depth haircut modes
  - queue-limited fill reporting
  - visible-to-fillable haircut metrics
- [x] Polish unresolved-position and rollover reporting:
  - current-state summaries
  - unresolved aging
  - settlement coverage
  - day-bucket rollover visibility
  - execution damage breakdown
- [x] Add explicit execution-attempt state machine:
  - shared replay/paper execution-attempt records
  - explicit states and transition reasons
  - timeout / expiry handling
  - execution-state reporting
- [x] Harden stranded-leg lifecycle and damage accounting:
  - explicit stranded-damage records separate from positions
  - explicit damage states and machine-readable types
  - replay end-of-session resolution for damage records
  - optional paper reporting-window expiry
  - open/resolved/outstanding exposure reporting
- [x] Add live-execution scaffolding only:
  - explicit execution adapter interface
  - dry-run stub adapter
  - replay-compatible scaffold adapter
  - unsupported future live mode that stays inert
  - adapter-boundary logging and summaries
- [x] Add non-live order lifecycle scaffolding behind the execution adapter boundary:
  - explicit per-leg order lifecycle states and transition reasons
  - order lifecycle store with status history and timestamps
  - dry-run / replay-simulated / deny-only adapter wiring
  - order lifecycle summaries for terminal states, transition reasons, and reconciliation-pending counts

## Next Phase

- [ ] Add exchange reconciliation scaffolding on top of the non-live order lifecycle boundary.

## Later

- [ ] Add reconciliation hooks.
- [ ] Add compact summary metrics and alarms.
