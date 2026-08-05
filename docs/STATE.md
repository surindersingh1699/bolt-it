# STATE.md

> Where the project is right now. Rewrite the top two sections whenever focus changes.
> History belongs in [DECISIONS.md](DECISIONS.md), not here — this file stays short.

**Last updated:** 2026-08-04

## Current focus

Cleaning `main` down to code that can be read end-to-end, ahead of moving the backend to FastAPI.

## In flight

| Work | Where | Status |
|---|---|---|
| Repo cleanup — dead code, stale docs, Nia removal | `main`, uncommitted | Mostly done, see below |
| Proof-of-effect / execution envelopes | `main`, uncommitted (`src/lib/evidence.ts`) | In progress in a separate session |
| FastAPI backend port | `python-rebuild` branch | Not started against current main |

## Next 3

1. **Commit the cleanup and the envelope work separately.** Both are uncommitted in the same tree right now. Land them as two commits so either can be reverted alone.
2. **`.env.local.example`.** 20 keys are set locally, ~30 are referenced in code, and nothing documents them. Nobody else can run this repo today.
3. **Tests for the safety rules.** `classifyPlan` risk tiers, `recordCleanExecution` promotion threshold, `extractJsonObject`, `classifyConfirmation`. All pure functions. Right now nothing stops a refactor silently auto-approving `ad.unlock_account`.

## Open questions

- **`.github/workflows/pdd-secrets-dispatch.yml`** — added by `prompt-driven-github[bot]`, not by hand. It sends all repo secrets to a `callback_url` supplied in the trigger payload. Keep, or delete and rotate secrets?
- **Retrieval replacement.** Nia is gone from `main`. `python-rebuild` already has pgvector RAG. Does `main` need an interim replacement, or does it stay runbook-only until the port?

## Known limitations (deliberate)

- In-memory graph checkpointer, trace store, and fleet — a process restart drops in-flight interrupts. Tickets persist via InsForge.
- Single global device-agent heartbeat — one live agent at a time, jobs are not routed per-device.
- Inbound Slack (message → ticket) needs a public tunnel. Outbound works locally.
- Device-agent self-update is unsigned — trusted private network only.
