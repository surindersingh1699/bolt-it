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

## 2026-08-05 — Runbooks removed; per-user memory is the only stored knowledge

The runbook library is gone: the seeded set, the auto-extracted entry per
resolved ticket, the `runbooks` table, the Runbooks tab, and the runbook dump in
the planner and verifier prompts. `Citation.source` is now `"memory"` only.

**Why.** Runbooks were a second knowledge system sitting beside `user_memory`,
and the seeded ones had drifted into instructing the planner to use capabilities
that no longer exist (Okta, MDM, Aside). One store, kept true, beats two where
one lies.

**Cost.** Nothing is shared across employees any more. A fix learned from one
person's ticket does not help the next — memory is keyed per user. Tier 1's
contract changes from "match a runbook or escalate" to "match this employee's
own history or escalate", which will escalate more often. On a novel ticket the
only grounding left is `kb.web_search` at tier 2+ and model priors.

**Reverses if.** Escalation rate at tier 1 turns out to be dominated by problems
another employee already had solved.

## 2026-08-05 — One seeded employee, not nine

`RAW_USERS` is Morgan Reilly alone; groups reduced to `everyone` and `it-staff`.

**Why.** Eight of the nine existed to dress a demo. Morgan is the one that cannot
be removed: `approveAndExecute` requires `isITStaff`, so without an IT-staff user
no high-risk step could ever be approved and the interrupt would never clear.

**Cost.** The seeded broken states are gone with bob/frank/eve, so
`ad.unlock_account`, `ad.reset_password` and `ad.refresh_kerberos` have no
account to act on until one is put into a broken state by hand.

## 2026-08-05 — Device work is judged by the device, not by the agent finishing

Every device job is probe → act → probe. The before/after diff is the verdict:
identical state on a fix is recorded `no_effect`, fails the step, and can never
be reported to the user as resolved. The full envelope (argv, exit codes,
stdout/stderr, both probes, the diff) is appended to a journal on the machine
itself before it is uploaded, so the trail survives the network and the server.

Reversing this means going back to trusting an agent's prose about its own work.

## 2026-08-05 — Deleted every adapter that had no real backend

Aside (browser actions), Tensorlake (sandbox), the Vercel-sandbox log reader,
and the Okta / MDM / identity.verify branches of the InsForge adapter were all
narration: sleeps plus log lines claiming work that never happened. They are
gone, along with the capabilities that referenced them. `ActionKind` is now
`device | backend | reply`, and the planner's capability list contains only
capabilities that are really implemented — so a fake plan cannot be drafted.

## 2026-08-05 — Slack OAuth and the demo-workspace flow removed

The in-app conversation thread (`SlackChat` + `chat.ts`) stays; the real Slack
install, events, callback and disconnect routes are gone, as are the demo
workspace minting/cookie/cron, the signup page, and the agent self-update +
`public/setup.ps1` (which served a file with the agent token embedded).

## 2026-08-05 — Hyperspell replaced by a `user_memory` table

Hyperspell's user context was a hardcoded mock map, and its memory search was
an external dependency for data we already own. Memory is now one small table:
keyed facts (nickname, office, timezone, device, …) upserted in place, plus one
episode per ticket. Written by an LLM extractor at finalize, read at draft.
LangGraph's own store was considered and rejected: it needs an embeddings model
for search and is lost on restart, which would have meant two memory systems.

## 2026-08-05 — Risk classification is an allowlist, no LLM judge

With ~10 real capabilities the judge was a moving part that could be wrong,
unavailable, or prompt-injected. `policy.ts` is now a lookup across low/medium/
high sets; anything unlisted is high risk and needs a human.
