# Convex Schema (production path)

This project ships in **demo mode** by default — state lives in an in-memory store at `src/lib/db.ts`. That file mirrors the Convex schema below so the swap is mechanical.

## Switching to live Convex

```bash
npx convex dev
# follow the prompts to log in and link a deployment
```

This generates `_generated/` and starts a local Convex backend. Then:

1. Replace `src/lib/db.ts` reads/writes with `useQuery`/`useMutation` calls from `convex/react`.
2. Move ticket lifecycle logic from `src/app/actions/*` into `convex/tickets.ts` mutations.
3. Set `NEXT_PUBLIC_CONVEX_URL` in `.env.local`.

The schema in `schema.ts` matches the in-memory store exactly. Indexes and search index are pre-defined for the queries the UI needs.
