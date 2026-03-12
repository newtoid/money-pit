Definition of Done — Project Completion

This project is considered Done-Done when all of the following conditions are satisfied.

1. Architecture Integrity

The architecture defined in docs/PROJECT_MEMORY.md is preserved.

The system contains the following stable layers:

snapshot ingestion

baseline capture

reconciliation

runtime baseline capture

read-only venue integration

one-shot pilot submission

post-submit verification

pilot session artifact indexing

No layer bypasses another layer.

No hidden state mutation occurs.

2. Pilot Session Artifact System

Each pilot run must produce a complete session bundle.

A pilot session must generate:

session-manifest.json
pilot-result.json
internal-baseline.orders.json
verification-result.json (if run)
reconciliation-result.json (optional)

The session manifest must include:

session_id

timestamp

market

asset

submission parameters

external_order_id if returned

artifact file paths

terminal state

verification attached (true/false)

reconciliation attached (true/false)

The manifest must be append-only.

No background process may mutate it.

3. Reconciliation Reliability

The system must support running reconciliation against pilot sessions.

The following must work:

npm run venue:reconcile -- --order-baseline <file>

Reconciliation output must include:

fetch counts

normalization results

reconciliation issue counts

balance comparison results

coverage limitations

4. Verification Workflow

After a pilot order the system must support:

npm run live:verify-once

Verification must:

locate the pilot external order id

fetch read-only venue state

normalize snapshots

reconcile against the baseline

record visibility limitations

5. Operator Tooling

Operators must be able to run the entire workflow manually.

The following commands must function:

npm run auth:check
npm run baseline:export
npm run venue:readonly
npm run venue:reconcile
npm run live:submit-once
npm run live:verify-once

Optional but recommended:

npm run live:session-show
6. Safety Requirements

The system must enforce all safety gates.

Live submission must require:

LIVE_EXECUTION_ENABLED=true
EXECUTION_KILL_SWITCH=false
LIVE_ORDER_PILOT_ENABLED=true
LIVE_SUBMISSION_MODE=one_shot_live_pilot

The system must also require:

market allowlist

asset allowlist

max order size cap

explicit confirmation token

If any safety condition fails, submission must be denied.

7. Test Coverage

The following must pass:

node --import tsx --test tests/...

At minimum the test suite must cover:

reconciliation

snapshot ingestion

runtime baseline capture

live submission guards

pilot submission

post-submit verification

session artifact indexing

8. Documentation

The following documents must be accurate and current:

docs/PROJECT_MEMORY.md
docs/BOT_SPEC.md
docs/TASKS.md
docs/DECISIONS.md
docs/RUNBOOK.md

Docs must describe:

architecture

safety posture

pilot workflow

reconciliation workflow

artifact model

9. Reproducibility

Running the following sequence must produce deterministic artifacts:

npm run baseline:export
npm run venue:readonly
npm run venue:reconcile

Pilot runs must produce reproducible artifact bundles.

10. Explicit Non-Goals

The system is still considered Done even though the following are intentionally not implemented:

autonomous trading

retry loops

automated order management

portfolio mutation from venue responses

internal accounting ledger

continuous reconciliation polling

These are explicitly out of scope.

Final Acceptance Condition

The project is Done-Done when:

A pilot order can be submitted safely.

The order produces a session artifact bundle.

Post-submit verification can attach to that session.

Reconciliation can be run against that session.

All safety gates remain enforced.

The workflow is reproducible and operator-friendly.

At that point the system is a complete manual pilot trading framework.