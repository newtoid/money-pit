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

## Position Lifecycle Assumptions

- A simulated full-set fill opens an explicit position.
- Position states are explicit:
  - `pending` reserved for future execution integration
  - `open` for an active simulated position
  - `resolved` after deterministic settlement
- Settlement trigger:
  - when `now >= market end time`
- Settlement payout:
  - currently assumed to be `1.0 * size` for a complete binary YES+NO set
- If market end time is missing:
  - the position stays open
  - no automatic release occurs
- Unrealized PnL:
  - not currently marked to market
  - reported as unavailable rather than guessed

## Risk Engine Assumptions

- Stale data:
  - a quote is stale when `quoteAgeMs > QUOTE_STALE_MS`
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
