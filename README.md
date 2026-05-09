# AI-Native IT Support — Hackathon MVP

A working prototype of an **AI-native managed IT support service**. Built around the wedge: *match offshore cost, beat onshore quality, with zero-standing-access security architecture.*

Sponsor stack: **Nia** (headline) · Convex · Vercel · InsForge · Aside · Tensorlake · Hyperspell.

## The product

**Customers report IT issues in their existing Slack channel.** A US-based technician sees a live console with the AI's drafted response + action plan, every step grounded in cited runbooks (Nia). One click approves; actions execute via capability-scoped backends (InsForge), the user's own authenticated browser (Aside), or sandboxed compute (Tensorlake) — the agent **never holds standing credentials**. Resolved tickets auto-extract back into runbooks (re-indexed in Nia), so identical tickets resolve faster the second time. That's the compounding moat.

## What's in here

```text
src/
├── app/
│   ├── page.tsx                  Boots StateProvider + AppShell
│   ├── layout.tsx                Root layout, dark theme
│   ├── globals.css               Tailwind v4
│   ├── actions/tickets.ts        Server Actions: createTicket, draftPlan,
│   │                             approveAndExecute, extractRunbook, escalate
│   ├── api/state/route.ts        Polling endpoint for live UI
│   ├── api/demo/ticket/route.ts  Drive a ticket via curl (for scripted demos)
│   └── components/               Console UI: queue, active ticket, sidebar,
│                                 dashboard, Slack mock, runbooks tab
├── lib/
│   ├── types.ts                  Ticket / Runbook / PlanStep / Citation
│   ├── db.ts                     In-memory store (matches Convex schema 1:1)
│   ├── seed.ts                   4 seeded runbooks
│   └── integrations/             Adapter per sponsor — mock + real, swap by env
│       ├── nia.ts                Search runbooks + ingest resolutions
│       ├── ai-gateway.ts         LLM draft (mock returns realistic plans)
│       ├── insforge.ts           Capability-scoped edge functions w/ policy gate
│       ├── aside.ts              Browser-as-execution in user's session
│       ├── tensorlake.ts         Sandboxed diagnostic compute
│       └── hyperspell.ts         User context (recent apps, calendar)
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

To go live: set `NIA_API_KEY` (and optionally `HYPERSPELL_API_KEY`) in `.env.local`. Each adapter auto-detects and switches to the real implementation.

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
                                    status: resolved (≈14s)

6.                                  Runbooks tab: matched runbook's
                                    successCount +1 — the moat in motion.
```

### Detailed 90-second demo script

1. **Open `/`** → redirects to `/login`. Right panel shows 9 seeded AD users with status badges (active, locked, password_expired, stale_kerberos).
2. **One-click sign-in as `alice@acme.test`** (active). Default tab is `Slack (demo)` since Alice isn't IT staff.
3. **Click any quick prompt** in the Slack tab — e.g. "AD account locked" or "Mapped drives keep prompting password." A ticket flows into the Console.
4. **Switch to Console.** Status: `new → drafting → awaiting_approval`. Right sidebar fills with **Nia** runbook citations (e.g. `rb-ad-account-locked`) + **Hyperspell** user context. Alice sees the plan but no Approve button — only IT staff can approve.
5. **Sign out → sign in as `morgan@acme.test`** (IT staff). Console opens by default; the pending ticket is selected.
6. **Click "Approve & Execute".** Plan runs serially with live logs:
   - **InsForge** `ad.lookup_user` / `ad.unlock_account` / `ad.refresh_kerberos` — policy-gated AD edge functions
   - **Tensorlake → Vercel Sandbox** `sandbox.read_auth_logs` / `sandbox.read_kerberos_logs` — Firecracker microVM, **read-only mounts**, secret redaction, no network egress to corp prod
   - **Aside** — browser action in the user's own authenticated session (agent never holds creds)
   - **Slack reply** — auto-posts back to the reporter
7. **Open `Runbooks` tab.** The matching runbook's `successCount` just incremented.
8. **Try to log in as `bob@acme.test`** (status: locked) → red banner blocks login until an IT ticket unlocks the account. Send a novel ticket ("monitor flickers") to see a new runbook synthesized + auto-indexed in Nia.

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

- **Offshore tech blended:** ~$15–25/hr, 1 tech ≈ 1 customer L1 stream
- **AI-native US tech:** ~$40–60/hr, 1 tech + this console ≈ 3–4 customer L1 streams
- **Effective per-customer labor cost:** ~$2–3K/mo (matches offshore) **with** US fluency, timezone, retained context
- **Charge:** $5–7K/mo for a 50-seat startup → 50%+ gross margin headroom

The deflection-rate counter on the dashboard is the founder pitch number.

## Switching from demo to production

The in-memory `db.ts` is shaped to match `convex/schema.ts` exactly. Migration is mechanical:

```bash
npx convex dev   # log in, link a deployment
```

Then replace reads/writes in `actions/tickets.ts` with `mutation`/`query` calls against the Convex client. See `convex/README.md`.

## What's *not* in this MVP

- Multi-tenant isolation — single-tenant for demo. Real customers each get their own Tensorlake sandboxes, Nia indexes, and audit logs.
- Real Slack integration — uses an in-app mock. Swap with a Slack Bolt webhook to `POST /api/demo/ticket`.
- Compliance certifications — SOC2 / HIPAA paperwork is non-negotiable for real customers but doesn't ship in 48 hours.
- Production Convex — schema is ready; the dev server doesn't yet require login.

## License

MIT
