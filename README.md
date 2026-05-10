# AI-Native IT Support — Hackathon MVP

A working prototype of an **AI-native IT copilot** that remembers every ticket, issue, and company-specific runbook so it can resolve full-stack IT problems — network, identity, devices, app crashes, front-desk asks — in seconds, with high security and a human in the loop.

Sponsor stack: **Nia** (headline) · Convex · Vercel · InsForge · Aside · Tensorlake · Hyperspell.

## The problem

Companies still burn enormous time and money on IT tickets that today's AI agents can't solve — because those agents have no persistent context (your runbooks, your users, this user's recent activity) and no real capability (they can read docs but can't actually push an MDM profile, restart an app on a laptop, or unlock an AD account). So the ticket falls back to a human, in person, slow and expensive.

This copilot fixes both halves:

- **Context** — every resolved ticket is auto-extracted into a runbook and re-indexed (Nia). The next identical ticket resolves faster. Per-user signals (recent apps, calendar, device posture) come from Hyperspell. Plans cite the exact runbook + user-context snippets they were grounded in.
- **Capability** — plans execute through capability-scoped backends (InsForge), sandboxed compute (Tensorlake / Vercel Sandbox), the user's own authenticated browser (Aside), or a local agent that runs allowlisted shell commands on the technician's machine. The AI **never holds standing credentials**, and any high-risk step is gated behind an explicit IT-staff approval click.

## The product

**Employees report IT issues in their existing Slack channel.** An IT technician sees a live console with the AI's drafted response + action plan, every step grounded in cited runbooks (Nia). One click approves; actions execute via capability-scoped backends (InsForge), the user's own authenticated browser (Aside), sandboxed compute (Tensorlake), or a **local sandbox agent** that runs allowlisted macOS commands (restart app, clear cache, toggle Wi-Fi) on the technician's machine. After execution, the bot asks the reporter in-thread "is this resolved?" and only marks the ticket resolved on a *yes*; a *no* escalates to a human. Resolved tickets auto-extract back into runbooks (re-indexed in Nia), so identical tickets resolve faster the second time. That's the compounding moat.

## What's in here

```text
src/
├── app/
│   ├── page.tsx                  Boots StateProvider + AppShell
│   ├── layout.tsx                Root layout, dark theme
│   ├── globals.css               Tailwind v4
│   ├── actions/tickets.ts        Server Actions: createTicket, draftPlan,
│   │                             approveAndExecute, confirmTicketResolved,
│   │                             escalateAfterUserDenied, extractRunbook
│   ├── api/state/route.ts        Polling endpoint for live UI
│   ├── api/demo/ticket/route.ts  Drive a ticket via curl (for scripted demos)
│   ├── api/slack/events/route.ts Real Slack Events webhook — accepts new
│   │                             tickets and yes/no replies in-thread
│   ├── api/agent/heartbeat/...   Local sandbox agent claim+report endpoints
│   └── components/               Console UI: queue, active ticket, sidebar,
│                                 dashboard, Slack mock, runbooks tab
├── lib/
│   ├── types.ts                  Ticket / Runbook / PlanStep / Citation
│   ├── db.ts                     In-memory store (matches Convex schema 1:1)
│   ├── data.ts                   InsForge-backed data layer with in-memory
│   │                             fallback when InsForge is unreachable
│   ├── policy.ts                 Risk classifier (allowlist + LLM judge)
│   ├── agent-jobs.ts             Queue work for the local sandbox agent
│   ├── auth.ts                   HMAC session cookies, IT-staff gating
│   ├── seed.ts                   Seeded AD users + runbooks
│   └── integrations/             Adapter per sponsor — mock + real, swap by env
│       ├── nia.ts                Search runbooks + ingest resolutions
│       ├── ai-gateway.ts         LLM draft via Vercel AI Gateway
│       ├── insforge.ts           Capability-scoped edge functions w/ policy gate
│       ├── aside.ts              Browser-as-execution in user's session
│       ├── tensorlake.ts         Sandboxed diagnostic compute
│       └── hyperspell.ts         User context (recent apps, calendar)
scripts/
└── local-agent.mjs               Long-poll worker that runs allowlisted macOS
                                  commands on the technician's machine
convex/
├── schema.ts                     Production-path Convex schema (matches db.ts)
└── README.md                     How to swap from demo mode to real Convex
```

## Run it

```bash
pnpm install
pnpm dev
# open http://localhost:3000
```

No keys required — every integration runs in mock mode by default. The demo is fully end-to-end without external services.

To go live, drop any of these into `.env.local`; each adapter auto-detects and switches to the real implementation.

| Variable | Purpose |
| --- | --- |
| `AI_GATEWAY_API_KEY` | Real LLM planning + risk classification via Vercel AI Gateway |
| `NEXT_PUBLIC_INSFORGE_URL` + `NEXT_PUBLIC_INSFORGE_ANON_KEY` + `INSFORGE_API_KEY` | Persist tickets / runbooks / AD users in InsForge |
| `SLACK_CLIENT_ID` + `SLACK_CLIENT_SECRET` + `SLACK_SIGNING_SECRET` | Real Slack ingest via `/api/slack/events` |
| `NIA_API_KEY`, `HYPERSPELL_API_KEY` | Real Nia retrieval and Hyperspell user context |

### Run the local sandbox agent (optional)

To execute real fix actions on a macOS machine (restart Excel, clear an app cache, cycle Wi-Fi), start the worker in a second terminal:

```bash
node scripts/local-agent.mjs
```

It long-polls `/api/agent/heartbeat`, claims jobs the AI plan enqueues, and runs only the allowlisted commands. Diagnostic capabilities (`diag.network_probe`, `sandbox.read_*`) stream redacted findings back; fix capabilities (`fix.restart_app`, `fix.clear_app_cache`, `fix.toggle_wifi`) actually run on the local machine.

## How a user works the demo (visual walkthrough)

The demo has **two personas**, with two distinct surfaces:

1. **End user** (Alice, Bob, Eve, …) — files tickets via the in-app Slack mock.
2. **IT staff** (Morgan, Sam) — approves agent plans in the Console.

```text
END-USER VIEW                       IT-STAFF VIEW
─────────────                       ─────────────
1. /  (no cookie)                   
       │                            
       ▼                            
   /login   ── one-click as alice ──►
   (sees AD user list with status   
    badges: active / locked /       
    pwd_expired / stale_kerberos)   

2. Slack tab opens by default       (when morgan logs in,
   "Posting as Alice Nguyen"         Console opens by default)
                                    
3. Click a quick prompt        ───► Console: T-XXXX appears
   OR type a message                status: drafting
                                    │
                                    ▼ Hyperspell + Nia draft
                                    status: awaiting_approval
                                    
4. (Alice sees banner)              Plan + citations rendered
   "Awaiting IT staff approval"     [Approve & Execute] button
                                    │
                                    ▼ Morgan clicks
5.                                  Plan executes serially
                                    each step shows live logs:
                                    ✓ insforge / ad.lookup_user
                                    ✓ tensorlake / sandbox.read_*
                                    ✓ insforge / ad.unlock_account
                                    ✓ slack_reply
                                    status: awaiting_confirmation

6. Slack thread:                    (Morgan watches in console)
   "Is the issue resolved?
    Reply yes or no."
   ── Alice replies "yes" ────────► status: resolved
                                    runbook successCount +1
                                    — the moat in motion.
   ── Alice replies "no"  ────────► status: escalated
                                    technician picks it up.
```

### Detailed 90-second demo script

1. **Open `/`** → redirects to `/login`. Right panel shows 9 seeded AD users with status badges (active, locked, password_expired, stale_kerberos).
2. **One-click sign-in as `alice@acme.test`** (active). Default tab is `Slack (demo)` since Alice isn't IT staff.
3. **Click any quick prompt** in the Slack tab — e.g. "AD account locked" or "Mapped drives keep prompting password." A ticket flows into the Console.
4. **Switch to Console.** Status: `new → drafting → awaiting_approval`. Right sidebar fills with **Nia** runbook citations (e.g. `rb-ad-account-locked`) + **Hyperspell** user context. Alice sees the plan but no Approve button — only IT staff can approve.
5. **Sign out → sign in as `morgan@acme.test`** (IT staff). Console opens by default; the pending ticket is selected.
6. **Click "Approve & Execute".** IT-staff approval grants permission for the **entire plan**, including any step the policy classifier flagged high-risk (the risk badge stays visible so you see what you're approving). Plan runs serially with live logs:
   - **InsForge** `ad.lookup_user` / `ad.unlock_account` / `mdm.push_vpn_config` — policy-gated edge functions
   - **Tensorlake → Vercel Sandbox** `sandbox.read_auth_logs` / `sandbox.read_kerberos_logs` — Firecracker microVM, **read-only mounts**, secret redaction, no network egress to corp prod
   - **Local sandbox agent** `fix.restart_app` / `fix.clear_app_cache` / `fix.toggle_wifi` — runs allowlisted shell commands on the technician's machine via `scripts/local-agent.mjs`
   - **Aside** — browser action in the user's own authenticated session (agent never holds creds)
   - **Slack reply** — auto-posts back to the reporter
7. **Status flips to `awaiting_confirmation`.** The bot asks the reporter "is this resolved?" in the Slack thread. A *yes* marks `resolved`, runs `extractRunbook`, and bumps the matching runbook's `successCount`. A *no* escalates.
8. **Open `Runbooks` tab.** The matching runbook's `successCount` just incremented.
9. **Try to log in as `bob@acme.test`** (status: locked) → red banner blocks login until an IT ticket unlocks the account. Send a novel ticket ("monitor flickers") to see a new runbook synthesized + auto-indexed in Nia.

The dashboard shows deflection rate, AI-resolved count, escalations, and avg resolution time — live.

## Drive the demo via curl

```bash
# Auto-resolve a Figma SSO ticket
curl -X POST -H "Content-Type: application/json" \
  -d '{"autoApprove":true}' \
  http://localhost:3000/api/demo/ticket

# Custom ticket
curl -X POST -H "Content-Type: application/json" \
  -d '{
    "reporter":"Priya Shah",
    "reporterEmail":"priya@acme.test",
    "subject":"VPN super slow today",
    "body":"VPN dropping every few minutes",
    "autoApprove":true
  }' \
  http://localhost:3000/api/demo/ticket

# Inspect state
curl -s http://localhost:3000/api/state | jq '.stats'
```

## Sponsor mapping (load-bearing roles)

| Sponsor | Where it lives | What it does |
| --- | --- | --- |
| **Nia** | `lib/integrations/nia.ts` | Indexes runbooks; retrieves + drafts response + action plan in one advisor call; ingests resolved tickets |
| **Convex** | `convex/schema.ts` + `lib/db.ts` mirror | Real-time data layer for tickets, runbooks, plan steps |
| **Vercel** | Next.js 16 host | Production deploy target |
| **InsForge** | `lib/integrations/insforge.ts` | Capability-scoped edge functions, policy-gated actions |
| **Aside** | `lib/integrations/aside.ts` | Browser execution in user's authenticated session — zero standing creds |
| **Tensorlake** | `lib/integrations/tensorlake.ts` | Sandboxed compute for AI-generated diagnostics |
| **Hyperspell** | `lib/integrations/hyperspell.ts` | User-side context (apps, calendar) to inform plans |
| **Devin / Codex** | (build-time) | Parallel agents to scaffold/iterate during the hackathon |

## The economic thesis (what the demo proves)

The cost isn't the technician's hourly rate — it's the unresolved ticket. Every IT issue today's AI agents can't solve falls back to a human walking to a desk, screen-sharing, or rebuilding a laptop. That's where the time and money go.

- **Average L1 ticket today:** ~20–40 min of human-attended work (triage + remote session + follow-up)
- **With this copilot:** the deflectable ticket takes ~15s end-to-end (drafted, approved, executed, confirmed by the user in Slack), and the *non*-deflectable ticket arrives at the technician with a full evidence pack already attached — so even escalations are faster
- **Memory effect:** every resolved ticket becomes a runbook, so the second occurrence of any issue is cheaper than the first. The deflection-rate curve bends up over time
- **For a 200-seat company:** if 60% of weekly tickets get deflected, that's roughly one full-time technician's worth of capacity recovered without hiring

The deflection-rate counter on the dashboard is the founder pitch number.

## Switching from demo to production

The in-memory `db.ts` is shaped to match `convex/schema.ts` exactly. Migration is mechanical:

```bash
npx convex dev   # log in, link a deployment
```

Then replace reads/writes in `actions/tickets.ts` with `mutation`/`query` calls against the Convex client. See `convex/README.md`.

## Ticket lifecycle

```text
new → drafting → awaiting_approval → executing → awaiting_confirmation → resolved
                                                       │
                                                       ├── user replies "no"  → escalated
                                                       └── any step fails     → escalated
```

`awaiting_confirmation` is the closed-loop checkpoint: the AI doesn't claim the ticket is fixed — the user does. Slack thread replies are classified by [src/app/api/slack/events/route.ts](src/app/api/slack/events/route.ts) and routed to `confirmTicketResolved` or `escalateAfterUserDenied`.

## What's *not* in this MVP

- Multi-tenant isolation — workspaces are per-signup, but real customers would each get their own Tensorlake sandboxes, Nia indexes, and audit logs.
- Compliance certifications — SOC2 / HIPAA paperwork is non-negotiable for real customers but doesn't ship in 48 hours.
- Production Convex — schema is ready; the live data layer is currently InsForge with in-memory fallback.
- Cross-platform local agent — `scripts/local-agent.mjs` is macOS-only today (uses `osascript`, `networksetup`).

## License

MIT
