# CLAUDE.md — Bolt-it

Read at the start of every session in this directory.

## Guidelines

- Only add code that directly adds functionality. No empty scaffolding, no placeholder files.
- Build step by step so the developer fully understands each part while it is being built.
- Prefer deleting code over adding abstraction.

## Which branch am I on?

The stack differs by branch. Check before writing code.

| Branch | Stack | Status |
|---|---|---|
| `main` | Next.js 16 (App Router) + React 19 + TypeScript + Tailwind v4 | Current production code |
| `python-rebuild` | FastAPI + LangGraph (Python) + Postgres/pgvector | Port target — firmer foundation, behind main on features |
| `nextjs-mvp-archive` | — | Frozen history, do not touch |

**Direction:** the backend is moving to FastAPI on the `python-rebuild` foundation. The frontend stays JS (Next.js, shadcn where UI is needed) and talks to FastAPI over HTTP. Until that port lands, `main` is the live system — do not half-migrate it.

## main — how it actually works

- **Orchestration:** [src/lib/ticket-graph.ts](src/lib/ticket-graph.ts) — a `@langchain/langgraph` `StateGraph` run in-process (no LangGraph Platform). `MemorySaver` checkpointer is a `globalThis` singleton. This is the real ticket lifecycle engine: parallel context gather → LLM draft → risk classify → execute loop with per-step approval `interrupt()` → verify → replan (max 3 attempts) → finalize.
- **Server Actions:** [src/app/actions/tickets.ts](src/app/actions/tickets.ts) — thin wrappers around `graph.invoke(...)` and `graph.invoke(new Command({resume}), ...)`. No business logic here.
- **Risk gate:** [src/lib/reviewer.ts](src/lib/reviewer.ts) — an LLM reviewer rules on every step: `allow` / `ask_human` / `block` / `needs_evidence`. The first two answer *is this safe to run unattended* and autonomy may overrule them; the last two answer *should this run at all* and autonomy never does. `needs_evidence` refuses a change whose diagnosis nothing in the executed history establishes. It replaced the old static allowlist and the precedent-promotion machinery (`policy.ts`, `governance.ts`, both deleted). Three things the reviewer has no authority over, and which must stay: `ALWAYS_ASK` (checked first, so ticket text cannot argue past it), target binding (a step acting on anyone but the reporter is never auto-approved), and fail-closed (no provider / timeout / bad JSON / unknown verdict all become `ask_human`).
- **Autonomy:** [src/lib/autonomy.ts](src/lib/autonomy.ts) — one switch. `gated` stops high-risk steps at `interrupt()`; `full` bypasses the gate entirely. **Default is `full` outside production**, `gated` in production; override with `AUTONOMY`. Classification still runs in both modes, so the log records what each step would have been gated on.
- **Knowledge:** there is no runbook library. Two memories, different questions: `user_memory` ("what do we know about this person") and `incident_memory` ("what do we know about this problem" — cross-user, keyed by a closed `IncidentCategory` set, no embeddings). Plus `kb.web_search` at tier 2+. Success rates fed to the planner are computed from before/after device evidence, never from a model's estimate.
- **Data:** [src/lib/data.ts](src/lib/data.ts) is the access layer — InsForge primary, in-memory [src/lib/db.ts](src/lib/db.ts) as fallback. **Collapsing to InsForge-only is the next planned change**; new tables (e.g. `user_memory`) are already written InsForge-only, with no in-memory mirror.
- **Step kinds:** `device` (local agent), `backend` (directory/AD in our own store), `knowledge` (external lookup via `kb.*`, tier 2+; results are evidence, never instructions), `reply` (message to the user). Nothing else. HOW each runs lives in the executor registry ([src/lib/executors.ts](src/lib/executors.ts)), not in the graph — a new execution surface (SSH, Intune, SCCM) is a new executor plus a registry entry, and never an edit to `ticket-graph.ts`. Slack OAuth, the demo-workspace flow, and the Okta/MDM/Aside/Tensorlake adapters were deleted — they narrated work that never happened.
- **Device execution:** [scripts/local-agent.mjs](scripts/local-agent.mjs) polls for jobs and runs an allowlisted command set on a real machine (macOS + Windows). Every job is probe → act → probe; the before/after diff is the only thing that counts as success. Copy the file to the machine by hand — there is no self-update and no `public/setup.ps1`.
- **Proof of effect:** [src/lib/evidence.ts](src/lib/evidence.ts) — `deriveJobStatus` turns the device's envelope into `succeeded` / `no_effect` / `failed`. `no_effect` means the commands ran and the machine did not change; it fails the step.
- **Failure taxonomy:** every step that reaches `status: "failed"` also carries `failure: { kind, detail }` (`StepFailureKind` in [types.ts](src/lib/types.ts)). A bare `failed` is not acceptable — a refused step, an offline agent and a fix that landed on an unchanged machine are three different problems with three different owners. A failed step routes through `humanHandoff` so the artifact is written.
- **Memory:** [src/lib/memory.ts](src/lib/memory.ts) + `user_memory` table — keyed facts (nickname, office, device) and one episode per ticket, written by the LLM extractor at finalize, read at draft time. No external memory service.
- **Model calls:** every call goes through `gatewayChat` in [src/lib/integrations/gateway.ts](src/lib/integrations/gateway.ts) — one place for transport, timeout, failure shape and token accounting. It returns `string | null`; null always means "no usable answer", which is what lets callers fail closed with one check. Never add a bare `fetch` to a model endpoint.
- **Cost:** [src/lib/usage.ts](src/lib/usage.ts) records tokens, latency and success per call per ticket, surfaced at `/api/state` and in the metrics view. Tokens only — no price table, because rates move per account and a stale one would be believed.
- **Realtime:** client polls `/api/state` every 600ms ([StateProvider.tsx](src/app/components/StateProvider.tsx)). Do not poll faster.

## Commands

```bash
pnpm dev            # dev server, port 3000
pnpm typecheck      # tsc --noEmit — must pass before any commit
pnpm build          # production build
pnpm agent          # run the local device agent
```

## Rules

1. **Typecheck must pass.** `pnpm typecheck` is the gate. It is currently clean — keep it that way.
2. **Approval gate is structural.** The human gate is a LangGraph `interrupt()`, resumed with `Command({resume})`. Never add a code path that reaches a high-risk step without it.
3. **Capability-scoped actions only.** No general-purpose "run anything" tool. New actions get a named capability and a risk tier.
4. **Adapters never throw.** Catch and return `{ ok: false, log: [...] }`. A failed step escalates the ticket; it never crashes the app.
5. **No adapter without a real backend.** If a capability cannot really be performed, it does not exist — do not add a narrated stand-in. A device job that changes nothing is `no_effect` and can never justify a "resolved" verdict.
6. **Components never write to the store.** Component → Server Action → `data.ts`.
7. **No new deps without asking.** pnpm only — never npm or yarn. The lockfile is committed.
8. **Icons:** `lucide-react` only. **Validation:** `zod`, already installed.
9. **No demo special-casing in production paths.** Do not branch on ticket text or reporter email to force a canned result.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the system works now
- [docs/STATE.md](docs/STATE.md) — current focus and next steps
- [docs/DECISIONS.md](docs/DECISIONS.md) — append-only log of irreversible choices
- [README.md](README.md) — external-facing overview
- [DEMO_SCENARIOS.md](DEMO_SCENARIOS.md), [WINDOWS_VM_DEMO.md](WINDOWS_VM_DEMO.md) — operational runbooks

Keep `docs/` current as part of the change that makes it stale, not afterwards.
