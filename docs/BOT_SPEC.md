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

Not yet implemented in this phase:

- live trading
- order state machine
- reconciliation
- metrics pipeline

## Known Uncertainties

- Gamma `fee` field semantics are not treated as authoritative yet.
- Gamma `outcomes` and `clobTokenIds` are assumed to map YES/NO, but code falls back defensively if the mapping is ambiguous.
- Displayed top-of-book size is not assumed to be truly fillable liquidity.
- Stale data is currently defined as quote age above `QUOTE_STALE_MS`.
- Required liquidity is currently measured only from top-of-book ask sizes on both legs.
- Near resolution is currently defined as `seconds_to_resolution <= RISK_NO_TRADE_BEFORE_RESOLUTION_SEC`.
- Exposure is currently measured as gross locked notional capital across open simulated positions.
- Settlement is currently sourced from a placeholder full-set assumption:
  - if a complete YES+NO set is open at or after market end, total payout is assumed to be `1.0 * size`
  - if market end time is unavailable, the position remains open and unresolved
- Unrealized PnL is not currently marked to market.
