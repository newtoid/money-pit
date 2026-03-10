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

### Carry future external identifiers explicitly on internal records, but never fabricate them in runtime

Reason:

- reconciliation needs a clean place for future venue ids to live once real venue-facing plumbing exists
- test and synthetic reconciliation coverage needs those ids now
- inventing fake runtime venue ids would create false confidence and blur synthetic vs future-real state

Consequence:

- internal order records now carry optional external order/execution refs plus provenance
- internal fill records now carry optional external fill refs plus provenance
- normal runtime leaves those fields unset with provenance `none`
- only explicit synthetic fixture/scaffold paths may attach synthetic ids
- reconciliation reports now surface internal identifier coverage and provenance counts

### Keep external account/balance reconciliation separate from order reconciliation and portfolio mutation

Reason:

- order-state reconciliation and account/balance reconciliation answer different operational questions
- balance comparison needs explicit missing-data handling instead of implicit portfolio updates
- no venue-truth account feed exists yet, so the first version must stay read-only and synthetic-input driven

Consequence:

- account/balance reconciliation now lives in its own module under `src/live/`
- adapters expose a separate non-live `reconcileAccountBalances(...)` path
- internal vs external balance snapshots are compared explicitly on available, reserved, and total balances
- missing asset rows, unexpected external asset rows, stale snapshots, and insufficient coverage are surfaced as machine-readable issues
- reconciliation does not mutate internal portfolio/accounting state

### Keep raw external account snapshot ingestion separate from balance reconciliation

Reason:

- malformed raw account payload handling is a normalization concern, not a balance comparison concern
- provenance, staleness-at-ingestion, and missing-key warnings need to stay visible even when no reconciliation is run
- future venue account API shapes may drift independently from the balance comparison model

Consequence:

- raw account ingestion now lives in `src/live/accountSnapshotIngestion.ts`
- adapters expose a separate non-live `ingestExternalAccountSnapshot(...)` hook

### Add authenticated venue connectivity only through a dedicated read-only layer with hard safety gates

Reason:

- this is the first phase allowed to touch real venue connectivity
- the system still must not be able to submit or cancel orders
- real fetched data is useful for testing normalization and reconciliation inputs before any live execution work

Consequence:

- authenticated venue connectivity now lives in a dedicated read-only module
- the read-only path only fetches open orders, trades, and balance/allowance data
- the safety contract is explicit:
  - `LIVE_EXECUTION_ENABLED` must remain `false`
  - `EXECUTION_KILL_SWITCH` must remain `true`
- fetched venue data is passed through the existing normalization layers instead of mutating internal truth directly
- real-data provenance values are distinct from synthetic fixture provenance values
- no submit/cancel path is added in this phase

### Orchestrate real-data reconciliation as an on-demand probe with optional internal baselines

Reason:

- authenticated read-only fetches are useful only if they can be pushed through the existing comparison layers
- the current reconciliation/accounting layers require explicit internal comparison views
- guessing internal baselines from live fetched venue data would blur external truth and internal truth

Consequence:

- real-data reconciliation now lives in a separate orchestration path, not inside strategy or execution code
- the probe reuses existing normalization and reconciliation modules instead of bypassing them
- internal order/account baselines are explicit optional JSON inputs
- when baselines are missing, the probe reports partial coverage and unexpected external state instead of fabricating matches
- the probe may write a structured JSON report, but it does not mutate internal state

### Export internal baselines as explicit files instead of inferring them inside reconciliation

Reason:

- the reconciliation probe needs repeatable internal comparison inputs
- internal and external truth must remain clearly separated
- the system does not yet have a persistent runtime baseline source that can be trusted automatically

Consequence:

- internal baselines now have an explicit combined export format plus split order/account files
- `baseline:export` writes machine-readable baseline files with provenance and capture timestamp
- if no internal inputs are available, the exporter writes an explicit empty baseline and reports missing sections
- `venue:reconcile` now accepts `--baseline`, `--order-baseline`, and `--account-baseline`

### Capture runtime baseline state at runtime shutdown instead of inferring it inside the exporter

Reason:

- runtime baseline export should be able to reuse real internal order/fill state when that state already exists
- the exporter should stay read-only and repeatable instead of trying to discover live in-memory state itself
- current runtime state exists behind the execution adapter order lifecycle store, but not as a general persistent internal ledger

Consequence:

- paper-run shutdown can now write a separate runtime baseline capture file
- the runtime capture preserves explicit provenance, source status, unavailable sources, and timestamps
- `baseline:export` can consume that runtime capture file automatically when no manual baseline file is supplied
- order and fill sections can now be populated from existing runtime state where available
- internal account/balance baseline remains explicitly unavailable until a trustworthy runtime account source exists
- reconciliation still never fabricates internal identifiers or internal balances
- normalization results record warning/reject information before any balance comparison happens
- balance reconciliation summaries now include account-ingestion provenance counts, malformed reject counts, stale-input counts, and normalization warning counts
- no missing balance values or reserved-balance keys are invented during normalization

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

### Add a future-facing execution adapter boundary before any live submission code

Reason:

- strategy, risk, replay, and portfolio logic need a clean seam before any real order code exists
- the project needs explicit request/result/status objects before wiring exchange APIs
- live behavior must remain impossible in this phase

Consequence:

- execution request/result/status objects now define the boundary between strategy code and any future exchange integration
- `dry_run_stub` and `replay_simulated` can be exercised safely in replay and paper without any authenticated trading calls
- `future_live_clob` stays deny-only until a later phase

### Keep order lifecycle separate from execution-attempt lifecycle

Reason:

- an arb execution attempt is a strategy-level concept, while per-leg order objects are a lower-level adapter concern
- future live trading will need explicit order histories, correlation ids, and reconciliation state without duplicating strategy state
- separating the two models now keeps replay/paper accounting readable and prevents live-facing concerns from smearing across portfolio or risk code

Consequence:

- order lifecycle now lives in `src/live/orderLifecycle.ts`
- stable order states and transition reasons are machine-readable and adapter-facing
- dry-run and replay-simulated adapters both populate order lifecycle records without placing orders
- replay remains the fill authority; the replay-simulated adapter only mirrors replay outcomes into order lifecycle records
- order lifecycle summaries now report terminal-state counts, transition-reason counts, submit-denied counts, reconciliation-pending counts, and average order lifetime

### Keep external reconciliation separate from order lifecycle and adapter submission logic

Reason:

- future venue/account reconciliation is a comparison problem, not an order-state mutation problem
- the system needs a clean place to represent external-style snapshots before any authenticated venue access exists
- dry-run and replay should be able to exercise reconciliation reporting without implying venue truth

Consequence:

- external reconciliation models now live under `src/live/`
- reconciliation compares internal order records against explicit external-style snapshot inputs
- supported mismatch categories are machine-readable and include status, fill quantity, fill price, missing external orders, unexpected external orders, stale snapshots, and unresolved reconciliation state
- stub adapters expose a noop reconciliation path
- replay-simulated adapters can consume synthetic external snapshots for tests and reporting
- no real exchange polling, authentication, or venue-side truth source exists yet

### Add a separate snapshot-ingestion normalization layer before any venue integration

Reason:

- external-style snapshots will arrive in raw shapes that should not be fed directly into reconciliation logic
- optional future-facing identifiers need to be modeled explicitly without implying they are available now
- malformed or stale inputs should be counted and surfaced instead of silently coerced into trusted state

Consequence:

- snapshot ingestion and normalization now live under `src/live/`
- raw ingestion shapes are separate from normalized reconciliation snapshot types
- optional external identifiers now include `externalOrderId`, `externalExecutionId`, `externalFillId`, and `venueOrderRef`
- stable provenance values are machine-readable and include:
  - `synthetic_test_snapshot`
  - `replay_generated_snapshot`
  - `future_external_api_shape`
- reconciliation summaries now include ingestion provenance counts, missing-identifier counts, malformed snapshot reject counts, stale-input counts, and normalization warning counts

### Add a separate deterministic matching-rules layer for partial identifiers

Reason:

- matching logic should not stay smeared across reconciliation diff code
- partial identifiers are inherently ambiguous and need explicit precedence plus explicit failure states
- the system should report why something did not match instead of silently guessing

Consequence:

- matching rules now live in their own layer under `src/live/`
- precedence is explicit and stable:
  - external order id
  - external execution id
  - external fill id where applicable
  - `(executionAttemptId, legId)`
  - internal correlation fallback
- ambiguity, conflicts, and duplicates remain machine-readable outcomes instead of implicit behavior
- reconciliation summaries now expose match counts by rule, unmatched counts by reason, ambiguous counts, conflicting identifier counts, and duplicate snapshot counts

### Keep richer accounting comparison separate from matching and internal state mutation

Reason:

- once matching exists, accounting comparison is a distinct read-only concern
- richer external-state comparison needs explicit coverage and skipped-field reporting instead of silent coercion
- reconciliation should not mutate portfolio or order state in this phase

Consequence:

- richer accounting comparison now lives as a separate layer under `src/live/`
- matched orders can compare fill count, filled notional, average fill price, status progression, and partial-fill state
- reconciliation summaries now expose accounting issue counts, comparison coverage counts, skipped-field counts, and agreement vs disagreement counts
- reconciliation remains non-live and non-mutating
