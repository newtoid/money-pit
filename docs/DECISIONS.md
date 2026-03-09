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
