# IT Support Agent — bounded autonomy with structural human oversight

A LangGraph-orchestrated IT support agent that doesn't just run a plan — it **troubleshoots**: gathers context in parallel, drafts a plan with an LLM, classifies risk per step, pauses on a real graph interrupt before anything high-risk, executes on the user's actual machine through a local device agent, then **verifies from evidence whether the problem is really fixed and re-plans up to 3 attempts** before handing off to a human with a written troubleshooting record.

> **Branches:** `main` — this TypeScript/Next.js agent (the most advanced version).
> `python-rebuild` — a FastAPI/LangGraph-Python port of the same concept (pgvector RAG, Postgres checkpoints).

## The agent graph

```
            ┌─ gatherUserContext (Hyperspell profile) ─┐
START ──────┼─ gatherMemories   (Hyperspell search)  ──┤            (barrier join)
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
   finalize ── troubleshooting record written to ticket ── user confirms in Slack
```

Key properties, all verified live:

- **Structural human oversight** — the approval gate is a LangGraph `interrupt()`; execution resumes from the paused step via `Command({resume})`, never restarts. Low/medium-risk steps run with zero clicks.
- **Learned trust (governance)** — every clean human approval of a capability accumulates precedent; after 3, that capability is auto-promoted out of the human gate (`src/lib/governance.ts`), with a hard `NEVER_AUTO_PROMOTE` floor. Promoted steps run with a visible "trusted · auto" badge.
- **Evidence-based verification** — a fix step "succeeding" is not resolution. The verifier reads real machine output (`diag.app_status`, event logs) plus the company runbook library, Hyperspell memories, and device context, and must cite which it used. Output labeled *simulated* can never justify "resolved."
- **Honest by construction** — adapters without a real backend (Okta/MDM writes, Aside browser actions, Tensorlake sandbox) label their logs `· simulated`. Every trace line in the UI is real.
- **Full observability** — a per-ticket, node-level Agent Trace panel in-product, and per-ticket LangSmith runs (`ticket:<id>`).

## What's real vs simulated

| Layer | Status |
|---|---|
| LangGraph orchestration, interrupts, governance, troubleshooting loop | Real |
| LLM drafting + risk judge + verifier (OpenAI-compatible endpoint) | Real |
| Local device agent — restart app, clear cache (incl. Edge/Chrome), app status, app event logs, system info, Wi-Fi toggle (macOS + Windows) | Real execution |
| AD account state (lock/unlock/reset/kerberos) + fleet health | Real state, seeded demo data |
| Hyperspell memory query/write, Slack outbound, LangSmith | Real APIs |
| Okta/MDM writes, Aside browser actions, Tensorlake/Vercel sandbox | Simulated, labeled as such in logs |

## Quickstart

```bash
pnpm install
pnpm dev                     # http://localhost:3000
```

Env (`.env.local`): `AI_GATEWAY_API_KEY` + `AI_GATEWAY_URL` + `AI_GATEWAY_MODEL` (any OpenAI-compatible endpoint), `HYPERSPELL_API_KEY`, `LANGSMITH_TRACING/API_KEY/PROJECT`, `LOCAL_AGENT_TOKEN`, InsForge + Slack keys optional.

Sign in at `/login` — seeded IT staff: `morgan@acme.test` / `demo-pass-it`. Seeded broken states ready to fix: `bob` (locked account), `frank` (expired password), `eve` (stale Kerberos).

**Device agent** (the thing that actually touches machines):

```bash
LOCAL_AGENT_TOKEN=<token> node scripts/local-agent.mjs        # on this machine
```

For a Windows VM: one-time installer (auto-start at logon, crash recovery, self-updating) — see [WINDOWS_VM_DEMO.md](WINDOWS_VM_DEMO.md). Run **one** device agent at a time.

## Testing it

Ten rehearsed scenarios with exact trigger phrases, tiered by realness, in [DEMO_SCENARIOS.md](DEMO_SCENARIOS.md). The two most telling runs:

1. **Troubleshooting loop:** file "Notepad keeps crashing when I open a file" → watch the Agent Trace run diagnose → fix → verify → re-plan across attempts, ending either in a verified fix or an honest findings handoff.
2. **Governance arc:** file the CFO-VPN ticket 3×, approving the high-risk MDM push each time → the 4th run executes it automatically with the "trusted · auto" badge.

## Known limitations (deliberate scope)

- In-memory graph checkpointer, trace store, and fleet — a process restart drops in-flight interrupts (tickets persist via InsForge). Production would use a Postgres checkpointer.
- Single global device-agent heartbeat — one live agent at a time; jobs are not routed per-device yet.
- Inbound Slack (message → ticket) needs a public URL (tunnel); outbound Slack works locally.
- Device-agent self-update is unsigned (trusted private dev network only).

MIT
