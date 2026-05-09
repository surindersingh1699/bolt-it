# CLAUDE.md — Working agreement

This file is read by Claude Code at the start of every session in this directory. It defines stack, commands, rules, and testing expectations.

## Stack
- **Framework**: Next.js 16 (App Router, Turbopack) + React 19 + TypeScript
- **Styling**: Tailwind CSS v4 (`@import "tailwindcss"` in globals.css)
- **Data**: In-memory store at `src/lib/db.ts` mirroring `convex/schema.ts` 1:1
- **Realtime**: Client polls `/api/state` every 600ms (StateProvider.tsx)
- **Server Actions**: `src/app/actions/tickets.ts` for ticket lifecycle
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
- `convex/schema.ts` — production-path schema (reference)
- `src/lib/db.ts` — in-memory mirror of the schema
- `src/lib/integrations/*.ts` — sponsor adapters
- `src/app/actions/tickets.ts` — ticket lifecycle Server Actions
- `src/app/components/*.tsx` — UI components (Console, SlackChat, RunbooksTab)
