# AGENTS.md

This repository uses multiple AI agents.

This repository interacts with financial markets.
Safety and observability must always be prioritized over speed.

Agents must read docs/PROJECT_MEMORY.md before proposing architectural changes or development phases.

---

## Architecture Review Agent

File: agents/architecture-review-agent.md

Role:
Reviews progress reports from implementation agents and determines whether the phase is correct, safe, and architecturally sound.

Responsibilities:
- review agent reports
- confirm phase completion
- identify risks
- recommend next phase
- generate next agent prompt

---

## Safety Gate Agent

File: agents/safety-gate-agent.md

Role:
Acts as a safety and release gate for anything related to live trading or live-capable behavior.

Responsibilities:
- validate kill-switch enforcement
- verify allowlists and caps
- ensure manual confirmation
- reject unsafe live trading capability
- approve or reject pilot commands
- verify safety posture before live-capable execution

---

## Operational Runbook Agent

File: agents/operational-runbook-agent.md

Role:
Produces exact, safe, operator-facing runbooks and command sequences for manual use.

Responsibilities:
- generate exact commands to run
- explain expected outputs
- explain success/failure signals
- define stop conditions
- define the next safe step
- keep read-only, pilot, and live-capable procedures clearly separated

---

## Workflow

Typical development cycle:

Implementation Agent
→ Architecture Review Agent
→ Safety Gate Agent
→ Operational Runbook Agent
→ Human/operator action

---

## Review Policy

- Implementation agents build.
- Architecture Review Agent evaluates correctness and recommends the next phase.
- Safety Gate Agent approves or rejects anything with live-capable implications.
- Operational Runbook Agent converts approved work into exact operator steps.
- No agent may imply autonomous trading unless explicitly implemented and approved.
- Live-capable behavior must remain manual, explicit, and observable unless a later phase explicitly changes that.

---

## Live-System Safety Rules

Never approve or operationalize real submission behavior unless all of the following are true:

1. LIVE_EXECUTION_ENABLED is explicitly set true
2. EXECUTION_KILL_SWITCH is explicitly set false
3. explicit pilot or allowed mode is selected
4. allowlisted market and asset are configured
5. max size cap is configured
6. explicit confirmation value is required
7. post-submit verification tooling exists
8. read-only venue integration exists
9. reconciliation tooling exists
10. the path is manual and one-shot, not autonomous

If any of these are missing, the safe default is deny.