# polymarket-5m-maker

A TypeScript bot for Polymarket BTC 5-minute Up/Down markets.

What it does:
- Resolves the latest BTC 5m market (or uses `MARKET_SLUG` if provided)
- Maintains live market/user websocket connections
- Quotes YES-side orders around a fair value with risk controls
- Applies optional lag-arbitrage bias using spot BTC vs Polymarket implied move
- Supports dust sweeping, redeemables scanning, and manual redeem from dashboard

## Quick Start

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
- Copy/update `.env`
- Required for live trading:
  - `PRIVATE_KEY`
  - `POLYMARKET_CLOB_API_KEY`
  - `POLYMARKET_CLOB_SECRET`
  - `POLYMARKET_CLOB_PASSPHRASE`

3. Run:
```bash
npm run dev
```

4. Open dashboard:
- `http://localhost:8787`

## Scripts

- `npm run dev` - run with watch mode
- `npm run start` - run once
- `npm run auth:check` - verify CLOB auth configuration

## Core Runtime Modes

- `DRY_RUN=true`: decisions only, no orders posted
- `TRADING_ENABLED=false`: disables live trading paths
- `TRADING_USE_SIGNER_AS_MAKER=true`: signer acts as maker
- `TRADING_USE_SIGNER_AS_MAKER=false`: uses funder/maker mode (`TRADING_FUNDER_ADDRESS`)

## Main Strategy Controls

- `ORDER_SIZE`, `HALF_SPREAD`
- `MAX_POSITION`, `MAX_INVENTORY_NOTIONAL_USDC`
- `TAKE_PROFIT_ENABLED`, `TAKE_PROFIT_PCT`
- `REQUOTE_TICK_THRESHOLD`, `MIN_REQUOTE_MS`, `FORCE_REQUOTE_MS`
- `NO_NEW_ORDERS_BEFORE_END`, `CANCEL_ALL_BEFORE_END`

## Lag-Arb Overlay

Optional overlay that biases quotes based on spot BTC vs Polymarket implied move.

- `LAG_ARB_ENABLED`
- `LAG_ENTER_BPS`, `LAG_EXIT_BPS`
- `MAX_LAG_SKEW`
- `LAG_SIZE_MULT`
- `LAG_STALE_MS`
- `LAG_DISABLE_BEFORE_END_SEC`

Dashboard shows:
- live lag in bps
- lag chart
- lag regime badge (`BULLISH YES` / `BEARISH YES` / `NEUTRAL`)

## Dust + Redeemables

Dust sweeper:
- `DUST_SWEEPER_ENABLED`
- `DUST_SWEEPER_INTERVAL_MS`
- `DUST_SWEEPER_MAX_PER_CYCLE`
- `DUST_SWEEPER_MAX_NOTIONAL_USDC`
- `DUST_SWEEPER_ADDRESSES` (optional discovery list)

Redeemables:
- `REDEEMABLES_ENABLED`
- `REDEEMABLES_SCAN_INTERVAL_MS`
- `REDEEM_NOW_MAX`
- `REDEEMABLES_ADDRESSES` (optional scan list)
- `POLYGON_RPC_URL` (required for on-chain redeem)

Dashboard includes a `Redeem Now` button and redeem history table.

## Common Issues

- `insufficient collateral/allowance`:
  - wallet collateral or allowance too low for configured quote size
- Dashboard not updating after code changes:
  - another process may already be listening on `8787`
- Redeem RPC errors:
  - set a valid `POLYGON_RPC_URL` provider endpoint

## Safety Notes

- Start with `DRY_RUN=true` until configs are validated.
- Keep order size/notional caps conservative.
- This is experimental trading software; losses are possible.
