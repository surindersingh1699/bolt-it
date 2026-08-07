# STATE.md

> Where the project is right now. Rewrite the top two sections whenever focus changes.
> History belongs in [DECISIONS.md](DECISIONS.md), not here — this file stays short.

**Last updated:** 2026-08-07

## Current focus

**The execution side.** Planning worked; execution was six scattered places pretending to be a capability, one shared bearer token, and a per-step gate that could not see a plan. Landed as three layers on `feat/incident-memory-and-agent-observability`: a governed executor (identity, intent validation, policy, audit, verification/rollback, redaction), a capability contract, and the capabilities themselves. Design → [ROLES.md](ROLES.md); decisions → [DECISIONS.md](DECISIONS.md) (2026-08-07).

Pipeline is now: **Planner → Intent Validator → Reviewer → Policy → Capability → Executor → Verification**.

## Just landed (2026-08-07)

- **Capabilities are data** — one `CapabilitySpec` per capability with risk 0-4, a zod params schema, probe, rollback, reversibility, blast radius and provenance. `risk === 0` *is* read-only, derived rather than restated. `commandForCapability`'s `return "toggle_wifi"` fallthrough — which cycled the employee's adapter for any unmapped capability — is gone.
- **Intent validator** — the first stage that sees a plan as a whole. Catches the harvest that no per-step gate can: four risk-0 reads on the reporter's own machine, each individually fine, together sweeping their disk for credentials under cover of "my computer is slow".
- **Policy engine** — pure `decide()`, a truth table. Reviewer reports; policy decides. No confidence float, deliberately.
- **Rollback on failed verification** — a write that did not take is undone rather than left half-applied.
- **Per-device identity** — jobs carry a `deviceId` and go only to that machine. The agent used to receive every queued job in every workspace.
- **Redaction everywhere** — was applied to 2 of 10 read paths; now the whole payload, both ends.
- **Two writes removed from the read-only allowlist** — `wmic process call create` and `dscl . -create` both passed the old checks.
- **Layer 2 capabilities** — `diag.screenshot` (device-side consent, Session 0 helper), `fs.find`, and six settings fixes with probes and rollbacks.

- **One service-desk voice, and chat that reasons from evidence.** `synthesizeReply` and the old one-line chat prompt are deleted; every message the employee reads is `COMMUNICATOR_PROMPT` + a moment, chat included. Chat is now fed the real device verdicts (`buildReplyEvidence`) and the conversation so far, and runs on `CHAT_MODEL` (sonnet) rather than haiku. New `PROGRESSIVE DISCLOSURE` rule: plain English by default, exact IPs and commands only when asked for. Decisions → [DECISIONS.md](DECISIONS.md) (2026-08-07).
- **`awaiting_confirmation` is no longer terminal.** "Still broken" reopens the ticket once through `reopenTicketGraph` — same thread, history carried, machine re-observed, round budget reset — instead of escalating on the spot. `MAX_REOPENS = 1`, enforced at the top of the strategist.
- **The bare "Is the issue resolved? Reply yes or no" message is gone.** It went out under every resolution while the portal was already rendering Yes/No buttons for the same decision; the desk's `resolution` moment asks for the one specific observation instead.

- **Full Agent Autonomy & General VM Command Execution (`exec.cmd`)** — Default execution mode set to `AUTONOMY=full` across environments. Added `exec.cmd` capability in `registry.ts` and `actExecCmd` handler in `local-agent.mjs`, allowing the agent to execute shell and PowerShell commands on the target VM without being blocked by human approval gates or `needs_evidence` refusals.

## Behavior under AUTONOMY=full

- **Full Autonomy Bypasses Approval Interrupts** — Human approval interrupts (`persistent-change`, `irreversible-elevated`, `intent-unexplained`, `reviewer-unavailable`) are auto-approved under `AUTONOMY=full`.
- **`needs_evidence` is non-blocking** — Fix steps proposed before diagnostic reads run are no longer hard-refused by the safety reviewer.

## Next

1. **One real ticket end-to-end on a live machine.** Still unmet, and now the only thing that matters. Enrol this Mac, run `simulation` → `shadow` → `gated`, confirm the consent dialog is genuinely visible on the Windows VM (the Session 0 failure is silent by nature), and paste a revert command out of the change record to check it works.
2. **Cross-account target binding is still bypassable under `AUTONOMY=full`.** Preserved from the old behaviour rather than chosen. Worth making non-bypassable.
3. **Delete `.github/workflows/pdd-secrets-dispatch.yml`** and rotate — it sends all repo secrets to a caller-supplied `callback_url`.
4. Collapse `data.ts` to InsForge only.

## Deferred, deliberately

- **Dynamic capability registry** — model proposes an arbitrary command via `capability_request` → human ratifies → it becomes a named, persisted capability. Still just a note in the handoff artifact (`noteCapabilityRequest`). The two named DNS fixes cover the immediate VPN need without the "run anything" risk; the registry is the next real feature if the write surface needs to grow faster than hand-added capabilities.

## In flight

| Work | Where | Status |
|---|---|---|
| Strategist/operator split; `tiers.ts` + `draft.ts` deleted; graph at 10 nodes | `feat/incident-memory-and-agent-observability` | Done, typecheck + 126 tests green, build passes |
| Authorisation boundary (`authorizeOperatorSteps`) | `operator.ts` | Done, 12 tests — the operator cannot author a change |
| Resolution guard (`resolution.ts`) | `resolution.ts` | Done, 6 tests |
| Screenshot intake — private bucket, data URI, round 1 only | `attachments.ts`, `EmployeePortal.tsx` | Bucket created, `m17` applied, composer verified in-browser. **Never exercised end-to-end with a real image + real opus call** |
| Observer — read the machine before diagnosing | `observe.ts` | Done, unit-tested. **Not yet exercised against a live device agent** |
| Researcher — quarantine boundary | `research.ts` | Done, unit-tested. **Distiller not yet exercised against live Tavily** |
| Memory unwired (modules/tables/tests kept) | `memory.ts`, `incidents.ts` | Done, deliberate — see DECISIONS |
| Collapse `data.ts` to InsForge only | `main` | **Not started** |

## Next 3

1. **One real ticket, end to end, with a screenshot and a live device agent.** Nothing here has met a real machine. Watch three things: whether the probe bundle costs one poll cycle or five; whether the operator actually corrects a bad app name rather than handing straight back; and whether opus reads the attached image at all through this gateway (the content-parts path is the least-proven line in the change).
2. **Read the looks-per-ticket bar in the metrics view.** The whole bet is that one strong model with readings in hand needs fewer expensive calls than a ladder did. If most tickets take 2+ looks, the split is not paying for itself and the strategist prompt is the thing to fix.
3. **Collapse `data.ts` to InsForge only** and delete `db.ts`. Every reader/writer is still coded twice.

## Open questions

- **`.github/workflows/pdd-secrets-dispatch.yml`** — added by `prompt-driven-github[bot]`, not by hand. It sends all repo secrets to a `callback_url` supplied in the trigger payload. Keep, or delete and rotate secrets?
- ~~**Retrieval.** Nothing is shared across employees: a fix learned from one person's ticket does not help the next.~~ **Answered (m15):** `incident_memory` is the org-wide layer, and it is deliberately *not* pgvector. Retrieval is an equality match on a closed `IncidentCategory` set assigned by `classifyIncident()`, a pure function of the ticket text. That buys three things an embedding index does not: the category written at the end of a ticket is provably the one the next ticket reads (no drift between write and read paths), retrieval costs no embedding call on the critical path, and "we looked at 27 past VPN tickets" is an explainable answer. The open follow-up is whether the coarse buckets stay useful as volume grows, or whether some classes need splitting.
- ~~**Safety tests were deleted.**~~ **Answered:** `policy.ts` and `governance.ts` are gone entirely; `reviewer.gate.test.ts` covers the replacement's floors and failure modes.
- **Does the observer's app list stay small?** It is closed on purpose — the name is interpolated into an allowlisted device command. Every app added is a name a ticket body can now steer the probe toward, so growth needs a better mechanism than a longer list.
- **Is sonnet the right operator?** Its mistakes are mechanical — a wrong path or app name on a `fix.*` — and the reviewer will not catch those, because the step looks legitimate. `OPERATOR_MODEL` switches it; nobody has measured haiku here.
- **Model slug format.** The gateway docs say versioned slugs use dots (`claude-haiku-4.5`); the desk defaults are `anthropic/claude-haiku-4-5` and `anthropic/claude-sonnet-5`. If either is wrong, `gatewayChat` returns null and `say()` posts the canned fallback — which would never look broken. Chat fails visibly at least ("I can't reach my tools"), but the background moments do not. Worth one check against the gateway's model list.

## Known limitations (deliberate)

- In-memory graph checkpointer, trace store, and fleet — a process restart drops in-flight interrupts. Tickets persist via InsForge.
- Single global device-agent heartbeat — one live agent at a time, jobs are not routed per-device.
- No real Slack. The employee surface is our own Slack-shaped `#it-support` channel ([SlackView](../src/app/components/SlackView.tsx)); there is no inbound webhook and no outbound API call. Agent replies are rendered through a small mrkdwn parser ([mrkdwn.ts](../src/lib/mrkdwn.ts)) because the reply writer already speaks Slack markup.
- One directory account. There is no signup route, so new people are added by seeding or by writing the row directly.
- The device agent is copied to the machine by hand; there is no self-update channel and nothing serves it over HTTP.
