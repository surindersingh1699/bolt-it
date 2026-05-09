# spec.md — AI-Native IT Support Agent

## Problem
SMBs and 50–500-seat startups need IT support but face a bad-vs-bad choice:
- **Offshore MSP** — cheap (~$15–25/hr), but timezone gap, language friction, no context retention.
- **Onshore MSP** (Electric, ntiva, etc.) — quality, but expensive ($80–100/seat/mo) because labor-bound.

Existing players are pre-LLM cost structures with AI grafted on. They can't price-compete with offshore without cannibalizing their own labor margins.

## User (one)
**US-based L1 IT technician** working a console that lets one human supervise 3–4 customer L1 ticket streams concurrently. The technician approves and intervenes; the agent does the search, drafting, and execution.

(Secondary user: the *end-user* at the customer org reports the issue in Slack and gets a resolution. They don't see the console.)

## Core flow (the happy path)
1. End-user posts an IT issue in their company's `#it-support` Slack channel.
2. Ticket appears live in the technician console.
3. Agent retrieves matching runbooks from **Nia** (citations shown).
4. Agent drafts a response + capability-scoped action plan.
5. Technician one-clicks **Approve & Execute**.
6. Plan executes:
   - **InsForge** edge function (policy-gated backend action)
   - **Aside** browser action (in user's authenticated session — agent never holds creds)
   - **Tensorlake** sandbox (for AI-generated diagnostic scripts)
   - **Slack reply** (auto-posts back to user)
7. Resolution auto-extracts to a runbook entry. Re-indexed in Nia.
8. The next identical ticket resolves faster + with higher confidence.

## The wow moment
The same ticket type fires a second time and resolves visibly faster + with a higher confidence score, because the prior resolution is now indexed. **The compounding moat is on screen.**

## Success criteria (M1 — the demo)
- All three quick-prompt tickets (Figma SSO / VPN / password) resolve end-to-end via mocks in <5s each.
- A novel ticket (no runbook match) synthesizes a *new* runbook and grows the library.
- Real Nia advisor returns a correct match for at least one demo prompt with confidence ≥ 0.8.
- Deflection-rate counter on dashboard reaches 100% across the demo set.
- Zero TypeScript errors. Demo runnable with `pnpm dev` + zero env vars.

## Non-goals (explicit)
- Real Slack OAuth — using in-app mock chat as the surface.
- Multi-tenant isolation — single-tenant for hackathon.
- Compliance certs (SOC2, HIPAA) — non-negotiable for real customers, not in scope.
- Billing, customer onboarding flow, admin UI.
- Real Convex deployment — schema is reference-only; in-memory mirror runs the demo.
- Production-grade error handling — happy path only.
- Mobile, tablet, accessibility audits.
- Multi-language support.

## What "done" looks like at each milestone
M1 (current): Demo-able end-to-end pipeline with mocks + real Nia.
M2: AI Gateway wired so the LLM actually drafts plans (not hardcoded mock).
M3: Live deploy on Vercel with a customer-visible URL.
M4: First real customer pilot — replace the in-app Slack mock with a Slack Bolt webhook for one design partner.
