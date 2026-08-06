# ARCHITECTURE.md

> How `main` works today. Update this as part of the change that makes it wrong.
> Why we chose things → [DECISIONS.md](DECISIONS.md). What we're doing now → [STATE.md](STATE.md).

**Verified against the code on:** 2026-08-04

---

## 1. In one paragraph

A message becomes a ticket. A LangGraph state machine gathers context from three sources in parallel, drafts a plan with an LLM, and classifies every proposed step into a risk tier. Low and medium risk steps execute immediately; high risk steps pause the graph on a real `interrupt()` until a human approves. Steps execute one at a time — some against a real machine through a local device agent. After each round the agent reads what the machine actually reported and decides whether the problem is fixed; if not, it re-plans and tries again, up to 3 attempts, before handing a written record to a human.

The two things that make this more than a script: the approval gate is **structural** (a graph interrupt, not an `if`), and "the fix step succeeded" is **not** accepted as "the problem is solved."

---

## 2. Stack

| Layer | Choice | Where |
|---|---|---|
| Framework | Next.js 16 App Router, React 19, TypeScript | [src/app/](../src/app/) |
| Styling | Tailwind v4, `lucide-react` icons | [globals.css](../src/app/globals.css) |
| Orchestration | `@langchain/langgraph` `StateGraph`, in-process | [ticket-graph.ts](../src/lib/ticket-graph.ts) |
| Checkpointer | `MemorySaver`, `globalThis` singleton | [ticket-graph.ts](../src/lib/ticket-graph.ts) |
| LLM | Any OpenAI-compatible endpoint | [ai-gateway.ts](../src/lib/integrations/ai-gateway.ts) |
| Persistence | InsForge primary, in-memory fallback | [data.ts](../src/lib/data.ts) → [db.ts](../src/lib/db.ts) |
| Realtime | Client polls `/api/state` every 600ms | [StateProvider.tsx](../src/app/components/StateProvider.tsx) |
| Device execution | Zero-dep Node agent, macOS + Windows | [local-agent.mjs](../scripts/local-agent.mjs) |
| Package manager | pnpm, lockfile committed | — |

---

## 3. The graph

```
            ┌─ gatherProfile   (directory record) ───────┐
START ──────┼─ gatherMemory    (facts + past tickets) ───┤   barrier join
            └─ gatherDeviceContext (fleet + heartbeat) ──┤
                        └─► draftPlan (LLM) ─────────────┘
                                    │
                              classifyRisk ─► persistPlan
                                    │
        ┌─────────────────── runNextStep ◄──────────────┐
        │  approvalMode "human"? ─► markAwaitingApproval │
        │                           └─► awaitApproval    │
        │                               interrupt() ─────┘ Command({resume})
        │  step failed? ─► escalate ─► END
        ▼
   verifyOutcome  (LLM verdict from real machine output + memory)
        │  not resolved & attempt < 3 ─► replan ─► runNextStep
        ▼
   finalizeExecution ─► awaiting_confirmation ─► user confirms ─► resolved
```

Three details that are easy to get wrong when editing:

- **The barrier join.** `classifyRisk` is wired with a single `addEdge([...three predecessors], "classifyRisk")`. Three separate `addEdge` calls would fire it three times.
- **`markAwaitingApproval` is separate from `awaitApproval` on purpose.** On resume, LangGraph re-runs the whole node function from the top. Anything placed before `interrupt()` fires twice — so the status flip and the chat ping live in their own node.
- **Resume never restarts.** `Command({resume})` continues from the paused step.

---

## 4. Ticket status

```
new ─► executing ─► awaiting_approval ─► executing ─► awaiting_confirmation ─► resolved
                                             └─► escalated                └─► escalated
```

There is no `drafting` → `awaiting_approval` whole-plan gate. The plan is persisted and the graph walks straight into execution; only individual high-risk steps pause.

Server Actions in [tickets.ts](../src/app/actions/tickets.ts) are thin wrappers around `graph.invoke(...)`. No business logic lives there. Both entry points run inside `after()` so they survive serverless function termination.

---

## 5. The risk gate

[reviewer.ts](../src/lib/reviewer.ts) rules on every step — at first draft and again at every replan, so a follow-up fix gets no free pass. It returns `allow` / `ask_human` / `block`, and the checks run in this order:

1. **`reply` shortcut.** A reply carries no capability and changes nothing outside the thread → `allow`.
2. **`ALWAYS_ASK`.** `ad.reset_password` → forced `ask_human`. Checked *before* the model, so ticket text cannot argue past it.
3. **Target binding.** Any email in the step's params that is not the reporter's → forced `ask_human`. Deterministic; a step acting on someone else is the shape a successful prompt injection takes.
4. **LLM reviewer.** Everything else goes to `REVIEWER_MODEL` with the ticket body fenced as untrusted data.
5. **Fail closed.** No provider, timeout, malformed JSON, or an unrecognised verdict → `ask_human` at `high` risk. Never make this permissive.

The four verdicts split two ways:

| Verdict | Question it answers | Autonomy may overrule? |
|---|---|:-:|
| `allow` | Safe to run unattended | n/a |
| `ask_human` | Safe to run unattended | Yes |
| `block` | Should this run at all — does it follow from the ticket? | No |
| `needs_evidence` | Should this run at all — is its diagnosis established? | No |

`needs_evidence` refuses a *change* whose justification depends on a cause nothing in the executed history observed. Read-only steps are never refused this way: gathering the evidence is exactly how the assumption gets tested. A refused step is marked `failed` with a `failure.kind` of `policy_block` or `unsupported_assumption` before anything runs.

The old static allowlist (`policy.ts`) and the precedent-promotion machinery (`governance.ts`) are both deleted. There is no path by which repeated approvals promote a capability out of the gate.

Under `AUTONOMY=full` every `ask_human` becomes `auto`, including steps 2 and 3 — the bypass is logged per step, so it is auditable. A `block` is never bypassed: there is no human to route it to, so bypassing would not remove a wait, it would just run the step the reviewer identified as not belonging to this problem.

---

## 6. Adapters

All in [src/lib/integrations/](../src/lib/integrations/). Every execution adapter returns `{ ok: boolean, log: string[] }` and **never throws** — a failure escalates the ticket, it does not crash the app.

| Adapter | Real backend | Notes |
|---|---|---|
| [ai-gateway.ts](../src/lib/integrations/ai-gateway.ts) | Yes | Tiered drafting, verifier, service-desk voice, reply synthesis, memory extraction |
| [memory.ts](../src/lib/memory.ts) | Yes | Per-user facts + episodes in the `user_memory` table |
| [directory.ts](../src/lib/integrations/directory.ts) | Yes | AD reads/writes against seeded state. Every branch touches real rows |
| [knowledge.ts](../src/lib/integrations/knowledge.ts) | Yes | `kb.*` external lookup, tier 2+. Results are fenced as evidence, never instructions |

Device work has no adapter here by design: it goes through [agent-jobs.ts](../src/lib/agent-jobs.ts) to the local agent, and the machine's own before/after probe is the verdict.

Anything without a real backend appends `· simulated` to its log lines. **Output labeled simulated can never justify a "resolved" verdict** — the verifier enforces this.

The drafting contract itself lives in [draft.ts](../src/lib/integrations/draft.ts) (`DraftInput`, `DraftResult`), separate from any one provider, so the retrieval backend can change without touching the graph.

---

## 7. Device execution

[local-agent.mjs](../scripts/local-agent.mjs) is a zero-dependency Node script run on the target machine. It polls `/api/agent/jobs`, claims one, runs a command from its own internal allowlist, and posts the result back. Real capabilities: restart app, clear app cache (including Edge/Chrome profile paths), app status, app event logs, system info, Wi-Fi toggle. macOS and Windows.

The agent is copied onto the target machine by hand. There is no HTTP-served copy and no self-update: an unsigned update channel that also served a token-bearing `setup.ps1` was not worth the convenience.

Auth is a single shared bearer token (`LOCAL_AGENT_TOKEN`). One agent at a time; jobs are not routed per-device.

---

## 8. Invariants

1. Status transitions happen only in the graph and the ticket Server Actions.
2. No path reaches a high-risk step without the `interrupt()`.
3. Action `kind` is one of `device | backend | reply`. No general-purpose tool.
4. Adapters return failures, never throw.
5. Components never write to the store. Component → Server Action → `data.ts`.
6. Anything simulated says so, in the log line the user sees.
7. No branching on ticket text or reporter email to force a demo outcome.

---

## 9. Known gaps

- `MemorySaver` is in-memory — a restart drops in-flight interrupts. `python-rebuild` uses a Postgres checkpointer.
- No tests. The safety rules in §5 are enforced by review only.
- [data.ts](../src/lib/data.ts) carries ~340 lines of mechanical row↔object mapping and repeats the `isInsforgeEnabled()` branch in ~30 functions.
