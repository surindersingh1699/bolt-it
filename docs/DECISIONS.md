# DECISIONS.md

> Append-only. One entry per choice that is expensive to reverse.
> Newest first. Never edit an old entry — supersede it with a new one.
>
> Format: **date — decision.** Why. What it costs. What would reverse it.

---

## 2026-08-07 — First real network-config fixes: `fix.set_dns_servers`, `fix.flush_dns`

The escalation tier can now change the machine's DNS resolvers, not just read
them. `fix.set_dns_servers {service?, servers}` sets the resolver list on a
network service; `servers:"empty"` restores the DHCP-assigned resolvers, which
is the reversal — the same command with the value the probe recorded before the
change. `fix.flush_dns` clears the resolver cache.

**Why.** The whole open read surface could diagnose "VPN connected but nothing
internal resolves" down to a wrong resolver and then had nothing to fix it with,
so the ticket escalated to a human for a one-line change. This closes the most
common self-inflicted network break with a fix whose effect the existing DNS
probe verifies before/after.

**Why not a generic "run any command" capability.** CLAUDE.md rule 3 — every
action is a named capability with a risk tier. `set_dns_servers` is parametric
but bounded: the service name and resolver list are sanitised to service-name
and address tokens in `agent-jobs.ts`, so ticket text cannot reach the command
as anything but an address. The dynamic capability registry (model proposes an
arbitrary command → human ratifies → it becomes a named capability) is the
general form and is still deferred; these two named fixes are what the VPN
scenario actually needs today.

**What it costs.** `set_dns_servers` is at the escalation tier only and is
reviewer-gated like any write. On Windows it needs the agent running as
Administrator; the action returns that as its error rather than silently doing
nothing. Reversible by re-running with the recorded prior list — which the
change record below carries.

**What would reverse it.** Drop both from `T2_CAPS` in `tiers.ts`; the handlers
in `local-agent.mjs` become dead and can be removed.

## 2026-08-07 — Every state change leaves a change record and an OS-log line

Beyond the existing device journal, a state-changing job now writes two more
fingerprints on the machine itself, before the result is uploaded:
`~/.bolt-it/changes/<ticketId>.jsonl` (before/after facts plus the **exact undo
command**), and a line in the OS's own log — the Windows Application event log
(source `BoltIt`, Event Viewer) or `~/Library/Logs/bolt-it.log` on macOS
(Console.app → Log Reports). The revert command and change-record path also ride
back on the execution envelope, so `formatProofLines` documents them on the
ticket.

**Why.** "Leave fingerprints a human finds without knowing this tool exists."
The journal is our format in our directory; the change record answers *how do I
undo this*, and the OS-log line puts the change where a sysadmin already looks,
next to everything else that touched the machine.

**Why the file, not `logger`, on macOS.** Modern macOS filters external
`logger` output out of `log show` by default, so it is not a reliable
fingerprint. The log file under `~/Library/Logs` is retained and shows in
Console.app; `logger` is still emitted as a bonus.

**Verified.** Broke Wi-Fi DNS to `10.99.99.99` and drove the agent's real
`executeJob` for `set_dns_servers empty`: before/after probes recorded
`10.99.99.99 → dhcp`, `effect.changed=true`, and all three fingerprints landed
with the correct undo command. Same `executeJob` the Windows VM runs.

**What would reverse it.** Remove `recordChange`/`writeSystemLog` calls from
`handleJob`; the journal alone remains.

## 2026-08-04 — Nia removed from `main`; no retrieval provider in its place

Deleted `nia.ts`, `nia-sources.ts`, `actions/sources.ts`, `ConnectDocsCard.tsx`, the `niaSources` workspace field, and `migrations/m10_nia_sources.sql`. Drafting now calls `aiGatewayDraft()` directly.

**Why.** Three drafting tiers (Nia → AI Gateway → keyword mock) meant no one could tell which produced a given plan. The Nia tier was gated behind `USE_NIA=1` and off in practice. The mock tier was 176 lines of canned per-tag templates. `python-rebuild` already has pgvector RAG, so the real replacement exists elsewhere.

**Cost.** `main` has no semantic retrieval — the LLM sees runbooks dumped into the system prompt, which does not scale past a few dozen runbooks.

**Reverses if.** Runbook count grows enough that prompt-stuffing degrades plan quality before the FastAPI port lands.

---

## 2026-08-04 — `Citation.source` renamed `"nia"` → `"runbook"`

**Why.** The citation always pointed at a runbook in our own database. It was named after the vendor that happened to retrieve it, so removing the vendor would have orphaned the name.

**Cost.** Any persisted ticket row with `citations[].source === "nia"` renders as an unrecognised source. Affects historical rows only.

---

## 2026-08-04 — Demo special-casing removed from the drafting path

`isDeterministicJudgeDemo()` routed any ticket containing `"cfo"`, `"board meeting"`, `"finance drive"`, or `"frank@acme.test"` to the canned mock planner instead of the LLM.

**Why.** A production code path branching on ticket text to force a rehearsed outcome invalidates every claim the README makes about the agent's reasoning. Rule 9 in CLAUDE.md now forbids it.

**Cost.** Demo scenario 8 (the governance arc) is no longer deterministic — it depends on live LLM output.

---

## 2026-08-04 — Docs split into `docs/`, milestone tracker retired

`ARCHITECTURE.md`, `PROJECT_STATE.md`, and `spec.md` described a system that no longer existed — a serial `executePlan` loop, a Convex schema file that had been deleted, and "no retry" when a 3-attempt replan loop was live.

**Why.** Stale docs are worse than absent ones; they get believed. Replaced with three files that have owners and update triggers: `docs/ARCHITECTURE.md` (what is), `docs/STATE.md` (what now), `docs/DECISIONS.md` (why).

**Cost.** Milestone history M1–M8 is only in git history now.

---

## 2026-08-04 — Backend will move to FastAPI on the `python-rebuild` foundation

Not a fresh rewrite. `python-rebuild` already carries FastAPI + LangGraph + Postgres/pgvector, Alembic migrations, a Postgres checkpointer, an append-only audit table, and real tests. Frontend stays Next.js and talks to it over HTTP.

**Why.** That branch already solves what `main` papers over: durable checkpoints (main loses in-flight interrupts on restart), a real audit trail, and tests.

**Cost.** `python-rebuild` is at main's M1-era feature level. The port is carrying five things across: per-step `interrupt()`, the verify/replan loop, governance auto-promotion, the device agent + fleet, and Slack/Hyperspell.

**Reverses if.** The feature gap turns out to be cheaper to close on `main` than to port.

## 2026-08-05 — Runbooks removed; per-user memory is the only stored knowledge

The runbook library is gone: the seeded set, the auto-extracted entry per
resolved ticket, the `runbooks` table, the Runbooks tab, and the runbook dump in
the planner and verifier prompts. `Citation.source` is now `"memory"` only.

**Why.** Runbooks were a second knowledge system sitting beside `user_memory`,
and the seeded ones had drifted into instructing the planner to use capabilities
that no longer exist (Okta, MDM, Aside). One store, kept true, beats two where
one lies.

**Cost.** Nothing is shared across employees any more. A fix learned from one
person's ticket does not help the next — memory is keyed per user. Tier 1's
contract changes from "match a runbook or escalate" to "match this employee's
own history or escalate", which will escalate more often. On a novel ticket the
only grounding left is `kb.web_search` at tier 2+ and model priors.

**Reverses if.** Escalation rate at tier 1 turns out to be dominated by problems
another employee already had solved.

## 2026-08-05 — One seeded employee, not nine

`RAW_USERS` is Morgan Reilly alone; groups reduced to `everyone` and `it-staff`.

**Why.** Eight of the nine existed to dress a demo. Morgan is the one that cannot
be removed: `approveAndExecute` requires `isITStaff`, so without an IT-staff user
no high-risk step could ever be approved and the interrupt would never clear.

**Cost.** The seeded broken states are gone with bob/frank/eve, so
`ad.unlock_account`, `ad.reset_password` and `ad.refresh_kerberos` have no
account to act on until one is put into a broken state by hand.

## 2026-08-05 — Device work is judged by the device, not by the agent finishing

Every device job is probe → act → probe. The before/after diff is the verdict:
identical state on a fix is recorded `no_effect`, fails the step, and can never
be reported to the user as resolved. The full envelope (argv, exit codes,
stdout/stderr, both probes, the diff) is appended to a journal on the machine
itself before it is uploaded, so the trail survives the network and the server.

Reversing this means going back to trusting an agent's prose about its own work.

## 2026-08-05 — Deleted every adapter that had no real backend

Aside (browser actions), Tensorlake (sandbox), the Vercel-sandbox log reader,
and the Okta / MDM / identity.verify branches of the InsForge adapter were all
narration: sleeps plus log lines claiming work that never happened. They are
gone, along with the capabilities that referenced them. `ActionKind` is now
`device | backend | reply`, and the planner's capability list contains only
capabilities that are really implemented — so a fake plan cannot be drafted.

## 2026-08-05 — Slack OAuth and the demo-workspace flow removed

The in-app conversation thread (`SlackChat` + `chat.ts`) stays; the real Slack
install, events, callback and disconnect routes are gone, as are the demo
workspace minting/cookie/cron, the signup page, and the agent self-update +
`public/setup.ps1` (which served a file with the agent token embedded).

## 2026-08-05 — Hyperspell replaced by a `user_memory` table

Hyperspell's user context was a hardcoded mock map, and its memory search was
an external dependency for data we already own. Memory is now one small table:
keyed facts (nickname, office, timezone, device, …) upserted in place, plus one
episode per ticket. Written by an LLM extractor at finalize, read at draft.
LangGraph's own store was considered and rejected: it needs an embeddings model
for search and is lost on restart, which would have meant two memory systems.

## 2026-08-05 — Risk classification is an allowlist, no LLM judge

With ~10 real capabilities the judge was a moving part that could be wrong,
unavailable, or prompt-injected. `policy.ts` is now a lookup across low/medium/
high sets; anything unlisted is high risk and needs a human.

## 2026-08-05 — UI rebuilt as a light, two-audience surface; demo cast deleted

The dark console showed one screen to everybody and led with the graph's own
vocabulary — Console/Chat/Runbooks tabs, an autonomy metrics strip, a LangGraph
node diagram, per-step risk badges. That is the debugging view, not the product.

Two surfaces replaced it, split by who is reading:

- **IT staff — [InboxView](../src/app/components/InboxView.tsx) +
  [TicketDetail](../src/app/components/TicketDetail.tsx).** Nav by what the
  ticket needs ("Needs your approval", "Working now", …), then list, then
  detail. The `interrupt()` gate renders as one blue card with two buttons, in
  the same place every time.
- **Everyone else — `MyTicketView`.** A vertical stepper answering one question:
  who is waiting on what, and when am I unblocked. One composer files, replies,
  and confirms. *(Superseded 2026-08-06 by `SlackView`; see the entry at the end
  of this file.)*

Both read [ticket-view.ts](../src/app/components/ticket-view.ts), so the same
state is worded the same way on both. Proof-of-effect is now a sentence a human
reads ("Ran cleanly, but nothing on the machine changed"), not a log prefix.

Deleted, not restyled: `Console`, `TicketQueue`, `ActiveTicket`,
`KnowledgeSidebar`, `DeflectionDashboard`, `AgentGraphView`, `AgentTracePanel`,
`SlackChat`, and the whole `DeflectionStat` path from `/api/state` through
`data.ts` and `db.ts` — it fed a metrics strip that no longer exists and was
recomputed on every 600ms poll. Node names, capability ids, risk tiers and the
graph trace survive behind a "Technical detail" disclosure in `TicketDetail`;
they are still the fastest way to debug a bad run, they just no longer lead.

The seeded cast (Alice, Bob, Carol, Dan, Eve, Frank, Priya, Morgan, Sam), their
one-click login panel, 65 leftover `demo-*` workspaces and every ticket in the
database were deleted. `seed.ts` now creates exactly one IT-staff account and no
device: the only machine that should appear in the fleet is one a local agent
actually connected from.

## 2026-08-05 — Incident memory is a closed category set, not a vector index

**What.** Added `incident_memory` (m15): one row per ticket, keyed by an
`IncidentCategory` assigned by `classifyIncident()` — a pure keyword function of
the ticket text. Retrieval is an equality match on that category. No embeddings,
no pgvector, no similarity threshold.

**Why.** The obvious design was semantic search over past tickets. Three reasons
it lost:

1. **Write and read must agree.** The category is needed *before* drafting (to
   retrieve) and again at the end (to store). Any model-assigned label can
   assign two different buckets to the same ticket, which breaks retrieval
   silently — the bucket looks empty and nobody notices. A pure function cannot
   disagree with itself.
2. **Latency on the critical path.** An embedding call sits between the employee
   filing and the agent starting. The keyword pass costs nothing.
3. **Explainability.** "We looked at 27 past VPN tickets" is auditable. "Cosine
   similarity 0.92" is not something an IT manager can check.

**The cost, stated plainly.** Coarse buckets miss cross-category patterns, and
"other" is a real bucket that will collect genuine problems. Revisit if a
category's volume makes it useless — the fix is splitting a category, not
reaching for embeddings.

**Success rates are earned, not estimated.** `summarizeIncidents` credits a
capability only where it was the `resolvedBy` — the step that moved the machine
per before/after probes. A diagnostic that merely ran in a ticket that later
resolved gets no credit; counting it would inflate every probe to near-100% and
send the next planner at a step that changes nothing. This is why the rates can
be trusted more than asking a model for a success probability, which was the
alternative considered and rejected.

## 2026-08-05 — Reviewer gained a fourth verdict, and the verdicts split two ways

**What.** `needs_evidence` joins `allow` / `ask_human` / `block`. It refuses a
*change* whose justification rests on a cause nothing in the executed history
established. Read-only steps are exempt by construction — gathering evidence on
a hunch is correct.

**Why the split matters.** `allow` / `ask_human` answer *is this safe to run
unattended* — a scheduling question, which `AUTONOMY=full` may overrule.
`block` / `needs_evidence` answer *should this run at all* — and autonomy never
overrules those. There is no human to route a refusal to under full autonomy, so
bypassing would not remove a wait; it would just run the step the reviewer
identified as wrong.

**Cost.** One more way for a correct plan to be refused, and it is an LLM
judgement so it will sometimes be wrong. Mitigated by the read-only exemption
and by the refusal landing in the handoff artifact with its reason, so a
false refusal is visible rather than silent.

## 2026-08-05 — One gateway helper; failure is `null`, always

**What.** Six near-duplicate `fetch` blocks collapsed into `gatewayChat`
([src/lib/integrations/gateway.ts](../src/lib/integrations/gateway.ts)). It owns
transport, timeout, response shape and token accounting.

**Why.** The copies had already drifted in their timeouts and their logging, and
adding cost accounting would have meant editing all six identically and hoping.
The contract is deliberately narrow: `string | null`, where null always means
"no usable answer" regardless of cause. That single meaning is what lets every
caller fail closed with one check instead of enumerating failure modes.

**Cost.** Callers lose the ability to distinguish a timeout from a 500. Nothing
upstream branched on that distinction, and the usage ledger records it anyway.

## 2026-08-05 — Execution moved out of the orchestrator into a registry

**What.** The four-branch `if/else` inside the graph's execute node became
`EXECUTORS: Record<ActionKind, StepExecutor>` in
[src/lib/executors.ts](../src/lib/executors.ts). `executeStepAndPersist` now
does lifecycle only: mark running, dispatch, record.

**Why.** The graph decides WHAT to do and in what order; that is orchestration.
Deciding HOW a command reaches a machine is a different concern with a different
rate of change — the plan shape has been stable, while the execution surfaces
(SSH, Intune, SCCM, a REST endpoint) are exactly what a deployment will want to
vary. Mixing them meant every new surface was an edit to the file that owns the
approval `interrupt()`, which is the single worst place in this codebase to
invite unrelated churn.

**The safety argument, explicitly.** `runNextStep` applies the approval gate and
*then* calls the dispatcher. Because executors are reached only through that
dispatcher, a new executor cannot introduce a path to a high-risk step that
bypasses the gate — it is structurally downstream of it. Adding a branch inside
the old `if/else` had no such guarantee beyond care.

**Contract, kept from the old code.** Executors never throw and always name a
`StepFailureKind` on failure. The dispatcher still catches as a backstop, but an
executor relying on that backstop is a bug.

## 2026-08-06 — Escalation became a state update; the planner became re-entrant

**What.** The context fan-out now joins at a new `contextReady` node instead of
at the planner, leaving `draftPlan` with exactly one unconditional predecessor.
`escalateTier` — 110 lines that re-ran draft, review, persist and notify by hand
— is deleted. `escalate()` writes `{ tier: next, attempt: 1 }` and jumps back to
the planner.

**Why.** The old duplication existed for a mechanical reason, recorded in the
code at the time: a node behind a multi-predecessor barrier join cannot be
re-entered alone, so escalation could not loop back and had to re-implement the
path. Moving the join removed the constraint, and removing the constraint removed
the duplicate.

**The safety argument, explicitly.** A second draft-review-persist path is a
second chance to reach a high-risk step without passing the approval
`interrupt()`. The first copy was audited; nothing guaranteed the second stayed
in step with it. `ticket-graph.test.ts` now asserts both that `escalateTier` is
absent and that exactly one unconditional edge enters the planner.

**Cost.** The graph has a real cycle now, so `recursionLimit` is raised from
LangGraph's default of 25 to 100. The bound still exists; it just no longer fires
on a legitimately deep ticket.

## 2026-08-06 — The machine is read before anything is planned

**What.** A new `observe` node runs a fixed read-only probe bundle on the
employee's machine on the START fan-out, and the planner drafts against the
readings. Previously the planner proposed read-only steps to acquire its own
evidence.

**Why.** Each of those steps cost a reviewer call, a risk classification, an
approval decision, a device round trip, and a whole verify/replan round before
anything could act on the result — to read a log file. Reads are free and
reversible, so they need none of that machinery. The knock-on effect is the real
one: a first-round plan used to rest on a diagnosis nothing had established,
which is precisely what the reviewer's `needs_evidence` verdict refuses.

**Cost, and the mitigation.** Every ticket now pays for device probes, including
tickets that would not have needed them. The bundle is enqueued in full before
any job is awaited, so it costs one agent poll cycle rather than one per probe,
and a missing device or a dead heartbeat returns immediately instead of spending
the 45s job timeout finding out.

**What could go wrong, and what stops it.** The bundle runs with no reviewer and
no approval gate, which is sound only while it cannot change the machine — so the
bundle is `diag.*` only, asserted in `observe.test.ts`. The probed app name comes
from a closed list, because it is interpolated into an allowlisted device command
and free extraction would make the ticket body command input.

## 2026-08-06 — Three tiers became two; the cheap rung was a router

**What.** `Tier` is `1 | 2`. Rung 1 is a sonnet systems engineer holding the old
tier-2 capability set; rung 2 is an opus escalation engineer holding the old
tier-3 set. The haiku rung is gone from planning and survives only as the
service-desk voice.

**Why.** The old rung 1's prompt told it to act only on a memory match and
otherwise escalate. That is a router expressed as a model call, and two things
now do the same job from data: `incident_memory` supplies the track record for
the problem class, and `observe` supplies the machine's readings. A planner
holding real evidence is doing diagnosis; making it the cheapest model available
was the wrong trade. The escalation round rung 1 spent on almost every ticket
pays for the stronger model.

**Cost.** Trivial tickets that a haiku call could have closed now start on
sonnet. If that shows up in the token ledger, the lever is a memory-match fast
path gated on `incidents.capabilities[].successRate` clearing `MIN_SAMPLES` —
cheaper *and* better grounded than the prompt heuristic it would replace.

**Migration note.** Ticket rows written under the three-rung ladder still hold
`tier = 3`. `data.ts` clamps on read rather than casting, so a legacy row reads
as the deepest rung instead of falling out of the metrics roll-up entirely.

## 2026-08-06 — Web lookup left the plan and became a quarantine boundary

**What.** `ActionKind` loses `knowledge`; `kb.web_search` and `kb.fetch_page` are
no longer capabilities. [research.ts](../src/lib/research.ts) is a graph node that
answers one question and returns at most five one-sentence claims, each attributed
to a URL actually retrieved in that round. [knowledge.ts](../src/lib/integrations/knowledge.ts)
is now transport only.

**Why, part one — cost.** A search touches no company system and changes nothing,
so charging it a plan slot, a safety review and an approval decision bought
nothing.

**Why, part two — and this is the real reason.** Raw page text used to land in the
ticket log and flow from there into the planner, the verifier and the reply
writer, protected only by fence markers and an instruction not to obey what was
inside them. Every one of those prompts was an injection surface. Now raw text
enters the distiller and never leaves it: the surface is one prompt, in one file,
that can be reasoned about.

**The guarantees that make it a boundary, not a filter.** A `ResearchFinding` has
no field that can carry a command, a path or a capability id — a page cannot
propose its own remediation. A claim whose `source_url` was not retrieved this
round is dropped, so the distiller cannot smuggle in its own opinion wearing a
citation. With no distiller available nothing is admitted at all, because nothing
has read the pages for instructions. Text addressed to the reader comes back as a
`flag` and reaches the handoff artifact rather than being silently discarded.

**Cost.** The planner can no longer search mid-plan; it asks via
`research_question` and is re-invoked with the answer. Bounded at two rounds per
ticket across both requesters, since neither knows the other asked.


## 2026-08-06 — The employee surface became our own Slack, not an integration with Slack

`MyTicketView` — the vertical stepper with a composer under it — is deleted.
Employees now land in [SlackView](../src/app/components/SlackView.tsx): a
`#it-support` channel, a **Bolt IT** app in the sidebar with an `APP` badge next
to its name, day dividers, message grouping, and a right-hand details pane
carrying the plan and proof-of-effect that used to be the stepper.

**Why not real Slack.** A working Events API integration was built first and
thrown away: signature verification, thread↔ticket binding, `chat.postMessage`
mirroring. It worked, and it was the wrong thing — it needs a workspace, a bot
token, a publicly reachable URL and five OAuth scopes before anyone can type a
sentence, and it puts employee ticket text on a third party's servers. The value
was never the Slack API; it was that people report IT problems by messaging a
colleague. That shape is reproducible in one file with no infrastructure.

**What is deliberately unchanged.** The composer routes through exactly the
server actions the old one did — a yes/no answers a pending confirmation, an
ambiguous message continues the recent ticket, and `chatWithAgent` files a fresh
ticket itself when the message turns out to be a different issue. This is a skin
over identical routing, not a second intake path, which is what keeps rule 9
(no demo special-casing) true.

**One new pure module.** The reply writer already emits Slack mrkdwn — it is
prompted for Slack plain text, and does — so the channel renders it through
[mrkdwn.ts](../src/lib/mrkdwn.ts) rather than showing `_Ticket T-6970_` raw.
Markers only bind at a word boundary — an identifier the agent quoted off a
machine, `snake_case_name`, must not come back italicised with its underscores
eaten. Unmatched markers stay literal: the failure mode is "reads as itself",
never "swallows the line".

## 2026-08-07 — Two models, split by what the work is worth

**What.** The tier ladder is gone entirely. In its place: a **strategist** (opus,
[strategist.ts](../src/lib/strategist.ts)) that diagnoses and *authorises*
actions, and an **operator** (sonnet, [operator.ts](../src/lib/operator.ts)) that
carries them out. The graph is ten nodes; `tiers.ts` and `integrations/draft.ts`
are deleted.

**Why.** Diagnosis and execution are different jobs with different values.
Working out that a stale Kerberos ticket explains a symptom pattern is worth an
opus call; discovering the app is registered as "Microsoft Outlook" rather than
"Outlook" and retrying is not — and most of a ticket's rounds are the second
kind. The old ladder charged the same model for both and then charged a *second*
model to escalate.

**The shape.** Inner loop `operator ⇄ execute`, up to 3 rounds per strategy, on
sonnet. Outer loop `strategist`, up to 3 looks per ticket, on opus. Execution
returns to the operator, never straight to the strategist —
`ticket-graph.test.ts` asserts that edge, because losing it silently turns every
mechanical retry into an opus call.

**Cost, stated honestly.** A ticket that needs no correction is now more
expensive than the old tier-1 haiku path. A ticket that needed one escalation is
cheaper. The bet is that the second case dominates, and the metrics view was
rebuilt around looks-per-ticket specifically to check it.

## 2026-08-07 — The cheap model may not author a change

**What.** `authorizeOperatorSteps` splits the operator's proposed steps into what
it may run and what it overstepped on: any read, always; a write only if the
strategist authorised that capability; nothing outside the closed set, ever.
Matched on capability rather than on the whole step, so correcting parameters is
allowed and substituting a different fix is not.

**Why.** A model that can pick any capability is a planner. Without this, the
system would have two planners — a good one and a cheap one — and the discipline
that a change must trace to an observation lives only in the strategist's
prompt. The specific failure it prevents is the operator deciding on its own
that clearing the cache is the obvious next thing, which destroys the employee's
local app state.

**Why it is in code.** The operator's input includes the employee's ticket text.
A prompt rule can be argued with; an `if` cannot. Same reasoning as the
reviewer's `ALWAYS_ASK` floor.

**Not silently dropped.** An overreach sets `blocked` with the specifics, so the
strategist is asked whether that action was actually right. Dropping it quietly
would hide a real disagreement between the two models.

## 2026-08-07 — Resolution is a claim, checked in code

**What.** [resolution.ts](../src/lib/resolution.ts) refuses `resolved: true` when
nothing has executed, or when every step failed or left the machine unchanged. A
refusal costs a round and lands in the findings.

**Why.** The verifier used to run on a deliberately different model from the
planner, because a model grading its own work declares `resolved: true` on
nothing — and that is what tells an employee their problem is fixed. Merging
diagnosis and judgement into the strategist gave that guarantee up, so it had to
be replaced rather than dropped.

**Why this is stronger than the second model was.** A prompt can be talked out of
its position by a confident log line or its own momentum. This cannot. The
model's `resolved` is data; the graph decides whether the ticket finishes.

**The bar, and why it is not higher.** Deliberately not "there must be a VERIFIED
CHANGE": a question ticket — "what is my hostname?" — is resolved by a read that
changes nothing, and demanding a mutation would make every such ticket
permanently unresolvable.

## 2026-08-07 — Screenshots go to the expensive model, unmediated

**What.** A reporter can attach images. They are uploaded to a **private**
InsForge bucket (`ticket-attachments`), fetched server-side as base64 data URIs,
and sent to the strategist on its **first look only**. `gatewayChat` gained a
`GatewayContent` union; no new dependency — the gateway endpoint is
OpenAI-compatible and already accepts content parts.

**Why not have the cheap model transcribe it.** That was the alternative, and it
saves real tokens. It also means the expensive model diagnoses from a lossy
summary of the evidence rather than the evidence — giving up exactly the thing
that makes a screenshot worth attaching.

**Why private, and why data URIs.** A support screenshot routinely contains an
inbox, a document or a customer record. Making the bucket public so an image URL
could be fetched would be the wrong trade, and a data URI has no signed-URL
lifetime to get wrong.

**Why the upload happens before the row is inserted.** `createTicket` starts the
graph from `after()` the moment the ticket exists, and the strategist's first
call reads the attachments. Uploading afterwards races that — the screenshot
would arrive sometimes, which would read as model flakiness rather than as a
race.

**Cost.** Round 1 pays image tokens on opus. Later rounds pay nothing: the
strategist has written down what it saw.

## 2026-08-07 — Memory unwired, not deleted

**What.** `user_memory` and `incident_memory` have no callers. The modules,
tables, migrations and tests are all still there, with a header comment saying
so.

**Why.** Both were pulled out of the graph to get the loop simple enough to
judge. Neither was wrong — incident memory in particular is the cheapest useful
signal in the system, since it costs one indexed read and no model call. They
come back once the two-model loop is proven on real tickets.

**Why not delete.** Deleting would mean re-deriving the schema, the closed
category set and the write-path discipline later. The cost of leaving them is a
header comment.

