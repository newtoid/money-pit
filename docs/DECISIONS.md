# DECISIONS

## 2026-03-09

### Use TypeScript in the requested folder structure

Reason:

- the repo is already TypeScript-based
- `tsx` is already installed and used
- adding a parallel plain-JS runtime would increase drift instead of reducing it

Consequence:

- folder layout follows the requested design
- file extensions remain `.ts` instead of `.js`

### Keep live scanning and replay logic on shared core modules

Reason:

- replay is only trustworthy if it uses the same market-state and strategy code paths as live scanning

Consequence:

- `BookStateStore`, strategy evaluation, and execution simulation are shared
- recorder stores raw websocket payloads plus derived top-of-book to support multiple replay modes

### Do not trust Gamma raw fee fields yet

Reason:

- the field exists, but unit semantics are not stable enough here to safely convert into per-share all-in cost without dedicated validation

Consequence:

- fee handling is isolated in the fee adapter
- `COST_BUFFER` / `FEE_COST_OVERRIDE` remain the conservative live knobs for now

### Treat partial fills as a core failure mode

Reason:

- legging into one side of a full-set trade is one of the main practical risks

Consequence:

- execution simulation includes partial-fill assumptions explicitly
- replay reports partial-fill damage separately from aggregate PnL

### Make the risk engine a pure hard-decision gate

Reason:

- replay and paper trading need the same deterministic allow/deny logic
- risk decisions need to be auditable and machine-readable

Consequence:

- `evaluateTradeRisk(...)` is side-effect free
- callers receive stable `reasonCodes` plus numeric `details`
- callers are responsible for logging and acting on denials

### Measure exposure as gross locked notional

Reason:

- for full-set arb, the immediate risk budget is the capital locked into open positions, not directional delta

Consequence:

- concurrent exposure and per-market exposure caps use gross notional
- current exposure accounting is conservative but simple

### Use top-of-book ask size as a minimum liquidity gate only

Reason:

- top-of-book size is available now, but it is not reliable depth

Consequence:

- risk engine blocks trades if required size is missing on either ask leg
- docs explicitly note this is only a first-pass proxy, not proof of real fillability

### Settle paper full-set positions at market end using a `1.0` payout assumption

Reason:

- the current strategy only opens complete YES+NO binary sets
- that allows a simple deterministic settlement placeholder before live resolution sourcing exists

Consequence:

- realized PnL is booked only when the market reaches its end time
- locked exposure is released on resolution
- if market end time is missing, positions remain open and unresolved instead of being silently released

### Do not mark unrealized PnL yet

Reason:

- top-of-book only replay is not a credible mark-to-market source for locked full-set positions

Consequence:

- portfolio snapshot exposes `unrealizedPnlMarkedToMarket: null`
- realized PnL remains the authoritative accounting figure for now

### Use realized-PnL-only daily loss under a fixed UTC-offset calendar day

Reason:

- it is simple, deterministic, and easy to replay
- it does not require intraday mark-to-market assumptions that are not yet credible

Consequence:

- day rollover is controlled by `RISK_DAY_UTC_OFFSET`
- daily loss uses resolved-position PnL only
- this is conservative in that unresolved gains do not loosen limits
- this is blind in that unresolved losses do not tighten limits until settlement

### Introduce an explicit settlement-source abstraction with a loud placeholder fallback

Reason:

- settlement assumptions should not stay smeared across portfolio code
- replay needs a way to consume explicit resolution events when they exist
- placeholder settlement must remain visible and auditable when no explicit resolution data exists

Consequence:

- settlement logic now lives in `src/core/settlementSource.ts`
- supported settlement modes are:
  - `explicit_recorded_resolution_event`
  - `placeholder_end_time_full_set_assumption`
- paper mode currently uses placeholder settlement only
- replay prefers explicit recorded resolution events and falls back intentionally if `SETTLEMENT_ALLOW_PLACEHOLDER_FALLBACK=true`
- reports now surface unresolved positions, unresolved locked exposure, and open positions with no trustworthy settlement path

### Use Gamma market polling as the first trusted settlement-event ingestion path

Reason:

- replay needed a non-manual way to capture explicit `resolution_event` records
- current strategy only needs to know that a complete binary full set has resolved, not which leg won
- Gamma market metadata currently exposes enough closure fields to normalize a boring machine-readable settlement event

Consequence:

- scan and paper runs now poll Gamma for tracked market IDs
- normalized `resolution_event` records are written into recordings with stable provenance values
- `recorded_external_resolution_source` is used for Gamma-derived explicit events
- `synthetic_test_event` remains available for tests
- untrustworthy explicit events are never upgraded to trustworthy silently

### Keep replay execution modeling separate from portfolio accounting

Reason:

- execution risk and settlement/accounting are different concerns
- replay needed explicit leg timing and partial-fill outcomes without mutating portfolio rules

Consequence:

- replay now simulates leg A and leg B separately
- execution timing is controlled by `EXECUTION_LATENCY_MS`, `LEG_EXECUTION_DRIFT_MS`, and `ORDERBOOK_STALENESS_TOLERANCE_MS`
- partial-fill behavior is explicit through `PARTIAL_FILL_MODE`
- only matched full-set size is booked into the paper portfolio
- unmatched leg fills remain in replay metrics as execution damage, which is conservative but still approximate

### Prefer explicit operator summaries over aggregate-only reporting

Reason:

- aggregate realized PnL can hide stuck exposure and missing settlement coverage
- rollover behavior is easy to miss if day-bucket state is not surfaced directly

Consequence:

- replay and paper reporting now expose current day-bucket boundaries, rollover count, and bucket-level denial summaries
- unresolved positions are reported with age statistics and a top-N stuck-markets list
- execution damage is broken out by stable machine-readable categories instead of only one total

### Add depth-aware replay as a replay-only execution refinement

Reason:

- top-of-book-only replay understates fill cost and overstates executable size
- recorded raw websocket ladders are available often enough to improve realism without changing live code

Consequence:

- replay leg fills can now consume multiple visible ask levels
- depth behavior is controlled by `MAX_BOOK_LEVELS_TO_SIMULATE`, `ALLOW_MULTI_LEVEL_SWEEP`, and `DEPTH_SLIPPAGE_BUFFER_TICKS`
- if a recording only contains `book_top`, replay falls back to a single visible level and reports that limitation
- this still does not model queue priority or true executable liquidity

### Add a conservative replay-only queue haircut model

Reason:

- visible depth is not the same thing as fillable depth
- we do not have true queue-position data, so the first version should stay simple and pessimistic

Consequence:

- replay now supports:
  - `optimistic_visible_depth`
  - `conservative_queue_haircut`
  - `strict_top_priority_block`
- the queue model only discounts visible depth; it does not infer hidden microstructure state
- queue realism is deterministic and replay-only
- reports now show queue-limited no-fill/partial-fill counts and visible-to-fillable haircut metrics

### Add an explicit execution-attempt state machine before live execution scaffolding

Reason:

- replay execution had enough moving parts that terminal outcomes and timing needed an explicit lifecycle
- paper and replay both need the same audit vocabulary even though paper remains more atomic
- execution outcomes should stay separate from portfolio positions and settlement

Consequence:

- execution lifecycle now lives in `src/core/executionStateMachine.ts`
- stable execution states and transition reasons are machine-readable and reportable
- replay drives the machine from scheduled attempts, leg results, invalidation, and expiry
- paper also records attempts through the same abstraction so summaries stay aligned
- this is why replay-focused work still touches `paperTrader.ts`: shared execution-attempt accounting and reporting
- replay-only depth/queue behavior still does not execute inside paper mode
- stranded one-leg execution outcomes remain damage metrics, not portfolio positions

### Add a separate stranded-damage lifecycle instead of promoting stranded legs into positions

Reason:

- one-leg fills and partial execution damage are economically important, but they are not full-set arbitrage positions
- forcing them into the main portfolio lifecycle now would overstate how much the system actually knows how to manage
- operators still need explicit, auditable accounting for this damage state

Consequence:

- stranded damage now lives in `src/core/strandedDamage.ts`
- damage records carry explicit state, type, originating execution terminal state, age, and amount
- replay and paper share the same damage vocabulary
- replay resolves open damage into a summarized loss bucket at replay lifecycle end
- paper can optionally expire old damage records via `STRANDED_DAMAGE_REPORTING_WINDOW_MS`
- no hedge-out or recovery logic exists yet
