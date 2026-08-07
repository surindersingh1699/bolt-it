# Roles — design

> How the ticket loop is split between models, and why the splits are where they
> are. Supersedes the tier ladder entirely. Graph wiring →
> [ARCHITECTURE.md](ARCHITECTURE.md). Irreversible calls → [DECISIONS.md](DECISIONS.md).

**Verified against the code on:** 2026-08-07

---

## The one rule everything hangs off

**Models emit data. The graph emits control flow.**

No LLM in this system returns a node name. The strategist returns a diagnosis
and an authorisation; the operator returns steps and a status; the reviewer
returns a verdict; the researcher returns claims. What runs next is decided by
`Command({goto})` in code you can read and test without a model.

This is not stylistic. `runNextStep` applies the approval `interrupt()` *before*
it dispatches anything. A model that could choose the next node could choose the
one after the gate. A supervisor-agent pattern — one LLM picking which
specialist runs — costs exactly that, which is why this system does not use one.

---

## The roles

| Role | Model | Called | Job |
|---|---|---|---|
| **Observer** | none | once, first | Read the machine before anyone reasons about it |
| **Strategist** | opus | rarely | Diagnose. Authorise actions. Judge the result |
| **Operator** | sonnet | often | Carry the authorisation out; clear roadblocks |
| **Reviewer** | sonnet | per step | Is this safe to run unattended |
| **Researcher** | sonnet | on request | Outside knowledge, distilled and attributed |
| **Desk** | haiku | every message | The only voice the employee hears |
| **Executor** | none | per step | Actually run it on the machine |

Two of the seven have no model at all. Observation and execution are the parts
that touch reality, and neither needs to reason about anything.

---

## Why the strategist and the operator are different models

This is the central bet, so it is worth stating plainly.

Diagnosis is hard and rare. Working out that a stale Kerberos ticket explains a
symptom pattern is worth an opus call. Discovering that the app is registered as
"Microsoft Outlook" rather than "Outlook", noticing that a path moved, and
retrying with the corrected parameter is not — and **most of a ticket's rounds
are the second kind**.

So the loop is nested:

```
strategist (opus) ──authorises──► operator (sonnet) ⇄ execute
     ▲                                   │
     └──── done, or blocked ─────────────┘
```

The inner loop runs up to `MAX_OPERATOR_ROUNDS` (3) times per strategy and costs
sonnet. The outer loop runs up to `MAX_STRATEGY_ROUNDS` (3) times per ticket and
costs opus. A ticket that needs four mechanical corrections pays for four sonnet
calls and one opus call, not five opus calls.

The operator hands back for exactly two reasons: the authorised actions are done
(`strategyComplete`), or something needs a diagnosis rather than a correction
(`blocked`). Handing back is not failing — a wrong parameter guessed twice costs
more than one honest hand-back, and the prompt says so.

---

## The authorisation boundary

**The operator may not author a change.** This is the load-bearing constraint,
and it is in code — `authorizeOperatorSteps` in [operator.ts](../src/lib/operator.ts) —
not in a prompt, because a prompt can be argued with by a ticket body and an
`if` cannot.

| The operator may | The operator may not |
|---|---|
| run any **read** (`diag.*`, `fs.*`, `ad.lookup_user`), any time | run a `fix.*` or `ad.*` write the strategist did not authorise |
| correct the params on an authorised write, and retry it | invent a capability outside the closed set |
| reorder or skip authorised actions | decide the ticket is resolved |
| — | write to the employee |

Matching is on the **capability**, not the whole step: correcting the app name on
an authorised `fix.restart_app` is the operator doing its job; introducing an
unauthorised `fix.clear_app_cache` is not. `ad.lookup_user` is on the read list
despite its prefix, which is why the split is an explicit list rather than a
prefix test — getting that wrong in the permissive direction would let a cheap
model author a mutation.

An overreach is not silently dropped. It sets `blocked` with the specifics, so
the strategist gets asked whether that action was actually right.

The reviewer still rules on everything that survives this. **Authorisation and
safety are different questions and both still get asked.**

---

## Observation before diagnosis

`observe` runs a fixed read-only bundle on the START edge, before the strategist
is called at all:

```
diag.system_info · diag.process_list · diag.network_state
  + diag.app_status, diag.app_logs   (when the ticket names an app we probe)
```

The whole bundle is enqueued before anything is awaited, so it costs one agent
poll cycle rather than one per probe. No device or no heartbeat returns
`collected: false` immediately — no 45-second wait to find out — and that answer
reaches the prompt verbatim, because a model that thinks it has evidence it does
not have is worse than one that knows it is guessing.

Three properties, all asserted in [observe.test.ts](../src/lib/observe.test.ts):
the bundle is `diag.*` only (it runs with no reviewer and no gate, which is
sound only while it cannot change anything); the probed app comes from a closed
list (the name is interpolated into an allowlisted command, so free extraction
would make the ticket body command input); and absence is reported rather than
hidden.

---

## Screenshots

The reporter can attach one. It goes to the **strategist**, directly, on its
first look — not transcribed by a cheaper model first. The premise of this whole
design is that a strong model pinpoints the problem from what it can see, and
handing it a lossy text summary of the evidence instead of the evidence gives
that up to save tokens on the one call where they are worth spending.

Mechanically: private bucket, uploaded **before** the ticket row is inserted (the
graph starts from `after()` the moment it exists, so uploading afterwards races
the first read), fetched server-side as a base64 data URI, and sent on round 1
only — the strategist writes down what it saw, so later rounds pay nothing.

The bucket is private on purpose. A support screenshot routinely contains an
inbox, a document or a customer record; making it public so an image fetch can
reach it would be the wrong trade.

---

## Resolution is claimed by a model and checked by code

The strategist both plans and judges. That merge gave up a real guarantee: the
verifier used to run on a deliberately different model, because a model grading
its own work declares `resolved: true` on nothing — and `resolved: true` is what
tells an employee their problem is fixed.

[resolution.ts](../src/lib/resolution.ts) replaces it, and is strictly stronger.
`resolved` is **data**; whether the ticket finishes is the graph's decision:

- nothing executed → refused
- every step failed or left the machine unchanged → refused
- otherwise → allowed

Deliberately *not* "there must be a VERIFIED CHANGE": a question ticket ("what is
my hostname?") is resolved by a read that changes nothing, and demanding a
mutation would make every such ticket permanently unresolvable.

A refused resolution costs a round and the reason lands in the findings.

---

## Failure routing

Which model gets a failure depends on what kind it is — that is the difference
between "removing roadblocks" and "re-diagnosing".

| Failure | Goes to | Why |
|---|---|---|
| `execution`, `timeout` | operator | Mechanical. A corrected retry may fix it |
| `no_effect` | operator, which must not retry | It ran and nothing moved; the prompt forbids repeating it, so it hands back |
| `policy_block` | strategist | The reviewer said the step does not follow from the ticket. No parameter fixes that |
| `unsupported_assumption` | strategist | The reviewer said the diagnosis was not established. That is a diagnosis problem by definition |

---

## What did not change

Worth stating, because the churn around it makes it easy to assume otherwise:

- The reviewer's three floors — `ALWAYS_ASK`, target binding, fail-closed — are
  untouched, and autonomy still cannot bypass `block` or `needs_evidence`.
- The `interrupt()` gate and the `Command({resume})` path are untouched.
- The executor registry is untouched; a new execution surface is still an
  executor plus a registry entry, never an edit to the graph.
- `deriveJobStatus` and the `no_effect` verdict are untouched. A fix that ran
  cleanly on an unchanged machine still fails its step.
- The researcher's quarantine boundary is untouched: raw page text enters the
  distiller and never leaves it.

## What is unwired, deliberately

`user_memory` and `incident_memory` are still on disk, still have their tables,
and still have their tests — nothing calls them. They are the first thing to come
back once the loop is proven on real tickets. Re-wiring each is an import and one
line of prompt context.
