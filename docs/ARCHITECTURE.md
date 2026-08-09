# ARCHITECTURE.md

> How `main` works today. Update this as part of the change that makes it wrong.
> Why we chose things → [DECISIONS.md](DECISIONS.md). What we're doing now → [STATE.md](STATE.md).

**Verified against the code on:** 2026-08-07

---

## 1. In one paragraph

A message becomes a ticket, optionally with a screenshot. Before anything is reasoned about, a read-only probe bundle runs on the reporter's machine. A strategist (opus) then looks at the problem, the screenshot and those readings, diagnoses it, and authorises a set of actions. An operator (sonnet) carries them out — binding real app names and paths, retrying what fails mechanically, running extra reads to get unstuck — while a separate safety reviewer rules on every step and high-risk ones pause the graph on a real `interrupt()`. When the authorised work is done or the operator is blocked, the strategist looks again.

Four things make this more than a script: the approval gate is **structural** (a graph interrupt, not an `if`); "the fix step succeeded" is **not** accepted as "the problem is solved"; the cheap model **cannot author a change** the expensive one did not authorise; and **no model routes** — models emit data, the graph emits control flow.

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
START ─► observe ─► strategist (OPUS) ◄─────────────────────┐
       (reads the         │                                 │
        machine)          │ diagnosis + AUTHORISED actions  │ done, or blocked,
                          ▼                                 │ or refused resolution
                     operator (SONNET) ────────────────────►┤
                          │  binds params, clears roadblocks│
                          ▼                                 │
                     reviewSteps  (safety, per step)        │
                          │                                 │
                          ▼                                 │
        ┌──────────► runNextStep ──► markAwaitingApproval    │
        │                 │           └► awaitApproval       │
        │                 │              interrupt() ────────┘ Command({resume})
        └── reads left ───┘
                          │ a FIX landed ─► askEmployeeToVerify
                          │                  └► awaitEmployeeVerdict
                          │                     interrupt()
                          │                       ├─ "still broken" + candidates left
                          │                       │        └──► runNextStep (next rung)
                          │                       ├─ "still broken" + none left ─► strategist
                          │                       └─ "it works" ──► finalize
                          │ round done ──► operator
                          │ refused step ─► strategist
                          ▼
              finalize ─► awaiting_confirmation ─► employee confirms ─► resolved
              humanHandoff ─► escalated (terminal, writes the artifact)

              researcher ◄─ strategist asks a question ─► back to strategist
```

Thirteen nodes (the diagram omits `intentValidator`, which sits between `operator` and `reviewSteps` — see §5). Six details that are easy to get wrong when editing:

- **There is no barrier join.** Only `observe` feeds the strategist, so nothing can deadlock and both loops re-enter their own node freely. This is why escalation-style re-entry is a state update rather than a duplicated path.
- **The inner loop must stay cheap.** `runNextStep` returns to the **operator**, not the strategist. If finished steps went straight back to the strategist, every mechanical retry would cost an opus call. `ticket-graph.test.ts` asserts the edge.
- **`markAwaitingApproval` is separate from `awaitApproval` on purpose.** On resume, LangGraph re-runs the whole node from the top; anything before `interrupt()` fires twice. It also has to leave the paused step looking gated (`pending` + `approvalMode: "human"`), because that is what the portal renders the approve button against — a `capability_missing` refusal arrives here marked `failed`/`auto` and, left that way, produces a ticket at `awaiting_approval` that no one can approve. The grant hands the step back as `auto`; leaving it `human` sends it straight back to the same gate.
- **A mechanical failure finishes the round before re-planning.** `shouldDrainRound` — `buildReplyEvidence` hides pending steps from the operator, so handing back mid-round makes it re-propose the checks still queued, and the employee reads the same check twice. A `timeout` or `dependency_unavailable` is exempt: the surface is gone and the rest of the round only collects the same failure.
- **Only the operator reaches the reviewer.** The strategist cannot put a step on the ticket by itself — it authorises, the operator selects, the reviewer rules, and only then does anything run.
- **One change at a time, cheapest-reversible first.** The pending queue *is* a remediation ladder. `runNextStep` runs every read freely and at most one **change** per pass; a change that lands parks the run on the employee's answer before the next one starts. A "still broken" costs zero model calls — the run is paused, not finished, so the next candidate is already authorised, already reviewed and already queued. Ordering is computed in [ladder.ts](../src/lib/ladder.ts) from the capability registry, not proposed by a model. See §10.

---

## 4. Ticket status

```
new ─► executing ─► awaiting_approval ─► executing ─► awaiting_confirmation ─► resolved
                                             └─► escalated     │            └─► escalated
                                                               └─► "still broken" ─► executing
                                                                   (next rung if the ladder
                                                                    has one — free; otherwise
                                                                    one reopen, then escalated)
```

There is no `drafting` → `awaiting_approval` whole-plan gate. The plan is persisted and the graph walks straight into execution; only individual high-risk steps pause.

`awaiting_confirmation` now carries two different situations, and the ticket status alone does not tell them apart — the **message** does, which is why the ladder has its own desk moment (`rungCheck`) rather than reusing `resolution`:

1. **Paused mid-ladder.** One candidate fix landed and the run is holding the rest. "Still broken" resumes the paused run onto the next candidate: no model call, no re-observation, and **no reopen is spent** — climbing is the ticket working as designed, not the employee returning a finished one. `answerRungVerdict` in [ticket-graph.ts](../src/lib/ticket-graph.ts) is the entry point; it returns `false` when nothing is paused, and the caller falls back to a real reopen (which is also what happens when a server restart takes the checkpoint with it).
2. **Finished.** Everything ran and the ticket is done.

For case 2, `awaiting_confirmation` is still not terminal. An employee who says it did not work sends the ticket back through `reopenTicketGraph` on the same `thread_id`: the diagnosis trail and executed history carry over, `observe` re-reads the machine, and the round budget resets because their account of what is still happening is a new problem statement. `MAX_REOPENS` is 1 — the strategist hands off past it. Escalating on the first "no", which is what this used to do, threw away a round that was still available and read their most informative message as a button press.

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
| `needs_evidence` | Advisory diagnosis observation check | Yes (bypassed in `full` mode) |

`needs_evidence` flags a *change* whose justification depends on an unobserved cause. Under default `AUTONOMY=full`, `needs_evidence` does not hard-refuse execution.

Under `AUTONOMY=full` every `ask_human` becomes `auto`, including steps 2 and 3 — the bypass is logged per step, so it is auditable. A `block` is never bypassed: there is no human to route it to, so bypassing would not remove a wait, it would just run the step the reviewer identified as not belonging to this problem.

---

## 6. Adapters

All in [src/lib/integrations/](../src/lib/integrations/). Every execution adapter returns `{ ok: boolean, log: string[] }` and **never throws** — a failure escalates the ticket, it does not crash the app.

| Adapter | Real backend | Notes |
|---|---|---|
| [ai-gateway.ts](../src/lib/integrations/ai-gateway.ts) | Yes | `runStrategist` (opus), `runOperator` (sonnet), and `communicate` — the one service-desk voice for every message the employee reads, chat included |
| [memory.ts](../src/lib/memory.ts) | Yes, but **unwired** | Per-user facts + episodes. Nothing calls it today; coming back |
| [attachments.ts](../src/lib/attachments.ts) | Yes | Screenshots → private `ticket-attachments` bucket → data URI for the strategist |
| [directory.ts](../src/lib/integrations/directory.ts) | Yes | AD reads/writes against seeded state. Every branch touches real rows |
| [knowledge.ts](../src/lib/integrations/knowledge.ts) | Yes | Transport only — raw web search and domain-allowlisted page extraction. Its output reaches nothing but [research.ts](../src/lib/research.ts) |

Device work has no adapter here by design: it goes through [agent-jobs.ts](../src/lib/agent-jobs.ts) to the local agent, and the machine's own before/after probe is the verdict.

Two roles are graph nodes rather than adapters, because neither is an action taken on the company's behalf:

- **[observe.ts](../src/lib/observe.ts)** runs a fixed read-only probe bundle on the employee's machine *before* anything is planned, enqueuing the whole bundle before waiting on any of it — one agent poll cycle, not one per probe. The planner then drafts against readings instead of spending its first round acquiring them. No agent, or no heartbeat, and it returns `collected: false` immediately; that answer reaches the prompt verbatim, because a planner that thinks it has evidence it does not have is worse than one that knows it is guessing.
- **[research.ts](../src/lib/research.ts)** is the quarantine boundary for external text. Raw pages enter the distiller and never leave it; what leaves is at most five one-sentence claims, each attributed to a URL that was actually retrieved. Anything in a page addressed to the reader comes back as a `flag` and lands in the findings rather than being silently dropped. With no distiller available, nothing from the web is admitted at all.

Anything without a real backend appends `· simulated` to its log lines. **Output labeled simulated can never justify a "resolved" verdict** — the verifier enforces this.

The drafting contract itself lives in [draft.ts](../src/lib/integrations/draft.ts) (`DraftInput`, `DraftResult`), separate from any one provider, so the retrieval backend can change without touching the graph.

---

## 7. Device execution

[local-agent.mjs](../scripts/local-agent.mjs) is a zero-dependency Node script run on the target machine. It polls `/api/agent/jobs`, claims one, runs a command from its own internal allowlist, and posts the result back. Real capabilities: restart app, clear app cache (including Edge/Chrome profile paths), app status, app event logs, system info, Wi-Fi toggle, and general command/PowerShell execution (`exec.cmd`). macOS and Windows.

The agent is copied onto the target machine by hand. There is no HTTP-served copy and no self-update: an unsigned update channel that also served a token-bearing `setup.ps1` was not worth the convenience.

Auth is one token per device, traded for a single-use enrollment code and stored as a SHA-256. Jobs carry a `deviceId` and are only handed to that machine. The shared `LOCAL_AGENT_TOKEN` survives behind `ALLOW_SHARED_AGENT_TOKEN=1` and can only drain jobs never bound to a device.

### 7.1 Showing the proof

Every job runs `probe → act → probe (→ rollback → probe)`. A probe is a real read on the machine — `pgrep -ix Finder`, `netsh interface ipv4 show dnsservers "Wi-Fi"` — recorded through `runRecorded` with its argv, exit code, stdout and stderr, and reduced to comparable `facts`. The **fact diff between the two reads is the verdict**; an exit code of zero never is.

That was all being captured and none of it was rendered. `formatProofLines` wrote the audit block into `PlanStep.log`, `/api/state` shipped it to the browser on every poll, and no component read it. `proofOf` — the one reader — matched the *first* `[Proof]` line, which is always a probe line, so it returned null for every device job there had ever been.

Now:

- **[Evidence.tsx](../src/app/components/Evidence.tsx)** renders the envelope: each probe with the exact command that produced its facts, the field-level before → after diff, every argv with exit code and full stdout, the rollback outcome, and the journal / change-record / undo paths written on the machine itself.
- **[/api/evidence/[ticketId]](../src/app/api/evidence/[ticketId]/route.ts)** serves it on demand, workspace-scoped, `401` when signed out. Deliberately not on `/api/state`: one envelope carries up to 24 commands × 4000 characters of stdout, and that route is polled every 600ms by every open tab.
- Two surfaces, one component — collapsed under `Technical detail` on the staff ticket, and full-width at **`/audit/<ticketId>`** for putting on a screen in front of someone.
- The redaction caveats are printed on the page. Output is redacted agent-side and again server-side; the product-key pattern is blunt and will blank harmless hyphenated serials, and the on-machine journal is written un-redacted so it legitimately holds more than the page does. Anyone checking the page against the machine hits both, and finding them unannounced looks like concealment.

The claim a viewer is being asked to accept is now checkable at every level: run the probe command yourself, read `~/.bolt-it/journal/<date>.jsonl` on the machine, or check the OS's own log (Windows Application event source `BoltIt`).

---

## 8. Invariants

1. Status transitions happen only in the graph and the ticket Server Actions.
2. No path reaches a high-risk step without the `interrupt()`.
3. Action `kind` is one of `device | backend | reply`. No general-purpose tool. External lookup is deliberately not among them — it touches no company system, so charging it a plan slot, a safety review and an approval decision bought nothing.
4. **Models emit data; the graph emits control flow.** No LLM returns a `goto`. This is what keeps the approval interrupt structural rather than advisory.
5. **The cheap model cannot author a change.** The operator may run any read and any write the strategist authorised — nothing else. Enforced in `authorizeOperatorSteps`, not in a prompt.
6. **A resolution is checked, not trusted.** `resolved` is a model's claim; `resolutionSupported` decides.
7. Adapters return failures, never throw.
8. Components never write to the store. Component → Server Action → `data.ts`.
9. Anything simulated says so, in the log line the user sees.
10. No branching on ticket text or reporter email to force a demo outcome.
11. **One voice to the employee.** Every message they read — intake, working, heartbeat, resolution, rungCheck, handoff, chat — is `COMMUNICATOR_PROMPT` plus a moment instruction. A second prompt for "the final reply" is how the honesty rules stopped applying to two thirds of the messages last time.
12. **One change at a time.** No path runs a second fix while the first is unverified. `nextRungAction` decides, and it is pure.
13. **What the registry claims, the agent's build must be able to do.** `probe` and `rollback` on a `CapabilitySpec` are strings about another file. `probe-binding.test.ts` imports the real agent and asserts both directions per capability, so a promise and a build cannot drift apart in silence.

---

## 9. Known gaps

- `MemorySaver` is in-memory — a restart drops in-flight interrupts. `python-rebuild` uses a Postgres checkpointer. This now also costs a paused ladder: `answerRungVerdict` finds nothing to resume and falls back to a full reopen, which re-observes and re-diagnoses rather than continuing to the next candidate.
- 427 tests. The safety rules in §5 are enforced by policy.test.ts, reviewer.gate.test.ts, intent.test.ts and registry.test.ts; the ladder by ladder.test.ts and ticket-graph.test.ts.
- [data.ts](../src/lib/data.ts) carries ~340 lines of mechanical row↔object mapping and repeats the `isInsforgeEnabled()` branch in ~30 functions.

---

## 10. The remediation ladder

A technician handed five candidate fixes does not run five fixes. They start with the cheapest reversible one, watch, and climb only if it did not help. This system used to do the opposite: the strategist authorised up to six steps, the operator dispatched four in a round, and `runNextStep` drained the queue back to back. A ticket a `fix.restart_app` would have settled also got its application cache cleared — irreversible, taking the employee's local state with it — and afterwards nothing on the ticket could say which of the two had worked.

Three pieces, none of them a prompt:

**Order — [ladder.ts](../src/lib/ladder.ts).** Pure, no I/O, in the shape of `policy.ts`. Cost is derived from the `CapabilitySpec`: `risk * 2` + reversibility (`self` 0, `recorded` 2, `none` 5) + blast radius (`device` 0, `user-session` 1, `directory` 3) + elevation. Reads are 0 and always run first. Sort is cost ascending, then unprovable-last, then likelihood descending, then arrival. So `fix.restart_app` (3) precedes `fix.clear_app_cache` (10), and `ad.reset_password` (15) is last.

The one thing a model contributes is `likelihood` on each authorised step — its belief that *this* candidate is the cause of *this* ticket. It breaks ties **within** a cost tier and can never promote an irreversible fix over a reversible one, however sure it sounds. That is the whole reason the cost is derived rather than asked for: a ticket body can argue with a model's confidence and cannot argue with the registry.

A missing probe is a **tiebreak, not a cost**. `fix.flush_dns` has `probe: null` on purpose — a flushed cache has no diffable before/after fact. Charged as cost it sorted behind `fix.set_dns_servers`, which put rewriting a machine's resolvers ahead of the cheapest and most common network fix in the building.

**One at a time — `nextRungAction` in [ticket-graph.ts](../src/lib/ticket-graph.ts).** Pure and exported, for the same reason `shouldDrainRound` is. Reads run freely; at most one change runs per pass. A change that *lands* sets `landedFix` and the next pass parks. A change that came back `FAILED` or `NO EFFECT` does not — that rung is spent and is climbed immediately, because asking someone "did that help?" about a command that provably did nothing costs them a reply and tells us what we already knew.

**The check — `askEmployeeToVerify` / `awaitEmployeeVerdict`.** A LangGraph `interrupt()`, the same structural pause as the approval gate, and split in two for the same reason (on resume the node re-runs from the top, so the message must live in its own node or it goes out twice). The employee answers through the Yes/No buttons the portal already renders at `awaiting_confirmation`, or by saying so in the thread — `chatWithAgent`'s `still_broken` intent lands in the same place.

Because the run is *paused* rather than finished, "still broken" is the cheapest evidence in the system: the next candidate was already authorised by the strategist, already ruled on by the reviewer and already queued, so climbing costs no model call, no re-observation and no reopen. When the ladder is exhausted and the problem is still there, *that* is a diagnosis problem and it goes back to the strategist for a look — bounded, as always, by `MAX_STRATEGY_ROUNDS`.

What the employee is told matters as much as what runs. The `intake` message lists the reads and the **first** candidate only — the fallbacks behind it usually never happen, and promising them would be the same overstatement the honesty rules forbid everywhere else.
