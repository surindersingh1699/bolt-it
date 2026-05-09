# ARCHITECTURE.md — bolt-it

> Live document. Update whenever a layer, flow, or adapter changes. Source: read alongside [spec.md](spec.md) (the *why*) and [PROJECT_STATE.md](PROJECT_STATE.md) (the *now*).

---

## 1. Mental model in one paragraph

A Slack message becomes an IT ticket. The agent retrieves matching runbooks (Nia), drafts a response + a capability-scoped action plan, and then waits at a hard approval gate. A human technician one-clicks **Approve & Execute**. The plan runs step-by-step through 4 narrow capability adapters — never a general-purpose tool. On success, the resolved ticket is auto-extracted into a new (or reinforced) runbook, so the *next* identical ticket resolves faster. That compounding loop is the moat. Everything is mock-first; real integrations are opt-in via env vars and fall back silently if they fail.

---

## 2. Stack

| Layer | Choice | Where |
| --- | --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) | [src/app/](src/app/) |
| UI | React 19 + Tailwind v4 + lucide-react | [src/app/components/](src/app/components/) |
| Server logic | Server Actions | [src/app/actions/tickets.ts](src/app/actions/tickets.ts) |
| Data (demo) | In-memory `Map` store (singleton on `globalThis`) | [src/lib/db.ts](src/lib/db.ts) |
| Data (production-path) | Convex schema (reference only — not deployed) | [convex/schema.ts](convex/schema.ts) |
| Realtime | Client polls `GET /api/state` every 600ms | [src/app/components/StateProvider.tsx](src/app/components/StateProvider.tsx) |
| Validation | zod (installed, applied at any user-input boundary) | — |
| Package manager | pnpm | `pnpm-lock.yaml` |

**Sponsors wired (7):** Nia (retrieval + drafting), Convex (schema), Vercel (host), InsForge, Aside, Tensorlake, Hyperspell. Of those, **5 have adapter files** in [src/lib/integrations/](src/lib/integrations/) — Convex and Vercel are platform-level, not adapters.

---

## 3. Data layer

### 3.1 Schema (canonical)

[convex/schema.ts](convex/schema.ts) defines two tables:

- **`tickets`** — full lifecycle in one row: status, plan steps (embedded), citations (embedded), confidence, `resolvedByAi`, `resolutionTimeMs`, `runbookSourceId`. Indexed by status, org, and createdAt.
- **`runbooks`** — title, body, tags, `successCount`, `failureCount`, `sourceTicketIds`. Indexed by `updatedAt` and a search index on `body` filtered by `tags`.

Keep this file 1:1 with [src/lib/types.ts](src/lib/types.ts). The schema is the contract; the in-memory store and the TypeScript types are mirrors of it.

### 3.2 In-memory mirror

[src/lib/db.ts](src/lib/db.ts) holds two `Map`s on `globalThis.__ITDB__` (singleton survives Turbopack hot reloads). Methods: `insertTicket`, `updateTicket`, `updateStep`, `insertRunbook`, `updateRunbook`, plus `listTickets`, `listRunbooks`, and `deflectionStats`. A `subscribers` set exists but is unused — the client polls instead. **Never write to `db` from a component**; all writes go through Server Actions.

### 3.3 Seed

[src/lib/seed.ts](src/lib/seed.ts) — 4 starter runbooks (Figma SSO, VPN slow, password reset, laptop onboarding). `ensureSeeded()` is idempotent and called from `createTicket` and `GET /api/state`.

---

## 4. Ticket lifecycle (the state machine)

All state transitions live in [src/app/actions/tickets.ts](src/app/actions/tickets.ts).

```
new ──► drafting ──► awaiting_approval ──► executing ──► resolved
                            │                  │              │
                            └──► escalated ◄───┘              └──► extractRunbook()
```

| Step | Function | What happens |
| --- | --- | --- |
| 1. Intake | [`createTicket`](src/app/actions/tickets.ts#L22) | Inserts ticket as `new`, kicks off `draftPlan` (fire-and-forget via `void`). |
| 2. Draft | [`draftPlan`](src/app/actions/tickets.ts#L48) | Status → `drafting`. Calls Hyperspell (user context) and Nia (runbook retrieval + plan + response) **in sequence**. Substitutes `{reporter_email}` placeholders in step params. Status → `awaiting_approval`. |
| 3. Approval gate | [`approveAndExecute`](src/app/actions/tickets.ts#L104) | **Hard gate** — refuses any status other than `awaiting_approval`. Status → `executing`. Kicks off `executePlan` (fire-and-forget). |
| 4. Execute | [`executePlan`](src/app/actions/tickets.ts#L112) | Iterates plan steps **serially**. Each step routes to its capability adapter. On any step failure → status `escalated`, return early. On full success → status `resolved`. |
| 5. Learn | [`extractRunbook`](src/app/actions/tickets.ts#L174) | If the resolution cited an existing runbook with confidence ≥ 0.6 → bump that runbook's `successCount`. Otherwise → synthesize a *new* runbook from the executed plan and ingest into Nia (no-op in M1). |
| 6. Escape hatch | [`escalateTicket`](src/app/actions/tickets.ts#L226) | Manual escalation from the UI. |

**Invariants worth knowing:**
- Status transitions only happen here. Never patch `status` from a component or adapter.
- `revalidatePath("/")` is called after every state change — but the client doesn't rely on it; the 600ms poll catches everything.
- Plan execution is serial, not parallel. A failed step short-circuits the rest. There is no retry.

---

## 5. Integration adapters

All adapters live in [src/lib/integrations/](src/lib/integrations/) and follow the same shape:

```ts
if (process.env.<KEY>) { /* try real */ }
return mock();  // always fall back, never throw
```

| Adapter | File | Real API | Env gate | Capabilities used in mocks |
| --- | --- | --- | --- | --- |
| **Nia** | [nia.ts](src/lib/integrations/nia.ts) | `POST /v2/advisor` (codebase-as-runbooks payload) | `NIA_API_KEY` | Returns `{ matched_runbook_id, confidence, reasoning, response, plan }` parsed from JSON in `data.advice`. |
| **Hyperspell** | [hyperspell.ts](src/lib/integrations/hyperspell.ts) | `GET /v1/users/:email/context` | `HYPERSPELL_API_KEY` | 3-user dictionary (alex/priya/jordan) — name, team, recent apps. |
| **InsForge** | [insforge.ts](src/lib/integrations/insforge.ts) | (not yet wired) | — | Edge-function-style policy gate. Mocks `okta.list_groups`, `mdm.push_vpn_config`, `identity.verify`. |
| **Aside** | [aside.ts](src/lib/integrations/aside.ts) | (not yet wired) | — | Browser action in user's authenticated session — agent never holds creds. Mocks `okta.add_to_group`, `okta.send_reset`. |
| **Tensorlake** | [tensorlake.ts](src/lib/integrations/tensorlake.ts) | (not yet wired) | — | Sandboxed compute. Mocks `diag.network_probe` with synthetic traceroute output. |

Each adapter returns `{ ok: boolean, log: string[] }`. The `log` is the user-visible per-step output rendered in the Active Ticket panel.

### 5.1 Nia is the only real call

When `NIA_API_KEY` is set, [`realNiaDraft`](src/lib/integrations/nia.ts#L34):

1. Loads all runbooks from the in-memory store and serializes them as virtual `runbooks/<id>.md` files.
2. Builds a structured prompt asking for one JSON object: `{ matched_runbook_id, confidence, reasoning, response, plan }`.
3. Posts to `${NIA_API_URL}/advisor` with a 25s timeout.
4. Extracts the first balanced JSON object from `data.advice` (string-aware brace matcher in [`extractJsonObject`](src/lib/integrations/nia.ts#L182)).
5. Maps the matched runbook into a `Citation` and the steps into `PlanStep`s with `status: "pending"`.
6. On *any* failure (network, non-OK, malformed JSON) — returns `null` and the caller falls through to `mockNiaDraft`.

The mock scores runbooks by tag overlap + title-word overlap + log-weighted prior `successCount`, then templates a response by inferred tag (`sso | vpn | password | laptop | generic`).

---

## 6. API surface

| Route | Verb | Purpose |
| --- | --- | --- |
| [`/api/state`](src/app/api/state/route.ts) | GET | Returns `{ tickets, runbooks, stats }`. Polled by client every 600ms. `force-dynamic`. |
| [`/api/demo/ticket`](src/app/api/demo/ticket/route.ts) | POST | Creates a ticket with optional override fields. If `autoApprove: true`, polls until `awaiting_approval` and auto-approves (60 attempts × 500ms). Used by `curl` for headless demo. |

There is no `POST /tickets` — UI creates tickets via the `createTicket` Server Action directly.

---

## 7. Client architecture

### 7.1 State propagation

[src/app/components/StateProvider.tsx](src/app/components/StateProvider.tsx) — a single React context that:

- Polls `GET /api/state` every 600ms via `setInterval`.
- Holds `tickets`, `runbooks`, `stats`, `selectedTicketId`.
- Auto-selects the first non-resolved ticket if nothing is selected.

Every component consumes this with `useAppState()`. There is no Zustand, Redux, or SWR — polling + context is enough for the demo.

### 7.2 Component tree

```
RootLayout (layout.tsx)
└── Home (page.tsx)
    └── StateProvider
        └── AppShell                     [tabs + header + DeflectionDashboard]
            ├── DeflectionDashboard      [live metrics strip]
            └── one of:
                ├── Console              [3-pane: queue | active ticket | knowledge]
                │   ├── TicketQueue
                │   ├── ActiveTicket     [draft, plan steps, approve/escalate buttons]
                │   └── KnowledgeSidebar [Nia + Hyperspell citations for selected ticket]
                ├── SlackChat            [demo intake — quick prompts + free-form]
                └── RunbooksTab          [library view with successCount badges]
```

### 7.3 The two interaction surfaces

- **SlackChat** — where end-users post issues. Calls `createTicket` Server Action. Each chat line is matched back to its ticket by `(reporterEmail, body)` for the live status badge.
- **Console > ActiveTicket** — where the technician approves. The **Approve & Execute** button is the trust gate; it calls `approveAndExecute` Server Action. The **Escalate** button calls `escalateTicket`.

---

## 8. End-to-end walkthrough (one ticket)

User clicks the "Can't access Figma anymore" quick prompt as Alex Reyes:

1. **`SlackChat.sendQuick`** appends a chat line and calls `createTicket({ reporter, reporterEmail, subject, body, channel: "slack" })`.
2. **`createTicket`** seeds runbooks (idempotent), inserts a `Ticket` with `status: "new"`, then `void draftPlan(id)` (returns immediately so the UI doesn't block).
3. **`draftPlan`** sets status to `drafting`, then:
   - Awaits `getUserContext("alex@acme.test")` → returns `{ name: "Alex Reyes", team: "design", recentApps: ["figma", "notion", "slack"] }` (mock).
   - Awaits `niaDraft({...})` → real Nia (if `NIA_API_KEY` set) or mock template for tag `"sso"`. Returns `{ response, plan, citations, confidence, reasoning }`.
   - Pushes the user context as a `hyperspell` citation.
   - Substitutes `{reporter_email}` → `alex@acme.test` in step params.
   - Status → `awaiting_approval`.
4. **Client poll** (≤600ms later) sees the new draft + plan. `ActiveTicket` renders the response, the 3 plan steps, and the **Approve & Execute** button.
5. **Technician clicks Approve.** `approveAndExecute(id)` checks status === `awaiting_approval`, sets status to `executing`, then `void executePlan(id)`.
6. **`executePlan`** iterates serially:
   - Step 0 (`insforge`, `okta.list_groups`) → `insforgeInvoke` returns `{ ok: true, log: [...], data: { groups, missing: ["figma-designers"] } }`.
   - Step 1 (`aside`, `okta.add_to_group`) → `asideExecute` returns `{ ok: true, log: [...] }`.
   - Step 2 (`slack_reply`) → inline log, 300ms delay.
   - Each step writes its `status` and `log` to the ticket via `db.updateStep`. The client poll surfaces these live.
7. All steps succeeded → status `resolved`, `resolutionTimeMs` recorded.
8. **`extractRunbook`** finds the cited runbook (`rb-figma-sso`) and the confidence is ≥ 0.6 → bumps its `successCount` and appends the ticket id to `sourceTicketIds`.
9. **Deflection dashboard** ticks: total tickets +1, AI resolved +1, deflection rate recomputed, avg resolve time updated.
10. **Next time the same prompt fires**, the runbook now shows higher prior success → mock scoring boosts confidence; real Nia sees it in the codebase payload.

Total wall-clock: ~3–5s mock-only, ~16s with real Nia.

---

## 9. Conventions and invariants

These are enforced by code review (and CLAUDE.md), not by tests.

1. **Mock-first.** Every adapter has a real branch + a mock fallback. Never remove the mock.
2. **Approval gate is sacred.** No path moves a ticket from `awaiting_approval` → `executing` except `approveAndExecute`.
3. **Capability-scoped actions only.** Action `kind` ∈ `insforge | aside | tensorlake | slack_reply`. No general-purpose "run anything" tool.
4. **Adapters never throw.** Catch and return `{ ok: false, log: [...] }`. Failure escalates the ticket; it never crashes the demo.
5. **Component → action → db.** Components never write to `db` directly.
6. **Schema is the contract.** When `convex/schema.ts` changes, `src/lib/types.ts` and `src/lib/db.ts` change with it.
7. **Zero env vars must work.** All keys are opt-in. Missing keys = mock branch.

---

## 10. Anti-patterns (will be reverted)

- Adding generic AI assistant features unrelated to IT tickets.
- An 8th sponsor integration (the 7 are enough).
- Replacing the in-memory store with a real DB before the M3 Convex milestone.
- Background polling at < 600ms (CPU waste; client renders are not free).
- Adding retries to `executePlan` (escalation is the design, not a bug).

---

## 11. Live changelog

Append on every architectural change. Most-recent first.

- **2026-05-09** — Initial ARCHITECTURE.md written. Snapshot of M1: 5 adapter files, in-memory mirror, 600ms polling, hard approval gate, runbook auto-extraction.
