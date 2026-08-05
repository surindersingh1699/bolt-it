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
| `user_memory` — facts + episodes replacing Hyperspell | `main`, uncommitted (`src/lib/memory.ts`, `m12`) | Code done; **`m12_user_memory.sql` not applied yet** |
| Single data store (drop `db.ts` in-memory fallback) | `main` | **Not started** — the last piece of the simplification |
| FastAPI backend port | `python-rebuild` branch | Not started against current main |

## Next 3

1. **Apply `m12_user_memory.sql`, then land this as separate commits** (envelopes / simplification / memory) so any one can be reverted alone.
2. **Collapse `data.ts` to InsForge only** and delete `db.ts`. Every reader/writer is currently coded twice; governance precedent needs an in-process home first (or its own table).
3. **Tests for the safety rules.** `classifyPlan` risk tiers, `recordCleanExecution` promotion threshold, `extractJsonObject`, `classifyConfirmation`. All pure functions. Right now nothing stops a refactor silently auto-approving `ad.unlock_account`.

## Open questions

- **`.github/workflows/pdd-secrets-dispatch.yml`** — added by `prompt-driven-github[bot]`, not by hand. It sends all repo secrets to a `callback_url` supplied in the trigger payload. Keep, or delete and rotate secrets?
- **Retrieval.** `main` is runbook-only plus `user_memory` (keyed facts, no embeddings). `python-rebuild` has pgvector RAG. Does `main` need semantic search before the port, or is tag matching enough?

## Known limitations (deliberate)

- In-memory graph checkpointer, trace store, and fleet — a process restart drops in-flight interrupts. Tickets persist via InsForge.
- Single global device-agent heartbeat — one live agent at a time, jobs are not routed per-device.
- No real Slack. The "Chat" tab is the conversation surface; there is no inbound webhook and no outbound API call.
- The device agent is copied to the machine by hand; there is no self-update channel and nothing serves it over HTTP.
