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

- **Orchestration:** [src/lib/ticket-graph.ts](src/lib/ticket-graph.ts) — a `@langchain/langgraph` `StateGraph` run in-process (no LangGraph Platform). `MemorySaver` checkpointer is a `globalThis` singleton. Ten nodes: observe → strategist ⇄ operator ⇄ execute, plus researcher, the two approval nodes, finalize and humanHandoff. **Roles, not tiers** — see [docs/ROLES.md](docs/ROLES.md).
- **Two models, deliberately asymmetric.** [strategist.ts](src/lib/strategist.ts) is opus and called rarely: it reads the problem, the screenshot and the machine's readings, diagnoses, and *authorises* actions. [operator.ts](src/lib/operator.ts) is sonnet and called often: it binds real app names and paths, retries what fails mechanically, runs extra reads to get unstuck, and hands back when done or blocked. Most of a ticket's rounds are mechanical, which is the entire cost argument. Bounds: `MAX_STRATEGY_ROUNDS=3` (opus), `MAX_OPERATOR_ROUNDS=3` per strategy (sonnet).
- **The operator cannot author a change.** `authorizeOperatorSteps` ([operator.ts](src/lib/operator.ts)) lets it run any READ freely and only the WRITES the strategist authorised — matched on capability, so correcting an app name is fine and introducing a different fix is not. In code, never in a prompt, because a prompt can be argued with by a ticket body. An overreach sets `blocked` rather than being dropped silently.
- **The rule that holds the gate up:** models emit data, the graph emits control flow. No LLM returns a `goto`. A supervisor-agent pattern would let a model route around `markAwaitingApproval`, which is why this system does not use one.
- **Resolution is claimed, then checked.** [resolution.ts](src/lib/resolution.ts) refuses `resolved: true` when nothing ran or when everything failed. It replaced running the verifier on a separate model and is stronger — an `if` cannot be talked out of its position. Not "must have a VERIFIED CHANGE": a question ticket is resolved by a read.
- **Observation before diagnosis:** [src/lib/observe.ts](src/lib/observe.ts) runs a read-only `diag.*` bundle on the START edge, so the strategist reasons against readings instead of spending a round acquiring them. Whole bundle enqueued before anything is awaited — one agent poll cycle, not one per probe. No device or no heartbeat returns `collected: false` immediately, verbatim into the prompt. The bundle must stay read-only: it runs with no reviewer and no gate.
- **Screenshots:** attached on the ticket, uploaded to the private `ticket-attachments` bucket **before** the row is inserted (the graph starts from `after()`, so uploading later races the first read), fetched server-side as a base64 data URI, and sent to the strategist on round 1 only. [attachments.ts](src/lib/attachments.ts). Do not make that bucket public.
- **Server Actions:** [src/app/actions/tickets.ts](src/app/actions/tickets.ts) — thin wrappers around `graph.invoke(...)` and `graph.invoke(new Command({resume}), ...)`. No business logic here.
- **Risk gate:** [src/lib/reviewer.ts](src/lib/reviewer.ts) — an LLM reviewer rules on every step: `allow` / `ask_human` / `block` / `needs_evidence`. The first two answer *is this safe to run unattended* and autonomy may overrule them; the last two answer *should this run at all* and autonomy never does. `needs_evidence` refuses a change whose diagnosis nothing in the executed history establishes. It replaced the old static allowlist and the precedent-promotion machinery (`policy.ts`, `governance.ts`, both deleted). Three things the reviewer has no authority over, and which must stay: `ALWAYS_ASK` (checked first, so ticket text cannot argue past it), target binding (a step acting on anyone but the reporter is never auto-approved), and fail-closed (no provider / timeout / bad JSON / unknown verdict all become `ask_human`).
- **Autonomy:** [src/lib/autonomy.ts](src/lib/autonomy.ts) — one switch. `gated` stops high-risk steps at `interrupt()`; `full` bypasses the gate entirely. **Default is `full` outside production**, `gated` in production; override with `AUTONOMY`. Classification still runs in both modes, so the log records what each step would have been gated on.
- **Capabilities:** one flat closed set in [capabilities.ts](src/lib/capabilities.ts), split into read-only and changes-something. Flat is not open — `capabilityAllowed` is enforced in code on everything either model proposes (CLAUDE.md rule 3). The read/write split is what lets the cheap model drive execution safely.
- **Memory is UNWIRED, on purpose.** `user_memory` and `incident_memory` still have their modules, tables and tests; nothing calls them. They come back once the loop is proven on real tickets. Do not delete them, and do not re-wire them without asking.
- **Researcher:** [src/lib/research.ts](src/lib/research.ts) is a graph node and the **quarantine boundary** for external text. Raw pages enter the distiller and never leave it; out come at most 5 one-sentence claims, each attributed to a URL actually retrieved that round. A `ResearchFinding` has no field that can carry a command or a capability id. Unattributable claims are dropped; no distiller means nothing is admitted; text addressed to the reader comes back as a `flag` and lands in the findings. The strategist asks, bounded at `MAX_RESEARCH_ROUNDS = 2`. [knowledge.ts](src/lib/integrations/knowledge.ts) is transport only — never wire it to a prompt directly.
- **Data:** [src/lib/data.ts](src/lib/data.ts) is the access layer — InsForge primary, in-memory [src/lib/db.ts](src/lib/db.ts) as fallback. **Collapsing to InsForge-only is the next planned change**; new tables (e.g. `user_memory`) are already written InsForge-only, with no in-memory mirror.
- **Step kinds:** `device` (local agent), `backend` (directory/AD in our own store), `reply` (message to the user). Nothing else — and deliberately no `knowledge` kind: a web lookup touches no company system, so charging it a plan slot, a safety review and an approval decision bought nothing. HOW each runs lives in the executor registry ([src/lib/executors.ts](src/lib/executors.ts)), not in the graph — a new execution surface (SSH, Intune, SCCM) is a new executor plus a registry entry, and never an edit to `ticket-graph.ts`. Slack OAuth, the demo-workspace flow, and the Okta/MDM/Aside/Tensorlake adapters were deleted — they narrated work that never happened.
- **Device execution:** [scripts/local-agent.mjs](scripts/local-agent.mjs) polls for jobs and runs an allowlisted command set on a real machine (macOS + Windows). Every job is probe → act → probe; the before/after diff is the only thing that counts as success. Copy the file to the machine by hand — there is no self-update and no `public/setup.ps1`. The runtime (token check + poll loop) is guarded behind `IS_ENTRYPOINT`, so `executeJob` and the handler table can be imported by a test harness with no server. Write handlers today: `restart_app`, `clear_app_cache`, `toggle_wifi`, `set_dns_servers`, `flush_dns` (add one by registering it in `HANDLERS` with an `expectsChange` flag and a probe — never a bare shell call).
- **Fingerprints:** every state-changing job writes three records on the machine before upload — the append-only journal (`~/.bolt-it/journal`), a change record with the **exact undo command** (`~/.bolt-it/changes/<ticketId>.jsonl`, via `recordChange`), and a line in the OS's own log (Windows Application event log source `BoltIt`; macOS `~/Library/Logs/bolt-it.log`, via `writeSystemLog`). The revert command and change-record path ride back on the envelope, so `formatProofLines` documents them on the ticket. A read or a `no_effect` run writes no change record — there is nothing to undo.
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
3. **Capability-scoped actions only.** No general-purpose "run anything" tool. A new action gets a named capability in [capabilities.ts](src/lib/capabilities.ts) and a place on the read-only or changes-something side of that list. Getting the side wrong in the permissive direction lets the cheap model author it.
4. **Adapters never throw.** Catch and return `{ ok: false, log: [...] }`. A failed step escalates the ticket; it never crashes the app.
5. **No adapter without a real backend.** If a capability cannot really be performed, it does not exist — do not add a narrated stand-in. A device job that changes nothing is `no_effect` and can never justify a "resolved" verdict.
6. **Components never write to the store.** Component → Server Action → `data.ts`.
7. **No new deps without asking.** pnpm only — never npm or yarn. The lockfile is committed.
8. **Icons:** `lucide-react` only. **Validation:** `zod`, already installed.
9. **No demo special-casing in production paths.** Do not branch on ticket text or reporter email to force a canned result.

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the system works now
- [docs/ROLES.md](docs/ROLES.md) — the role split, depth rungs, and the two boundaries (observation, research). Supersedes the deleted `TIERS.md`
- [docs/STATE.md](docs/STATE.md) — current focus and next steps
- [docs/DECISIONS.md](docs/DECISIONS.md) — append-only log of irreversible choices
- [README.md](README.md) — external-facing overview
- [DEMO_SCENARIOS.md](DEMO_SCENARIOS.md), [WINDOWS_VM_DEMO.md](WINDOWS_VM_DEMO.md) — operational runbooks

Keep `docs/` current as part of the change that makes it stale, not afterwards.
