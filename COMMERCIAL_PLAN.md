# Commercial plan — IT Copilot

> A path from "well-engineered demo" to "thing IT directors will pay for."
> Written 2026-05-16 to coexist with the technical [README.md](README.md) and
> the Phase 1 build plan at `~/.claude/plans/hi-i-want-to-synthetic-mist.md`.

---

## 1. What we have today (and what it's worth)

**Today:** A Python service that runs the full agent loop — RAG over runbooks,
capability-scoped tool calls, hard human approval gate, DB-enforced audit log,
prompt-injection defenses, idempotency, checkpointed resumption via LangGraph.
All tools are mocked against a local Postgres `users` table.

**Worth to a CIO:** **$0.** Nothing in this list maps to "fewer tickets," "faster
resolutions," or "smaller MSP bill." It demonstrates we *can build* the agent
correctly — it doesn't yet *do* anything.

That's fine. The technical bar (audited, capability-scoped, structurally
gated) is genuinely hard and is the moat. We now need to attach it to the
systems where work actually happens.

---

## 2. Where the money is

### Market sizing (rough)

| Segment | Seats | Current IT spend per seat/year | Tooling spend per seat/year | Total addressable |
|---|---|---|---|---|
| US SMB (10–200 seats) | 50M | $600–1,200 | $100–300 | $30–60B |
| US mid-market (200–2,000) | 30M | $400–800 | $200–400 | $20–35B |
| MSPs serving SMB | ~30k firms | — | $200/tech/mo for stack | $5B |

The bulk is in mid-market companies that have **outgrown their MSP** and are
unwilling to pay ServiceNow prices but have real IT load. They currently
either (a) drown in tribal-knowledge Slack tickets or (b) pay an MSP $80–200
per seat/month with painful timezone gaps.

### Who is paying for what today

| Vendor | Pricing | What buyers get | Pain |
|---|---|---|---|
| **ServiceNow ITSM** | $100–200/agent/mo + heavy SI | Everything, configurable | $200k+ first-year TCO, 6-month deploy |
| **Zendesk Support** | $55–115/agent/mo | Helpdesk + KB | Generic; AI bolted on |
| **Jira Service Mgmt** | $20–45/agent/mo | Cheap entry ITSM | Workflow gymnastics |
| **Freshservice** | $19–99/agent/mo | SMB-friendly ITSM | Limited automation |
| **Atera (MSP)** | $89–189/tech/mo (all-you-can-eat) | RMM + ITSM bundled | Generic AI suggestions |
| **Halo ITSM** | ~$45/agent/mo | Configurable ITSM | UX dated |

**Common gap:** AI in all these is bolted-on — it *suggests*, the human still
*does*. Nobody yet ships a product where the agent **actually performs the
fix under approval** with audit and per-step risk classification.

### Our wedge

> **"Audited AI agents that execute the fix, not the suggestion."**

Quantifiable claim we can defend with the architecture we've already built:

- L1 ticket today: 20–40 min of human-attended work (triage + remote session)
- Same ticket on us: 15s to drafted plan, 1 click to execute, ~3s of compute
- Even non-deflectable tickets arrive at a human with the evidence pack
  pre-built (runbook citations + diagnostic outputs from the sandbox tools)

For a 500-seat company at ~12 tickets/week/seat-equivalent, that's the
recoverable labor of one full FTE technician — call it $90k/year. Even at
$30/seat/mo ($180k/year for 500 seats), the ROI is 2x within year 1.

---

## 3. Pricing & packaging (the testable bet)

Three pricing axes; pick **one to lead with**, keep the others as
upsell/positioning:

| Model | Lead with this if… | Pros | Cons |
|---|---|---|---|
| **Per-seat-supported** ($8–15/employee/mo) | Selling to mid-market direct | Predictable, aligns with org size | Hard sell if customer doesn't know their ticket volume |
| **Per-deflected-ticket** ($1–2 each) | Selling to MSPs reselling to their book | Pure value-aligned pricing | Need attribution; finance teams dislike variability |
| **Per-agent (technician)** ($89–149/agent/mo) | Replacing/competing with Atera/Freshservice | Familiar to buyers | Misses the value (we replace agent *work*, not agent *seats*) |

**Recommended lead pricing for v1:** *Per-seat-supported with a deflected-ticket
SLA guarantee.* "$10 per employee per month or 50¢ per ticket, whichever is
lower; we guarantee 50% deflection on auth/access/password categories or your
month is free."

That bundles a sales handle (clean per-seat number) with a deflection
guarantee that proves we believe our own claim.

---

## 4. Where we are weak today (must-fix to charge anything)

| Gap | Severity | Why it kills the sale |
|---|---|---|
| **No real connectors** | P0 | Demo runs on a local `users` table. Buyers want Okta/Azure AD/Google. |
| **No auth / RBAC / SSO** | P0 | Every IT buyer requires SAML / SCIM. Stub user is `morgan@acme.test`. |
| **No multi-tenant isolation** | P0 | Customer A must never see Customer B's tickets/runbooks/audit. |
| **No SLA tracking** | P1 | "Open tickets" without P1/P2/P3 + breach alerts is a toy. |
| **No routing / queues / on-call** | P1 | Tickets need to flow to the right team at the right time. |
| **No ticket conversation thread** | P1 | Real ITSM is a back-and-forth, not a single submission. |
| **No real Slack/Teams/email intake** | P1 | "Curl this endpoint" isn't a channel. |
| **No KB editor / versioning** | P1 | Runbooks shouldn't require a YAML PR. |
| **No reporting / dashboards** | P1 | Buyers want MTTR trends, deflection rate, agent utilization. |
| **No SOC 2 Type 1** | P0 for enterprise | Procurement gate. Type 2 within 12 months. |
| **No billing** | P0 | Nothing to charge against. |
| **No public website / marketing / sales motion** | P0 | Nobody finds us. |

P0 = without it we have nothing. P1 = without it we look amateur but might
close a friendly pilot.

---

## 5. Phased build plan (the engineering side)

Each phase is structured so it ends with **a thing we can show a buyer.**

### Phase 2 — Security hardening (already scoped)
*Ship: 2–3 weeks. Mostly the existing plan.*
- Clerk auth + RBAC (`viewer / approver / admin`)
- Upstash rate limiting, prompt-injection verifier LLM, real Vercel Sandbox
- Outcome: "the agent layer is production-grade."

### Phase 3 — First real connector + one channel
*Ship: 3–4 weeks. This is the first thing worth demoing.*
- **Connector #1: Okta** (read groups, add to group, send reset, lookup user)
  — Okta because it's the highest leverage IDP for our category.
- **Channel #1: Slack Bolt webhook** with proper signing-secret verification
- Replace the mocked AD users table with Okta as source of truth
- Outcome: **"Watch a real Okta lockout get resolved from a real Slack
  message in under 20 seconds, with full audit."** This is the demo we
  build the website around.

### Phase 4 — Multi-tenant, billing, onboarding
*Ship: 4–6 weeks.*
- Workspace isolation at the DB row level (`workspace_id` everywhere, RLS in
  Postgres for defense-in-depth)
- Stripe billing — per-seat with metered overage on deflected tickets
- Self-serve onboarding: connect Okta in 2 clicks, drop your runbooks
  (paste a Notion link, we ingest), invite teammates
- Outcome: **"Anyone with an Okta admin login and 5 minutes has a working
  IT copilot."** This is the "sign up free" wedge.

### Phase 5 — Connector breadth
*Ship: continuously, one per 2 weeks.*
- Azure AD / Entra ID
- Google Workspace
- Slack DM intake + Teams adapter
- Email intake (forward an alias)
- Intune (MDM) and Jamf (MDM/macOS)
- ServiceNow / Jira / Zendesk **sync** (so we work *with* incumbents, not
  replace immediately — important for enterprise land-and-expand)
- Outcome: each connector is a checkbox on the buyer's RFP and a separate
  press release / launch announcement.

### Phase 6 — ITSM table stakes
*Ship: ongoing throughout phases 3–5.*
- **SLA management:** P1/P2/P3 with response + resolution targets, breach
  notifications, business hours, holidays
- **Routing rules:** by category, by team, by location, round-robin, on-call
- **Ticket conversation:** real Slack/email threading, internal notes,
  customer-visible vs internal status
- **Knowledge base editor:** markdown editor with versioning, suggested
  runbooks auto-generated from resolved tickets (we already do this on the
  backend — just needs UI)
- **Reporting:** MTTR by category, deflection rate by runbook, top
  unresolved patterns, agent productivity, SLA attainment
- Outcome: feature parity check-list against Freshservice / Jira Service Mgmt

### Phase 7 — Compliance & enterprise
*Ship: 6–12 months.*
- SOC 2 Type 1 (3 months), Type 2 (12 months)
- ISO 27001
- HIPAA addendum for healthcare customers
- Data residency (EU, US-East, US-West)
- Customer-managed encryption keys (CMEK) for enterprise tier
- SAML SSO + SCIM provisioning
- Outcome: unblocks deals >$50k ARR

### Phase 8 — Verticals & specialization
*Ship: as evidence justifies.*
- **Healthcare**: HIPAA, Epic/Cerner integration, joint commission
  audit-trail requirements
- **Education**: PowerSchool/Canvas, FERPA, district-IT workflow
- **Fintech**: SOX, change-control workflow integration
- Each vertical doubles the price point with very little code change.

---

## 6. Go-to-market (the sales motion)

Three plays in priority order. Run **Play 1 first** until repeatable, then
layer 2 and 3.

### Play 1 — PLG self-serve to mid-market IT manager
- Public site with a 90-second video showing the Slack-to-resolved demo
- Free tier: 1 connector (Okta), 100 deflected tickets/month, 5 seats
- Paid: $10/employee/mo, unlimited tickets
- Channel: SEO + IT-subreddit/Lobsters/HN posts about specific runbooks
  (e.g. "We auto-resolved 47% of our Okta tickets — here's how")
- Target persona: head of IT at a 100–500 employee SaaS company. Not
  the CIO — the one person who's drowning.

### Play 2 — MSP partnership / white-label
- Partner with 2–3 mid-tier MSPs (50–500 customer firms each)
- Pitch: "Your L1 techs become 3x more productive without you firing
  anyone. Charge your customers the same, keep the margin."
- Pricing: 30% revenue share or flat $5/seat-supported
- This is how we get from 10 customers to 1000 customers in 6 months.

### Play 3 — Outbound to mid-market direct
- Once Play 1 has produced 20–30 unsolicited inbound demos, hire 1 SDR
- Target list: SaaS companies 200–800 employees that don't have a
  dedicated IT team listed on LinkedIn (proxy for "we outsource and
  it's painful")
- Sales motion: 14-day pilot, success criteria written upfront

---

## 7. Differentiation we have to defend

Every existing ITSM player will (and is) bolting AI on. Within 18 months
"AI suggestions" is table stakes. What stays defensible:

1. **Structural safety** — capability-scoped tools, default-deny policy,
   discriminated-union plan schema, DB-enforced audit immutability.
   *Not features competitors will retrofit easily.* It requires re-architecting
   their tool surface from "general LLM with code execution" to "narrow
   typed capabilities" — which most can't do without breaking customers.
2. **Compounding runbook moat** — every resolved ticket is auto-extracted
   into a reinforced runbook. Customer-specific. Switching cost grows over
   time. *Worth modeling: deflection rate should grow 3–5 percentage
   points per month of usage.*
3. **Audit-by-construction** — every tool call, policy decision, approval,
   and state transition lives in an immutable Postgres table. Procurement
   loves this. SOC 2 auditors love it more.
4. **Latency** — 3–15s end-to-end is in a different league from "open a
   chat, type, wait for human." This is invisible to RFPs and visible to
   actual users every day.

---

## 8. What I'd build next, concretely

Assuming the goal is "first paid customer in 6 months," the next-month
work in priority order:

1. **Real Okta connector** (replaces 7 of our 14 mock tools immediately)
2. **Real Slack Bolt intake** (replaces the curl demo, makes the video
   recordable)
3. **Professional UI** (this conversation — separate work)
4. **Stripe billing wired in** (so the moment somebody asks "can I pay"
   we can take their money)
5. **Public site with the 90-second video** (so they find us)
6. **5 design-partner pilot customers, free, with weekly feedback calls**
   (the actual product-market-fit work)

Compliance, enterprise features, more connectors all wait until we have
proof somebody will pay. Don't build to a spec sheet ahead of customers.

---

## 9. The risks worth naming

- **OpenAI/Anthropic build the same thing**: They could ship an "IT agent"
  any day. Counter: we're vertical, we have the safety architecture they'd
  have to retrofit, and we ship customer-specific connectors faster than
  they will. If they ship in 18 months we should have 100+ customers and
  be acquirable.
- **ServiceNow Agentforce or similar releases a credible competitor**:
  Likely within 12–24 months. Counter: we beat them to SMB/mid-market on
  price + UX while they're stuck selling to F500.
- **AI accuracy at the long tail**: our deflection rate guarantee is only
  defensible on tightly-scoped runbook categories (lockouts, password
  resets, SSO, basic device config). We must aggressively narrow scope on
  marketing — "We deflect auth/access/account tickets" is honest. "We
  resolve all IT tickets" is a lie and will burn us.
- **Audit-log immutability is only as strong as the DB role**: We need
  separate `app` and `audit_writer` roles in Phase 4 so a compromised app
  process can write audit but never bypass the trigger via a role swap.
- **Connector breakage**: Okta/Slack APIs change quarterly. Budget 0.5
  engineer permanently on connector maintenance once we have >5.

---

## 10. North-star metric

**Net deflected tickets per dollar charged.** Not MRR, not customer count,
not NPS. If we're deflecting more tickets per dollar charged than
ServiceNow is, we win. If we're not, our wedge is fake and we should know
it fast.

Acceptable v1 target: **$15 of customer charge per deflected ticket** — at
half what they'd pay an MSP for the same outcome, with 3-second latency
instead of 30 minutes. Anything worse than that and the pricing model is
wrong.
