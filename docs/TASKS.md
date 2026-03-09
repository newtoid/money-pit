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
  - settlement at market end
  - realized PnL on settlement
  - exposure release on resolution
  - portfolio snapshot with gross exposure and per-market exposure

## Next Phase

- [ ] Extend risk engine:
  - max daily loss
  - configurable per-strategy no-trade mode overrides
  - richer portfolio state inputs
- [ ] Improve settlement realism:
  - explicit recorded resolution events when available
  - non-placeholder resolution source selection
  - handling for markets without trustworthy end/resolution metadata

## Later

- [ ] Add execution abstraction with order state machine.
- [ ] Add reconciliation hooks.
- [ ] Add compact summary metrics and alarms.
