# Project Memory

This file defines the architectural intent and safety philosophy of the system.

All agents should read this file before proposing architectural changes or new phases.

---

# System Purpose

This repository implements a **carefully staged architecture for interacting with a prediction market venue (Polymarket CLOB)**.

The system is being built in **incremental safety phases**.

The goal is to reach a point where:

- venue interaction is observable
- reconciliation is reliable
- system state is reproducible
- pilot execution can be validated
- automated execution is only considered after extensive safeguards

---

# Development Philosophy

The system must always follow these principles:

1. **Safety over speed**
2. **Observability before automation**
3. **Manual tools before loops**
4. **Explicit state before inference**
5. **Reconciliation before trust**
6. **One-shot pilots before strategy execution**
7. **Session manifest updates must remain explicit and one-shot; no background process may mutate session state automatically.**

## Session Artifact Rules

Pilot session artifacts must remain explicit, append-only, and manually generated.

A pilot session may produce multiple artifacts:

- pilot result
- internal baseline snapshot
- verification result
- reconciliation output

These artifacts must be linked by a session manifest.

Session manifest updates must remain explicit and one-shot.  
No background process or loop may mutate session state automatically.

Artifacts may be appended later by manual tools (for example verification or reconciliation),
but the system must never silently modify a prior session.

---

# System Layers

The architecture is intentionally layered.

Agents should not collapse or bypass layers.

### 1. Snapshot Ingestion

External venue data is fetched and normalized.

Includes:

- order snapshots
- trade snapshots
- account snapshots

Normalization produces structured internal representations.

---

### 2. Internal Baselines

Internal system state can be exported as baselines:

- order baseline
- fill baseline
- account baseline

Baselines are used for reconciliation comparisons.

---

### 3. Reconciliation

The system compares:

- internal orders vs venue orders
- internal fills vs venue fills
- internal balances vs venue balances

This layer must remain **read-only**.

---

### 4. Runtime Baseline Capture

Execution adapters may capture runtime state.

Captured runtime state can populate baseline exports.

Account capture remains intentionally incomplete until a trustworthy ledger exists.

---

### 5. Read-Only Venue Integration

The system may fetch authenticated read-only data:

- open orders
- trades
- balance allowance

No venue writes occur here.

---

### 6. Pilot Submission

A one-shot pilot submission path exists.

This requires:

- explicit enablement
- kill switch disabled
- market allowlist
- asset allowlist
- max size cap
- explicit confirmation token

Pilot submission is **manual and single-shot**.

---

### 7. Post-Submit Verification

After a pilot submission, the system can:

- fetch venue state
- normalize snapshots
- reconcile against the pilot baseline
- report visibility limitations

Verification must remain **read-only and manual**.

---

# Explicitly Out of Scope (for now)

Agents must not introduce:

- autonomous trading loops
- retry logic for submissions
- automatic strategy execution
- portfolio mutation from venue responses
- inferred balances
- inferred fills
- inferred order state

---

# Expected Development Path

Future phases should focus on:

1. Observability improvements
2. Artifact persistence
3. Lifecycle visibility
4. Manual operational tooling
5. Safety improvements

Automation should be the **last phase**, not the next phase.

---

# Live Execution Safety Rules

Live interaction with the venue must always require:

- `LIVE_EXECUTION_ENABLED=true`
- `EXECUTION_KILL_SWITCH=false`
- explicit pilot mode
- allowlisted markets
- allowlisted assets
- max size cap
- confirmation token
- manual CLI invocation

If any of these are missing, submission must be denied.

---

# Agent Expectations

Agents must:

- preserve architecture layers
- maintain explicit safety gates
- prefer manual tooling over automation
- surface incomplete coverage rather than hiding it
- avoid inventing internal truth

Agents should never assume venue data is complete.

Partial visibility is expected and must be reported.