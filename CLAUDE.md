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
1. **Mock-first for all integrations.** Every adapter in `src/lib/integrations/*` has a real impl + mock fallback. Mock is the default; real is opt-in via env var. Never remove the mock branch.
2. **No new sponsor sprawl.** The 7 wired sponsors (Nia, Convex, Vercel, InsForge, Aside, Tensorlake, Hyperspell) are enough. Nia handles retrieval + drafting in one call. Do not add an 8th unless it replaces one.
3. **One task per prompt.** No multi-feature commits. If the ask is "do X and Y," push back and ask which to do first.
4. **Never edit `db.ts` from a component.** All writes go through Server Actions in `src/app/actions/`.
5. **Never bypass the technician approval gate.** A ticket cannot move from `awaiting_approval` → `executing` without an explicit approve action. This is the security pitch.
6. **Capability-scoped actions only.** New action types must be one of: `insforge | aside | tensorlake | slack_reply`. No general-purpose "run anything" tool.
7. **No comments unless WHY is non-obvious.** Per repo style — well-named code is the documentation.
8. **No new dependencies without justification.** If you need a lib, ask first and justify against existing deps.
9. **Fallback required for every real-API call.** If a real adapter throws or returns non-OK, fall back to the mock silently. Never crash the demo.
10. **Demo must run with zero env vars.** All keys are opt-in; mocks must keep the happy path green.

## Testing expectations
- Before claiming "done": `pnpm exec tsc --noEmit` returns clean.
- Before claiming "demo works": drive each demo prompt via `/api/demo/ticket` and inspect `/api/state` for `status: resolved`.
- Before merging into "production-path" anything: write 1 negative test (what happens when the adapter fails?).

## Anti-patterns (will be rejected)
- Adding generic "AI assistant" features unrelated to IT tickets.
- Backend rewrite without a written reason in PROJECT_STATE.md.
- Replacing the in-memory store with a database before the Convex migration milestone (M3+).
- Removing the mock branch in any integration adapter.
- Committing `.env.local` or any file containing a real API key.

## File map (canonical)
- `spec.md` — what we're building and why
- `PROJECT_STATE.md` — where we are right now
- `CLAUDE.md` — this file
- `convex/schema.ts` — production-path schema (reference)
- `src/lib/db.ts` — in-memory mirror of the schema
- `src/lib/integrations/*.ts` — sponsor adapters
- `src/app/actions/tickets.ts` — ticket lifecycle Server Actions
- `src/app/components/*.tsx` — UI components (Console, SlackChat, RunbooksTab)
