# IT Support Agent — bounded autonomy with structural human oversight

A LangGraph-orchestrated IT support agent that doesn't just run a plan — it **troubleshoots**: gathers context in parallel, drafts a plan with an LLM, classifies risk per step, pauses on a real graph interrupt before anything high-risk, executes on the user's actual machine through a local device agent, then **verifies from evidence whether the problem is really fixed and re-plans up to 3 attempts** before handing off to a human with a written troubleshooting record.

> **Branches:** `main` — this TypeScript/Next.js agent (the most advanced version).
> `python-rebuild` — a FastAPI/LangGraph-Python port of the same concept (pgvector RAG, Postgres checkpoints).

## The agent graph

```
            ┌─ gatherProfile (directory record) ───────┐
START ──────┼─ gatherMemory  (facts + past tickets) ───┤            (barrier join)
            └─ gatherDeviceContext (fleet + live agent)┴─► classifyRisk ─► persistPlan
                        └─► draftPlan (LLM) ────────────────┘                  │
                                                                               ▼
        ┌──────────────────────────── runNextStep ◄─────────────────┐   (execute loop)
        │   step needs human?  ──► interrupt() ── approve ──► resume┘
        │   step failed?       ──► escalate
        ▼
   verifyOutcome (LLM verdict from REAL machine output + company runbooks)
        │  not resolved & attempts < 3 ──► replan (new steps, same risk gate) ─► runNextStep
        ▼
   finalize ── troubleshooting record + memory written ── user confirms in chat
```

Key properties, all verified live:

- **Structural human oversight** — the approval gate is a LangGraph `interrupt()`; execution resumes from the paused step via `Command({resume})`, never restarts. Low/medium-risk steps run with zero clicks.
- **Learned trust (governance)** — every clean human approval of a capability accumulates precedent; after 3, that capability is auto-promoted out of the human gate (`src/lib/governance.ts`), with a hard `NEVER_AUTO_PROMOTE` floor. Promoted steps run with a visible "trusted · auto" badge.
- **Proof of effect on the device** — every device job is probe → act → probe. The agent reads machine state before and after, diffs it, and the diff is the verdict: identical state means the job is recorded `no_effect`, the step fails, and nothing is reported as fixed. A command the agent cannot really perform is recorded `simulated` instead of returning canned text as success.
- **A record on the machine itself** — each envelope (argv, exit codes, stdout/stderr, both probes, the diff) is appended to `C:\ProgramData\BoltIt\journal\*.jsonl` (Windows) or `~/.bolt-it/journal/*.jsonl` before it is uploaded, so the trail survives the network, the server, and the demo.
- **Evidence-based verification** — a fix step "succeeding" is not resolution. The verifier reads the device effect line (`VERIFIED CHANGE` / `NO EFFECT`) plus real machine output, the runbook library, the user's memory, and device context, and must cite which it used. `NO EFFECT` can never justify "resolved."
- **Honest by construction** — there is no adapter without a real backend. Every capability the planner can choose is really implemented; the ones that only narrated work (Okta, MDM, browser automation, sandbox diagnostics) were deleted rather than labelled.
- **Memory that persists** — keyed facts about a person (nickname, office, device, preferences) plus one line of history per ticket, extracted by the LLM when a ticket finishes and read back at planning time.
- **Full observability** — a per-ticket, node-level Agent Trace panel in-product, and per-ticket LangSmith runs (`ticket:<id>`).

## What's real vs simulated

| Layer | Status |
|---|---|
| LangGraph orchestration, interrupts, governance, troubleshooting loop | Real |
| LLM drafting + risk judge + verifier (OpenAI-compatible endpoint) | Real |
| Local device agent — restart app, clear cache (incl. Edge/Chrome), app status, app event logs, system info, adapter cycle (macOS + Windows) | Real execution, with before/after proof |
| VPN diagnostics, auth-log and Kerberos-log collection on the device | Not implemented — reported as `simulated`, never as done |
| AD account state (lock/unlock/reset/kerberos) + fleet health | Real state in our own database |
| User memory (facts + episodes), LangSmith tracing | Real, in our own database |


## Quickstart

```bash
pnpm install
pnpm dev                     # http://localhost:3000
```

Env (`.env.local`): `AI_GATEWAY_API_KEY` + `AI_GATEWAY_URL` (any OpenAI-compatible endpoint), `STRATEGIST_MODEL` / `OPERATOR_MODEL` / `COMMUNICATOR_MODEL` / `CHAT_MODEL`, `LANGSMITH_TRACING/API_KEY/PROJECT`, `LOCAL_AGENT_TOKEN`, InsForge keys.

Sign in at `/login`. The directory holds one real IT-staff account — there are no fictional colleagues. A fresh database seeds one admin from `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (see [src/lib/seed.ts](src/lib/seed.ts)); `node scripts/reset-workspace.mjs --yes` puts an existing database back to that state, wiping every ticket, job and workspace.

**Device agent** (the thing that actually touches machines):

```bash
LOCAL_AGENT_TOKEN=<token> node scripts/local-agent.mjs        # on this machine
```

For a Windows VM: run [scripts/vm/install-agent.ps1](scripts/vm/install-agent.ps1) once, elevated. After that the machine pulls the current agent from `GET /api/agent/script` (bearer-authenticated) on every start, relaunches it if it exits, and starts at logon — you never copy the file in or start it by hand again. See [WINDOWS_VM_DEMO.md](WINDOWS_VM_DEMO.md). Run **one** device agent at a time.

## Testing it

Ten rehearsed scenarios with exact trigger phrases, tiered by realness, in [DEMO_SCENARIOS.md](DEMO_SCENARIOS.md). The two most telling runs:

1. **Troubleshooting loop:** file "Notepad keeps crashing when I open a file" → watch the Agent Trace run diagnose → fix → verify → re-plan across attempts, ending either in a verified fix or an honest findings handoff.
2. **Governance arc:** file a lockout ticket 3×, approving `ad.unlock_account` each time → the 4th run executes it automatically with the "trusted · auto" badge.

## Known limitations (deliberate scope)

- In-memory graph checkpointer, trace store, and fleet — a process restart drops in-flight interrupts (tickets persist via InsForge). Production would use a Postgres checkpointer.
- Single global device-agent heartbeat — one live agent at a time; jobs are not routed per-device yet.
- No real Slack. The employee surface is our own Slack-shaped `#it-support` channel inside the app ([SlackView](src/app/components/SlackView.tsx)) — nothing leaves the machine, and there is no workspace to install into.
- The device agent is copied to the machine by hand — no self-update channel.

MIT
