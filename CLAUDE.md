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
- **Risk gate:** [src/lib/policy.ts](src/lib/policy.ts) — `ALLOWLIST_LOW` / `ALLOWLIST_HIGH` first, LLM judge for anything unlisted, `high` fallback on failure. Never make the fallback permissive.
- **Governance:** [src/lib/governance.ts](src/lib/governance.ts) — per-capability approval precedent, workspace-scoped. Auto-promotes a high-risk capability out of the human gate after `PROMOTION_THRESHOLD` (3) clean approvals. `NEVER_AUTO_PROMOTE` is a hard floor checked before the counter.
- **Data:** [src/lib/data.ts](src/lib/data.ts) is the access layer — InsForge primary, in-memory [src/lib/db.ts](src/lib/db.ts) as fallback. There is no `convex/schema.ts`; Convex was retired.
- **Device execution:** [scripts/local-agent.mjs](scripts/local-agent.mjs) polls for jobs and runs an allowlisted command set on a real machine (macOS + Windows). `public/local-agent.mjs` is a byte-identical copy served for VM self-update.
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
5. **Label what is simulated.** Any adapter without a real backend appends `· simulated` to its log lines. Output labeled simulated can never justify a "resolved" verdict.
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
