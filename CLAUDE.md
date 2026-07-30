# CLAUDE.md — Working agreement

This file is read by Claude Code at the start of every session in this directory. It defines stack, commands, rules, and testing expectations.

## Stack
- **Framework**: Next.js 16 (App Router, Turbopack) + React 19 + TypeScript
- **Styling**: Tailwind CSS v4 (`@import "tailwindcss"` in globals.css)
- **Data**: In-memory store at `src/lib/db.ts` (singleton on `globalThis`, survives dev hot-reload)
- **Realtime**: Client polls `/api/state` every 600ms (StateProvider.tsx)
- **Orchestration**: `src/lib/ticket-graph.ts` — a `@langchain/langgraph` `StateGraph`, run in-process (no LangGraph Platform), `MemorySaver` checkpointer singleton on `globalThis`. This is the actual ticket lifecycle engine (intake → context gather → draft → classify → execute loop with per-step approval interrupts → confirm). `src/app/actions/tickets.ts` holds only the exported Server Actions, which are thin wrappers around `graph.invoke(...)` / `graph.invoke(new Command({resume}), ...)`.
- **Governance**: `src/lib/governance.ts` tracks per-capability approval precedent (workspace-scoped) and auto-promotes a high-risk capability out of the human-approval gate after `PROMOTION_THRESHOLD` (3) clean approvals. `NEVER_AUTO_PROMOTE` is a hard floor, checked before precedent. Wired into `src/lib/policy.ts`'s `resolveApprovalMode`.
- **Icons**: `lucide-react` only — do not add other icon libs
- **Validation**: `zod` already installed — use it for any user-facing input
- **Package manager**: `pnpm` (lockfile is committed). Do not introduce `npm` or `yarn`.
- **Node**: 22 LTS

## Commands
```bash
pnpm dev                    # start dev server (port 3000)
pnpm exec tsc --noEmit      # typecheck (must pass)
pnpm build                  # production build
curl -X POST -H 'Content-Type: application/json' \
  -d '{"autoApprove":true}' \
  http://localhost:3000/api/demo/ticket
                            # drive a ticket end-to-end via API
curl -s http://localhost:3000/api/state | jq '.stats'
                            # inspect deflection metrics
```

## Rules




## File map (canonical)
- `spec.md` — what we're building and why
- `PROJECT_STATE.md` — where we are right now
- `CLAUDE.md` — this file
- `src/lib/db.ts` — in-memory store (no `convex/schema.ts` — that file was deleted when the project moved to InsForge; `src/lib/data.ts` is the real data-access layer, branching on `isInsforgeEnabled()`)
- `src/lib/ticket-graph.ts` — the LangGraph `StateGraph` that orchestrates the ticket lifecycle (nodes, interrupts, checkpointer singleton)
- `src/lib/governance.ts` — capability-approval precedent tracking + auto-promotion
- `src/lib/ticket-helpers.ts` — shared plain (non-`"use server"`) helpers used by both `tickets.ts` and `ticket-graph.ts`
- `src/lib/policy.ts` — risk classification + governance-aware approval-mode resolution
- `src/lib/integrations/*.ts` — sponsor adapters
- `src/app/actions/tickets.ts` — ticket lifecycle Server Actions (thin wrappers around the graph)
- `src/app/components/*.tsx` — UI components (Console, SlackChat, RunbooksTab)
