# DECISIONS.md

> Append-only. One entry per choice that is expensive to reverse.
> Newest first. Never edit an old entry — supersede it with a new one.
>
> Format: **date — decision.** Why. What it costs. What would reverse it.

---

## 2026-08-04 — Nia removed from `main`; no retrieval provider in its place

Deleted `nia.ts`, `nia-sources.ts`, `actions/sources.ts`, `ConnectDocsCard.tsx`, the `niaSources` workspace field, and `migrations/m10_nia_sources.sql`. Drafting now calls `aiGatewayDraft()` directly.

**Why.** Three drafting tiers (Nia → AI Gateway → keyword mock) meant no one could tell which produced a given plan. The Nia tier was gated behind `USE_NIA=1` and off in practice. The mock tier was 176 lines of canned per-tag templates. `python-rebuild` already has pgvector RAG, so the real replacement exists elsewhere.

**Cost.** `main` has no semantic retrieval — the LLM sees runbooks dumped into the system prompt, which does not scale past a few dozen runbooks.

**Reverses if.** Runbook count grows enough that prompt-stuffing degrades plan quality before the FastAPI port lands.

---

## 2026-08-04 — `Citation.source` renamed `"nia"` → `"runbook"`

**Why.** The citation always pointed at a runbook in our own database. It was named after the vendor that happened to retrieve it, so removing the vendor would have orphaned the name.

**Cost.** Any persisted ticket row with `citations[].source === "nia"` renders as an unrecognised source. Affects historical rows only.

---

## 2026-08-04 — Demo special-casing removed from the drafting path

`isDeterministicJudgeDemo()` routed any ticket containing `"cfo"`, `"board meeting"`, `"finance drive"`, or `"frank@acme.test"` to the canned mock planner instead of the LLM.

**Why.** A production code path branching on ticket text to force a rehearsed outcome invalidates every claim the README makes about the agent's reasoning. Rule 9 in CLAUDE.md now forbids it.

**Cost.** Demo scenario 8 (the governance arc) is no longer deterministic — it depends on live LLM output.

---

## 2026-08-04 — Docs split into `docs/`, milestone tracker retired

`ARCHITECTURE.md`, `PROJECT_STATE.md`, and `spec.md` described a system that no longer existed — a serial `executePlan` loop, a Convex schema file that had been deleted, and "no retry" when a 3-attempt replan loop was live.

**Why.** Stale docs are worse than absent ones; they get believed. Replaced with three files that have owners and update triggers: `docs/ARCHITECTURE.md` (what is), `docs/STATE.md` (what now), `docs/DECISIONS.md` (why).

**Cost.** Milestone history M1–M8 is only in git history now.

---

## 2026-08-04 — Backend will move to FastAPI on the `python-rebuild` foundation

Not a fresh rewrite. `python-rebuild` already carries FastAPI + LangGraph + Postgres/pgvector, Alembic migrations, a Postgres checkpointer, an append-only audit table, and real tests. Frontend stays Next.js and talks to it over HTTP.

**Why.** That branch already solves what `main` papers over: durable checkpoints (main loses in-flight interrupts on restart), a real audit trail, and tests.

**Cost.** `python-rebuild` is at main's M1-era feature level. The port is carrying five things across: per-step `interrupt()`, the verify/replan loop, governance auto-promotion, the device agent + fleet, and Slack/Hyperspell.

**Reverses if.** The feature gap turns out to be cheaper to close on `main` than to port.
