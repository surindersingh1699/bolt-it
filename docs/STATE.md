# STATE.md

> Where the project is right now. Rewrite the top two sections whenever focus changes.
> History belongs in [DECISIONS.md](DECISIONS.md), not here — this file stays short.

**Last updated:** 2026-08-07

## Current focus

Making the agent do **real, reversible fixes on the machine** and leave fingerprints, on top of the role-restructured graph. Landed on `feat/incident-memory-and-agent-observability`: observation before planning, a re-entrant planner, two depth rungs instead of three, web lookup behind a quarantine boundary (design → [ROLES.md](ROLES.md)), and now the first network-config write fixes plus a change-record/OS-log fingerprint layer verified against the agent's real execution path. Design → [ROLES.md](ROLES.md); the fix + fingerprint decisions are in [DECISIONS.md](DECISIONS.md) (2026-08-07).

## Just landed (2026-08-07)

- **`fix.set_dns_servers` + `fix.flush_dns`** — first device writes beyond restart/cache/wifi. Escalation tier only, reviewer-gated, fully reversible. Makes the "VPN connected but nothing resolves" scenario resolve for real with before/after DNS-probe proof.
- **Fingerprint layer** — every state change writes `~/.bolt-it/changes/<ticketId>.jsonl` (with the exact undo command) and an OS-log line (Windows Application event log / macOS `~/Library/Logs/bolt-it.log`), alongside the existing journal. Revert command + change-record path ride back on the envelope onto the ticket.
- **Dead code removed** — `CapabilityPrecedent` + `db.ts` precedent maps, `PlanStep.governancePromoted`, unused `isAgentJobCapability`.
- **Verified on the real path** — `local-agent.mjs` is now importable (guarded entrypoint); a harness drives the actual `executeJob` for a DNS break→fix on this Mac. Same code the Windows VM runs. typecheck clean, 118 tests green.

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
- **Model slug format.** The gateway docs say versioned slugs use dots (`claude-haiku-4.5`); the desk default is `anthropic/claude-haiku-4-5`. If that is wrong, `gatewayChat` returns null and `say()` posts the canned fallback — which would never look broken. Worth one check against the gateway's model list.

## Known limitations (deliberate)

- In-memory graph checkpointer, trace store, and fleet — a process restart drops in-flight interrupts. Tickets persist via InsForge.
- Single global device-agent heartbeat — one live agent at a time, jobs are not routed per-device.
- No real Slack. The employee surface is our own Slack-shaped `#it-support` channel ([SlackView](../src/app/components/SlackView.tsx)); there is no inbound webhook and no outbound API call. Agent replies are rendered through a small mrkdwn parser ([mrkdwn.ts](../src/lib/mrkdwn.ts)) because the reply writer already speaks Slack markup.
- One directory account. There is no signup route, so new people are added by seeding or by writing the row directly.
- The device agent is copied to the machine by hand; there is no self-update channel and nothing serves it over HTTP.
