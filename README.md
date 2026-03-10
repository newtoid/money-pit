# polymarket-5m-maker

A TypeScript bot for Polymarket BTC Up/Down markets (auto-selected mode, or fixed `MARKET_SLUG`).

What it does:
- Auto-resolves market by mode:
  - `AUTO_MARKET_MODE=5m` -> latest BTC 5m
  - `AUTO_MARKET_MODE=hourly_updown` -> latest hourly BTC Up/Down
- Or uses fixed `MARKET_SLUG` if provided
- Maintains live market/user websocket connections
- Quotes YES-side orders around a fair value with risk controls
- Applies optional lag-arbitrage bias using spot BTC vs Polymarket implied move
- In bullish lag mode, follows a buy-first-then-sell-on-rise flow
- Uses a BTC-only runtime and dashboard controls

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
- Optional:
  - `AUTO_MARKET_MODE` for automatic market selection (`5m` or `hourly_updown`)
  - `MARKET_SLUG` to lock bot to a specific market

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
- `npm run backtest -- --input data/snapshots.jsonl` - replay lag-signal snapshots with conservative fills
- `npm run arb:scan` - run the read-only binary arbitrage scanner
- `npm run arb:paper` - run live paper trading on binary full-set arbitrage
- `npm run arb:replay -- --input data/recordings/session.jsonl` - replay recorded arb sessions

## Binary Arb Scanner

The repo now includes a separate read-only scanner under `src/arbScanner/` for binary-market box arbitrage:

- discover active binary markets from Gamma
- extract YES / NO token IDs defensively
- subscribe to live market data
- track YES best ask and NO best ask
- compute `edge = 1 - (yesAsk + noAsk + costBuffer)`
- log only opportunities above `MIN_EDGE`

Useful env vars:

- `MAX_MARKETS=100`
- `MIN_EDGE=0.01`
- `COST_BUFFER=0.00`
- `QUOTE_STALE_MS=5000`
- `MARKET_SLUG_FILTER=btc`
- `EVENT_SLUG_FILTER=...`
- `TAG_FILTER=...`
- `WATCHLIST_SLUGS=slug-a,slug-b`
- `FEE_COST_OVERRIDE=0.00` if you want to inject a fixed extra fee cost per complete set
- `ARB_RECORDER_ENABLED=true`
- `ARB_RECORDER_DIR=data/recordings`
- `RESOLUTION_POLLING_ENABLED=true`
- `RESOLUTION_POLL_INTERVAL_MS=30000`
- `RESOLUTION_REQUEST_TIMEOUT_MS=10000`
- `PAPER_SUMMARY_INTERVAL_MS=60000`
- `OPEN_POSITION_AGE_THRESHOLDS_MS=60000,300000,900000`
- `TRADE_SIZE=5`
- `SIM_SLIPPAGE_PER_LEG=0`
- `SIM_PARTIAL_FILL_RATIO=1`
- `PARTIAL_FILL_MODE=none`
- `SIM_PARTIAL_FILL_PROBABILITY=0.5`
- `SIM_REQUIRE_FULL_FILL=true`
- `SIM_REQUIRE_KNOWN_SIZE=true`
- `EXECUTION_LATENCY_MS=0`
- `LEG_EXECUTION_DRIFT_MS=0`
- `ORDERBOOK_STALENESS_TOLERANCE_MS=5000`
- `MAX_BOOK_LEVELS_TO_SIMULATE=5`
- `ALLOW_MULTI_LEVEL_SWEEP=true`
- `DEPTH_SLIPPAGE_BUFFER_TICKS=0`
- `QUEUE_PRIORITY_MODE=optimistic_visible_depth`
- `QUEUE_HAIRCUT_RATIO=0.5`
- `MIN_VISIBLE_SIZE_TO_ASSUME_FILL=1`
- `MAX_QUEUE_PENALTY_LEVELS=3`
- `PAPER_MAX_TRADES_PER_MARKET=1`
- `KILL_SWITCH_ENABLED=false`
- `RISK_MAX_NOTIONAL_PER_TRADE=25`
- `RISK_MAX_CONCURRENT_EXPOSURE=100`
- `RISK_PER_MARKET_EXPOSURE_CAP=25`
- `RISK_NO_TRADE_BEFORE_RESOLUTION_SEC=60`
- `RISK_MAX_DAILY_LOSS=0`
- `RISK_DAY_UTC_OFFSET=+00:00`
- `SETTLEMENT_ALLOW_PLACEHOLDER_FALLBACK=true`

Important caveat:

- Gamma metadata fields like `outcomes`, `clobTokenIds`, `fee`, and nested `events` / `tags` are parsed defensively because these payloads can drift.
- The scanner currently treats `COST_BUFFER` as the conservative all-in adjustment. It does not yet convert Gamma `fee` fields into a trusted per-share cost, because the raw fee field semantics are not stable enough here to do that safely without a dedicated fee lookup implementation.

Recorded arb sessions are JSONL and currently include:

- `session_start`
- `market_metadata`
- `ws_market`
- `book_top`
- `opportunity`
- `sim_fill`
- `position_open`
- `position_resolve`
- `resolution_event`

This is enough to rebuild top-of-book from raw websocket traffic or from normalized top-of-book snapshots, rerun the strategy, and simulate paper fills offline.

Explicit resolution ingestion now has a real recording path:

- live scan and paper modes poll Gamma market metadata for tracked market IDs
- when Gamma reports a tracked market as closed, the system normalizes that into a `resolution_event`
- the normalized event is recorded to JSONL and consumed by replay
- synthetic/manual `resolution_event` lines still work for tests, but they are no longer the main path

Current hard risk guards for replay and paper trading:

- kill switch
- max daily realized loss
- max notional per trade
- max concurrent gross open notional
- per-market gross open notional cap
- stale quote guard
- top-of-book ask-size guard on both legs
- no-trade window before market resolution

Replay execution realism assumptions:

- opportunity detection happens first
- replay then schedules leg A at `T + EXECUTION_LATENCY_MS`
- leg B is attempted after leg A with `LEG_EXECUTION_DRIFT_MS`
- execution timestamps are quantized to the next replayed market-data event, not an interpolated sub-event clock
- if the most recent book for a leg is older than `ORDERBOOK_STALENESS_TOLERANCE_MS`, that leg fails as stale
- when recorded raw `ws_market` payloads contain visible ask ladders, replay can sweep multiple ask levels per leg
- when a recording only contains `book_top`, replay falls back to a single visible level and cannot simulate meaningful depth
- delta-style top updates do not reconstruct a full ladder on their own, so depth replay is only as good as the recorded ladder snapshots
- queue realism uses only visible recorded depth; recordings do not contain true queue position or resting-order age
- partial fill modes are:
  - `none`
  - `probabilistic`
  - `liquidity_limited`
- queue modes are:
  - `optimistic_visible_depth`: visible size is treated as fillable
  - `conservative_queue_haircut`: visible size is discounted by `QUEUE_HAIRCUT_RATIO`, with stricter discounts on deeper levels
  - `strict_top_priority_block`: only the top visible level can fill, and only if it meets `MIN_VISIBLE_SIZE_TO_ASSUME_FILL`
- `probabilistic` mode uses a deterministic hash, not `Math.random`, so replay remains repeatable
- portfolio accounting only books the matched full-set size; unmatched leg exposure is reported as execution damage, not settled inventory
- visible depth is still only simulated visible liquidity, not proof of queue-priority fillability

Operator reporting now emphasizes current stuck state, not just aggregate totals:

- open positions count
- unresolved locked exposure
- open positions missing trustworthy settlement path
- locked exposure missing trustworthy settlement path
- oldest / newest / average open position age
- top unresolved markets by oldest stuck exposure
- current day bucket start/end and UTC offset
- rollover count plus denials before/after rollover
- settlement provenance coverage
- execution damage totals and damage by type

Execution lifecycle is now modeled explicitly before any live execution scaffolding:

- replay and paper both create an `ExecutionAttempt`
- the machine states are:
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
- transitions carry stable machine-readable reasons
- replay drives the machine from scheduled leg attempts, leg results, invalidation, and expiry
- paper uses the same abstraction for audit/reporting consistency while still following the simpler atomic paper-fill path
- stranded one-leg outcomes remain execution damage only; they are not promoted into portfolio positions

Current paper lifecycle assumptions:

- a simulated full-set entry opens an explicit position
- locked exposure is the entry all-in notional for that full set
- settlement is sourced through an explicit settlement-source abstraction
- supported settlement modes are:
  - `placeholder_end_time_full_set_assumption`
  - `explicit_recorded_resolution_event`
- paper mode currently runs in explicit placeholder mode:
  - `placeholder_end_time_full_set_assumption`
- replay prefers `explicit_recorded_resolution_event` when recorded, and only falls back to placeholder settlement if `SETTLEMENT_ALLOW_PLACEHOLDER_FALLBACK=true`
- replay reports whether it used only placeholder fallback
- placeholder settlement assumes a complete binary YES+NO set pays `1.0 * size` at market end time
- if no explicit resolution event exists and market end time is missing, the position remains open and unresolved
- unrealized PnL is not currently marked to market; only realized PnL after settlement is tracked
- daily loss uses realized PnL only within a fixed UTC-offset calendar day

`resolution_event` JSONL lines use:

```json
{
  "type": "resolution_event",
  "ts": 1710000300000,
  "resolution": {
    "marketId": "123",
    "resolvedAtMs": 1710000300000,
    "settlementStatus": "resolved",
    "settlementMode": "explicit_recorded_resolution_event",
    "payoutPerUnit": 1,
    "provenance": "recorded_external_resolution_source",
    "sourceLabel": "gamma_market_poll",
    "trustworthy": true,
    "rawSourceMetadata": {
      "resolvedAtMsDerivedFrom": "gamma_closed_time"
    }
  }
}
```

Stable provenance values:

- `synthetic_test_event`
- `recorded_external_resolution_source`
- `placeholder_end_time_assumption`

Stable source labels:

- `synthetic_manual_input`
- `gamma_market_poll`
- `placeholder_end_time_assumption`

Important settlement caveat:

- placeholder settlement is intentionally loud and marked untrustworthy
- open positions without a trustworthy settlement path are reported separately
- locked exposure tied up in those positions is reported separately so unresolved junk does not disappear into aggregate exposure

## Backtesting

The repo now includes a minimal replay harness for the current lag signal. It does not simulate queue priority or live websocket timing; it answers a narrower question first:

- if you buy on bullish lag setup
- and exit using the current profit / catch-up / force-flatten logic
- does the signal have positive expectancy after estimated fees?

Input format is JSONL, one snapshot per line. Each line needs:

```json
{"ts":1710000000000,"spotPrice":62000,"yesBid":0.49,"yesAsk":0.50,"noBid":0.50,"noAsk":0.51}
```

Nested `yes` / `no` objects also work:

```json
{"ts":1710000000000,"spot":62000,"yes":{"bid":0.49,"ask":0.50},"no":{"bid":0.50,"ask":0.51}}
```

Run it with your current env tuning:

```bash
npm run backtest -- --input ./snapshots.jsonl
```

Optional:

- `--market-duration-sec 300` to override the assumed market length
- env vars like `SIGNAL_K`, `BUY_MIN_LAG_BPS`, `TAKE_PROFIT_PCT`, `ESTIMATED_FEE_BPS`, etc. are read by the harness so you can test the same knobs you use live

Important limits:

- entry fills are modeled conservatively at the YES ask
- exits are modeled conservatively at the YES bid
- there is no maker queue simulation, partial fill simulation, or REST/ws desync simulation
- this is for signal validation, not full execution validation

## Snapshot Recording

You can now record live snapshots in the same JSONL shape the backtest script consumes.

Set:

- `SNAPSHOT_RECORDING_ENABLED=true`
- `SNAPSHOT_RECORDING_DIR=data/snapshots` (optional)
- `SNAPSHOT_RECORDING_MIN_INTERVAL_MS=250` (optional throttle)

When enabled, the bot writes throttled snapshots per market slug into `data/snapshots/*.jsonl` using:

- current spot price
- YES best bid / ask
- NO best bid / ask
- timestamp, market id, and slug

That gives you a direct loop:

1. run the bot with recording enabled
2. collect market sessions into JSONL
3. replay them with `npm run backtest -- --input ...`

## Core Runtime Modes

- `DRY_RUN=true`: decisions only, no orders posted
- `SIMPLE_MODE=true` (default): simpler runtime profile (single market, lag-arb off, layered exits off, no rolling/session buy brakes)
- `SIMPLE_MODE=false`: re-enable advanced behavior
- `TRADING_ENABLED=false`: disables live trading paths
- `TRADING_USE_SIGNER_AS_MAKER=true`: signer acts as maker
- `TRADING_USE_SIGNER_AS_MAKER=false`: uses funder/maker mode (`TRADING_FUNDER_ADDRESS`)

## Main Strategy Controls

- `ORDER_SIZE`, `HALF_SPREAD`
- `MAX_POSITION`, `MAX_INVENTORY_NOTIONAL_USDC`
- `TAKE_PROFIT_ENABLED`, `TAKE_PROFIT_PCT`
- `HARD_TAKE_PROFIT_PCT` (always exit when gain reaches this level; default `0.5` = +50%)
- `REQUOTE_TICK_THRESHOLD`, `MIN_REQUOTE_MS`, `FORCE_REQUOTE_MS`
- `BUY_WINDOW_SEC` (buy entries allowed only in this many seconds from market open)
- `LAG_TRADE_MODE` (`bullish_only`, `bearish_only`, `both`)
- `BUY_MIN_LAG_BPS` (minimum lag edge required to open buys)
- `ENTRY_ESTIMATED_ROUNDTRIP_COST_BPS`, `ENTRY_EXTRA_EDGE_BUFFER_BPS` (fee-adjusted lag requirement for entries)
- `ENTRY_MAX_YES_SPREAD_BPS` and `ENTRY_MAX_YES_SPREAD_TICKS` (skip entries when spread is too wide; ticks is usually better with 1-cent markets)
- `BUY_NO_CHASE_WINDOW_MS`, `BUY_NO_CHASE_MAX_UP_BPS` (skip buying into fast upward moves)
- `MAX_LOSS_PER_MARKET_USDC` (stop new buys once market-level loss limit is breached)
- `EXIT_LAYERED_ENABLED`, `EXIT_AGGRESSIVE_PCT`, `EXIT_AGGRESSIVE_TICKS` (faster two-step exits)
- `EXIT_USE_MARKET_ON_SIGNAL` (when exit triggers, use marketable sell/FAK for faster fills)
- `EXIT_FAST_UNDERCUT_TICKS`, `EXIT_MIN_PROFIT_TICKS` (faster exits while still requiring a small profit)
- `EXIT_CATCHUP_BUFFER_BPS` (extra tolerance for catch-up exit trigger against buy-time BTC target)
- `EXIT_ALLOW_PROFIT_BEFORE_CATCHUP` (allow profitable exits even if catch-up confirmation lags)
- `EXIT_FORCE_AFTER_HOLD_SEC` (force profitable exit after hold timeout)
- `EXIT_FAILSAFE_AFTER_FAILS`, `EXIT_FAILSAFE_EXTRA_TICKS` (more aggressive exits after repeated failures)
- `SESSION_MAX_CONSECUTIVE_LOSSES`, `SESSION_MAX_NET_LOSS_USDC` (session buy brakes)
- `LOSS_COOLDOWN_MARKETS_AFTER_LOSS` (skip next N full markets after a losing market)
- `ESTIMATED_FEE_BPS`, `ROLLING_EXPECTANCY_WINDOW`, `ROLLING_EXPECTANCY_PAUSE_BELOW_USDC`, `ROLLING_EXPECTANCY_REDUCE_SIZE_*` (expectancy-based pause/size reduction)
- `VENUE_MIN_ORDER_SIZE` (hard minimum size guard; default 5)
- `CLOB_LEDGER_MIN_INTERVAL_MS` (throttle for `/data/orders` lookups)
- `CANCEL_ALL_MIN_INTERVAL_MS` (throttle cancel-all cadence)
- `OPEN_ORDERS_RATE_LIMIT_BACKOFF_MS` (backoff after 429 / Cloudflare 1015)
- `NO_NEW_ORDERS_BEFORE_END`, `CANCEL_ALL_BEFORE_END`
- `FORCE_FLATTEN_ENABLED`, `FORCE_FLATTEN_BEFORE_END_SEC`, `FORCE_FLATTEN_ALLOW_LOSS`, `FORCE_FLATTEN_MODE`, `FORCE_FLATTEN_HARD_DEADLINE_SEC`

## Strategy In Plain English

This is how the bot behaves during normal operation:

1. It compares two trackers:
- BTC tracker: real-time BTC move from spot feed
- Polystorm tracker: Polymarket-implied move from market prices

2. If BTC tracker is higher than Polystorm tracker (bullish lag):
- The bot prioritizes **buying YES**
- It does **not** place normal sell quotes right away
- It requires fee-adjusted lag edge before buying (`BUY_MIN_LAG_BPS` + fee/buffer settings)
- It can block "chasing" after a quick pop (`BUY_NO_CHASE_*`)
- It can skip entries if spread is too wide (`ENTRY_MAX_YES_SPREAD_BPS` and/or `ENTRY_MAX_YES_SPREAD_TICKS`)

3. After it has bought YES, it waits for Polystorm YES price to rise:
- It records BTC move at buy time and waits for Polymarket implied move to catch up to that level
- If the YES bid rises above the bot's average entry price, it can sell to exit
- Existing take-profit logic can also trigger an exit if enabled
- It can undercut best bid by a small amount for faster fills, while still requiring a minimum profit in ticks (`EXIT_FAST_UNDERCUT_TICKS`, `EXIT_MIN_PROFIT_TICKS`)
- Exit can be layered: an aggressive first slice plus a remainder (`EXIT_LAYERED_*`)

4. If the rise has not happened yet:
- The bot keeps waiting instead of selling early

5. Near market end, it can switch to flatten mode:
- If enabled, it stops normal strategy logic and focuses on selling open YES inventory
- This is separate from "no new orders" and is meant to reduce leftover positions
- `FORCE_FLATTEN_MODE=protect_price` tries to avoid realizing losses while flattening
- `FORCE_FLATTEN_MODE=guarantee_flat` prioritizes exiting inventory before expiry
- In the final hard-deadline seconds (`FORCE_FLATTEN_HARD_DEADLINE_SEC`), it will prioritize getting flat.

6. Buys are limited to an early market window:
- `BUY_WINDOW_SEC` controls how long new buys are allowed after market start (default `180` = first 3 minutes).
- Sell/exit orders can still be placed after the buy window so inventory can be closed before expiry.

7. Session safety brakes:
- If losing streak/session loss limits are hit, the bot pauses new buys (`SESSION_MAX_*`).
- If rolling net after-fee round-trip expectancy degrades, it can reduce buy size or pause (`ROLLING_EXPECTANCY_*`).
- If a market closes net-negative, it can skip the next N markets (`LOSS_COOLDOWN_MARKETS_AFTER_LOSS`).

Simple example:
- Bot buys YES at average 0.52
- If market YES bid moves to 0.53+, exit condition is met
- If bid stays 0.52 or lower, bot holds and waits

## Limits In Dollars (Plain English)

These settings control how much the bot can buy and hold:

- `ORDER_SIZE`: how many shares it tries to buy per order.
- `MAX_POSITION`: the maximum number of YES shares it can hold.
- `MAX_INVENTORY_NOTIONAL_USDC`: the maximum approximate dollar value of held YES shares.

The bot stops buying when it hits either limit first:
- share limit (`MAX_POSITION`)
- dollar-value limit (`MAX_INVENTORY_NOTIONAL_USDC`)

With the example config in this repo:
- `ORDER_SIZE=5`
- `MAX_POSITION=10`
- `MAX_INVENTORY_NOTIONAL_USDC=5`

What that means:
- It buys in chunks of about 5 shares.
- It will not hold more than 10 shares.
- It will also stop if held position value reaches about $5.

Quick examples:
- If YES is $0.50:
  - 5 shares cost about $2.50
  - 10 shares cost about $5.00
- If YES is $0.60:
  - 5 shares cost about $3.00
  - 10 shares would cost $6.00, so the $5 value cap usually stops buys earlier
- If YES is $0.30:
  - 5 shares cost about $1.50
  - 10 shares cost about $3.00, so the share cap is reached first

Also:
- `MIN_ORDER_SIZE` prevents very tiny orders.
- `MIN_BUY_NOTIONAL_USDC` prevents buys that are too small in dollar value.

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

## Common Issues

- `insufficient collateral/allowance`:
  - wallet collateral or allowance too low for configured quote size
- Dashboard not updating after code changes:
  - another process may already be listening on `8787`

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

- `NO_NEW_ORDERS_BEFORE_END`: stop opening new BUY entries near the end.
- `FORCE_FLATTEN_ENABLED=true`: switch to exit-only behavior near the end.
- `FORCE_FLATTEN_BEFORE_END_SEC`: when forced flatten starts.
- `FORCE_FLATTEN_ALLOW_LOSS`: if true, flatten can sell below average entry price.
- `FORCE_FLATTEN_HARD_DEADLINE_SEC`: final seconds where bot prioritizes getting flat.

Important tradeoff:
- If `FORCE_FLATTEN_ALLOW_LOSS=false`, the bot protects against realized losses, but flattening is not guaranteed if price stays below entry.
- If `FORCE_FLATTEN_ALLOW_LOSS=true`, flattening probability is higher, but it may realize a loss.

### What should I watch on the dashboard?

- `lag` and `BULLISH YES` badge: confirms BTC tracker > Polymarket tracker setup.
- Inventory and average entry: confirms buy exposure exists.
- Sell/skip reasons in logs (for example `waiting_for_price_rise_exit`): confirms it is waiting for catch-up.

### Dashboard Cheat Sheet (Plain English)

- `equity(est)`: estimated total account value right now (`cash + inventory value`).
- `cash`: your current USDC balance.
- `inv(est)`: estimated value of open YES position at current fair price.
- `rolling gains/losses (1m/5m/15m)`: short-term change in estimated equity over those windows.
- `roundTrips`: completed buy-then-sell cycles.
- `wins/losses`: how many completed cycles finished positive vs negative.
- `winRate`: percentage of completed cycles that were wins.
- `marketsClosed`: number of markets the bot has handed off/closed.
- `flatOnHandoff`: percent of closed markets where inventory was fully flat at handoff.
- `leftoverMarkets`: number of markets that ended with leftover position.
- `Controls` card:
  - `Trading Enabled`: live start/stop switch for order placement.
  - `cooldown`: auto safety mode after a losing market; trading can show manual ON but effective OFF while cooldown is active.
- `Opportunity Replay`:
  - Chart markers show possible past buy/sell sequences under current rules.
  - Green dots are potential buys, red dots are potential sells.
  - This is educational replay logic (price-based), not actual executed fills.

### "Why No Trade" Terms (Plain English)

The `Why No Trade` card shows gate badges as `OK` or `BLOCKED`.

- `Lag`:
  - `OK` means lag edge is strong enough to consider a buy.
  - `BLOCKED` means BTC is not leading enough (or is leading the wrong way).
- `Spread`:
  - `OK` means bid/ask spread is within allowed limits.
  - `BLOCKED` means market is too wide/expensive to enter safely.
- `Trading`:
  - `OK` means runtime trading switch is enabled.
  - `BLOCKED` means manual stop or other runtime control is off.
- `Cooldown`:
  - `OK` means no post-loss cooldown is active.
  - `BLOCKED` means bot is intentionally skipping markets after a loss.
- `Flat`:
  - `OK` means no open YES inventory (eligible to open a new buy).
  - `BLOCKED` means already in a position and waiting to exit.
- `End Window`:
  - `OK` means market is not in buy-restricted near-expiry period.
  - `BLOCKED` means new buys are disabled near market end.

## DRY_RUN With Full Metrics

Use `DRY_RUN=true` to run the exact same decision logic without sending orders.

What still works:
- Signal/lag calculations
- Entry/exit gating logic
- Buy/sell intent decisions and skip reasons in logs/dashboard
- Risk guards that are based on market state (spread, lag, windows, time rules)

What does not happen in DRY_RUN:
- No live order placement, so no real fills
- Fill-based P/L/round-trip metrics do not evolve like live trading
- Loss-cooldown-after-market will generally not trigger without real realized outcomes

How to use this to your advantage:
1. Run DRY_RUN for multiple days and export logs.
2. Count how often entries were allowed vs blocked, and why.
3. Tune entry quality knobs (`ENTRY_*`, spread limits, no-chase) to reduce weak entries.
4. Only move to live once the decision stream is selective and stable across different days.

## Safety Notes

- Start with `DRY_RUN=true` until configs are validated.
- Keep order size/notional caps conservative.
- This is experimental trading software; losses are possible.
