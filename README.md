# polymarket-5m-maker

A TypeScript bot for Polymarket BTC 5-minute Up/Down markets.

What it does:
- Resolves the latest BTC 5m market (or uses `MARKET_SLUG` if provided)
- Maintains live market/user websocket connections
- Quotes YES-side orders around a fair value with risk controls
- Applies optional lag-arbitrage bias using spot BTC vs Polymarket implied move
- In bullish lag mode, follows a buy-first-then-sell-on-rise flow
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
- `FORCE_FLATTEN_ENABLED`, `FORCE_FLATTEN_BEFORE_END_SEC`, `FORCE_FLATTEN_ALLOW_LOSS`
- `FORCE_FLATTEN_MIN_INTERVAL_MS`, `RATE_LIMIT_COOLDOWN_MS`

## Strategy In Plain English

This is how the bot behaves during normal operation:

1. It compares two trackers:
- BTC tracker: real-time BTC move from spot feed
- Polystorm tracker: Polymarket-implied move from market prices

2. If BTC tracker is higher than Polystorm tracker (bullish lag):
- The bot prioritizes **buying YES**
- It does **not** place normal sell quotes right away

3. After it has bought YES, it waits for Polystorm YES price to rise:
- If the YES bid rises above the bot's average entry price, it can sell to exit
- Existing take-profit logic can also trigger an exit if enabled

4. If the rise has not happened yet:
- The bot keeps waiting instead of selling early

5. Near market end, it can switch to flatten mode:
- If enabled, it stops normal strategy logic and focuses on selling open YES inventory
- This is separate from "no new orders" and is meant to reduce leftover positions

Simple example:
- Bot buys YES at average 0.52
- If market YES bid moves to 0.53+, exit condition is met
- If bid stays 0.52 or lower, bot holds and waits

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

Behavior note:
- In `BULLISH YES`, strategy is buy-first then exit on Polystorm price rise.

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
- `POLYGON_RPC_URL` (single provider)
- `POLYGON_RPC_URLS` (optional comma-separated failover providers; preferred)

Dashboard includes a `Redeem Now` button and redeem history table.

## Common Issues

- `insufficient collateral/allowance`:
  - wallet collateral or allowance too low for configured quote size
- Dashboard not updating after code changes:
  - another process may already be listening on `8787`
- Redeem RPC errors:
  - set valid `POLYGON_RPC_URLS` (or at least `POLYGON_RPC_URL`) provider endpoint(s)

## FAQ (Plain English)

### Why does the bot buy first in `BULLISH YES`?

Because the strategy is trying to capture lag:
- It buys only when BTC tracker is higher than Polymarket tracker.
- That means BTC has moved first, and Polymarket is behind.

### Should sells happen after those buys?

Yes, that is the goal.
- The expected path is: BTC leads -> bot buys -> Polymarket catches up -> bot sells on the rise.
- In code terms, the exit can trigger when market YES bid rises above average entry (and take-profit can also exit if enabled).

### Why might a sell not happen immediately?

Common reasons:
- Polymarket has not caught up yet (no rise above entry yet).
- Price rose briefly but there was no fill at your posted sell price.
- Market is near end-of-window, so new quoting may be restricted by safety settings.
- Min order size / inventory constraints can delay or skip tiny exits.

### How do end-of-window settings work together?

- `NO_NEW_ORDERS_BEFORE_END`: stop normal quote placement near the end.
- `FORCE_FLATTEN_ENABLED=true`: switch to exit-only behavior near the end.
- `FORCE_FLATTEN_BEFORE_END_SEC`: when forced flatten starts.
- `FORCE_FLATTEN_ALLOW_LOSS=false` (default): do not force-sell below average entry.
- `FORCE_FLATTEN_MIN_INTERVAL_MS`: minimum delay between flatten attempts.
- `RATE_LIMIT_COOLDOWN_MS`: pause after 429/1015 rate-limit responses.

Important tradeoff:
- If `FORCE_FLATTEN_ALLOW_LOSS=false`, the bot protects against realized losses, but flattening is not guaranteed if price stays below entry.
- If `FORCE_FLATTEN_ALLOW_LOSS=true`, flattening probability is higher, but it may realize a loss.

### What should I watch on the dashboard?

- `lag` and `BULLISH YES` badge: confirms BTC tracker > Polymarket tracker setup.
- Inventory and average entry: confirms buy exposure exists.
- Sell/skip reasons in logs (for example `waiting_for_price_rise_exit`): confirms it is waiting for catch-up.

## Safety Notes

- Start with `DRY_RUN=true` until configs are validated.
- Keep order size/notional caps conservative.
- This is experimental trading software; losses are possible.
