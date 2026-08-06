# STATE.md

> Where the project is right now. Rewrite the top two sections whenever focus changes.
> History belongs in [DECISIONS.md](DECISIONS.md), not here — this file stays short.

**Last updated:** 2026-08-05

## Current focus

Cutting `main` down to a small system where every capability is real, ahead of moving the backend to FastAPI. ~11k lines → ~8k, with proof-of-effect on every device action.

## In flight

| Work | Where | Status |
|---|---|---|
| Proof-of-effect / execution envelopes | `main`, uncommitted (`src/lib/evidence.ts`, `scripts/local-agent.mjs`) | Done, smoke-tested |
| Simplification — deleted Slack OAuth, demo workspaces, Aside/Tensorlake/Okta/MDM, LLM risk judge, agent self-update | `main`, uncommitted | Done, build passes |
| `user_memory` — facts + episodes replacing Hyperspell | `main`, committed (`src/lib/memory.ts`, `m12`) | Code landed. **Verify `m12_user_memory.sql` is applied** before relying on memory |
| Single data store (drop `db.ts` in-memory fallback) | `main` | **Not started** — the last piece of the simplification |
| FastAPI backend port | `python-rebuild` branch | Not started against current main |
| UI rebuild — light two-audience surface (staff inbox + employee stepper) | `main`, uncommitted (`InboxView`, `TicketDetail`, `MyTicketView`, `ticket-view.ts`) | Done, typecheck clean, verified in browser |
| Demo data purge — one account, no seeded cast, no `demo-*` workspaces | `main` (`scripts/reset-workspace.mjs`, `seed.ts`) | Done, database reset |

## Next 3

1. **Apply `m12_user_memory.sql`, then land this as separate commits** (envelopes / simplification / memory) so any one can be reverted alone.
2. **Collapse `data.ts` to InsForge only** and delete `db.ts`. Every reader/writer is currently coded twice; governance precedent needs an in-process home first (or its own table).
3. **Tests for the safety rules.** `classifyPlan` risk tiers, `recordCleanExecution` promotion threshold, `extractJsonObject`, `classifyConfirmation`. All pure functions. Right now nothing stops a refactor silently auto-approving `ad.unlock_account`.

## Open questions

- **`.github/workflows/pdd-secrets-dispatch.yml`** — added by `prompt-driven-github[bot]`, not by hand. It sends all repo secrets to a `callback_url` supplied in the trigger payload. Keep, or delete and rotate secrets?
- ~~**Retrieval.** Nothing is shared across employees: a fix learned from one person's ticket does not help the next.~~ **Answered (m15):** `incident_memory` is the org-wide layer, and it is deliberately *not* pgvector. Retrieval is an equality match on a closed `IncidentCategory` set assigned by `classifyIncident()`, a pure function of the ticket text. That buys three things an embedding index does not: the category written at the end of a ticket is provably the one the next ticket reads (no drift between write and read paths), retrieval costs no embedding call on the critical path, and "we looked at 27 past VPN tickets" is an explainable answer. The open follow-up is whether the coarse buckets stay useful as volume grows, or whether some classes need splitting.
- **Safety tests were deleted.** `policy.test.ts` and `governance.test.ts` are staged as deleted. Nothing now covers `classifyPlan` risk tiers or `recordCleanExecution` promotion. Restore or replace?

## Known limitations (deliberate)

- In-memory graph checkpointer, trace store, and fleet — a process restart drops in-flight interrupts. Tickets persist via InsForge.
- Single global device-agent heartbeat — one live agent at a time, jobs are not routed per-device.
- No real Slack. The ticket thread inside the app is the conversation surface; there is no inbound webhook and no outbound API call.
- One directory account. There is no signup route, so new people are added by seeding or by writing the row directly.
- The device agent is copied to the machine by hand; there is no self-update channel and nothing serves it over HTTP.
