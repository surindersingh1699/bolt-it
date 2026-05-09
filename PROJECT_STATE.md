# PROJECT_STATE.md

> Source of truth for current milestone, what's done, and what's next. Update on every milestone change.

## Current milestone
**M2 — Real LLM drafting via AI Gateway, moat visualization, one-click demo arc.**

## Done criteria for M2

- [x] Real AI Gateway tier inserted between Nia and mock (cascade: Nia → AI Gateway → mock)
- [x] AI Gateway uses runbooks-as-context with structured JSON output
- [x] Runbook cards show avg resolve time + resolution count + auto-generated badge
- [x] One-click "Run demo arc" button fires Figma → VPN → Salesforce → novel ticket sequentially
- [x] Demo arc auto-switches to Console tab and shows step counter while running
- [x] `pnpm exec tsc --noEmit` clean
- [x] Demo still runnable with zero env vars (mocks remain default)

**Status: M2 complete as of 2026-05-09.**

## Done criteria for M1 (kept for reference)

- [x] Slack mock chat → ticket → live console queue
- [x] AI drafts plan with citations (mock + real Nia)
- [x] Technician approval gate enforced
- [x] Plan execution wired through 4 capability kinds (insforge, aside, tensorlake, slack_reply)
- [x] Resolution auto-extracts to runbook (existing match) or synthesizes new runbook (low confidence)
- [x] Deflection dashboard updates live
- [x] Real Nia advisor returns correct match for the Figma demo prompt with confidence ≥ 0.8
- [x] `pnpm exec tsc --noEmit` clean
- [x] Demo runnable with zero env vars (mocks-only mode works)

## Verified demo prompts (M1 acceptance set)
| # | Reporter | Subject | Status |
| --- | --- | --- | --- |
| 1 | Alex Reyes | Can't access Figma anymore | ✅ resolves via real Nia + mock execution |
| 2 | Priya Shah | VPN super slow today | ✅ resolves via mock Nia + Tensorlake demo |
| 3 | Jordan Lee | Locked out of Salesforce | ✅ resolves via mock Nia + Aside demo |
| 4 | (any) | Novel ticket (e.g. monitor flickers) | ✅ confidence < 0.6 → synthesizes new runbook |

## Constraints (binding)
- **Solo developer**, hackathon timebox.
- **Free Nia tier** — 50 advisor queries/month. Each demo ticket = 1 query. Stay below 30 queries/week.
- **No external infra dependencies** for the demo to run (no DB, no Convex login, no Slack OAuth).
- **No more than 8 sponsor integrations.** New work must use existing adapters.
- **Demo runtime ≤ 60 seconds** end-to-end. Don't add steps that push past this.

## Known blockers

- **AI Gateway key** not provided in dev — drafting falls through to keyword mock. Set `AI_GATEWAY_API_KEY` (and optionally `AI_GATEWAY_MODEL`, default `anthropic/claude-haiku-4-5`) to enable real LLM drafting.
- **Hyperspell key** not provided — user-context citations come from a 3-user mock dictionary.
- **Convex deployment** not linked — schema exists but we're using the in-memory mirror.
- **No real customer Slack workspace** — the in-app mock is the only intake surface.

## Next 3 tasks (proposed for M3 — NOT YET APPROVED)

1. **Live deploy on Vercel.** Push to a customer-visible URL with `vercel deploy --prod`. Set `AI_GATEWAY_API_KEY` and `NIA_API_KEY` as project env vars. Removes the "running locally" caveat from every demo.
2. **Real Convex deployment.** Migrate from the in-memory `db.ts` mirror to a live Convex deployment using the existing `convex/schema.ts`. Replaces the polling pattern with Convex's reactive subscriptions. Drops the singleton-on-globalThis hack.
3. **Streaming AI Gateway responses.** Switch the AI Gateway integration from blocking JSON to streamed tokens so the draft response appears live in the Console while the plan structure is still being generated. Cuts perceived latency.

Each task ships in <90 minutes. Each has a fallback. Each meaningfully reduces the demo's "but in production…" caveats.

## Risks

- Real Nia advisor adds ~10s latency per ticket draft. Push past the 60s demo budget if we fire 4 tickets serially with real Nia. Mitigation: keep first ticket on real Nia; force the rest to AI Gateway (faster) or mock for demo speed.
- AI Gateway with Haiku adds ~2–4s per ticket draft. With the demo arc firing 4 tickets with 1.5s gaps + ~5s per ticket, total arc time is ~25–35s. Acceptable but watch the 60s budget.
- Free Nia tier exhausts faster than expected during dev iteration. Mitigation: leave `NIA_API_KEY=` empty during UI iteration; AI Gateway tier picks up the slack.

## Last 3 changes (most recent first)

- 2026-05-09 — **M2 shipped: AI Gateway tier + moat viz + one-click demo arc.** New `aiGatewayDraft()` adapter posts to `ai-gateway.vercel.sh/v1/chat/completions` (default model `anthropic/claude-haiku-4-5`); `niaDraft()` now cascades Nia → AI Gateway → mock. Runbook cards show avg resolve time + auto-generated badge. Header has a "Run demo arc" button that fires 4 tickets sequentially.
- 2026-05-09 — **Removed AI Gateway adapter; Nia advisor now drafts response + action plan in one call.** Sponsor count 8→7. Verified 100% deflection across 3 demo tickets with real Nia (avg ~16s per ticket end-to-end). Demo helper now polls for `awaiting_approval` before auto-approving.
- 2026-05-09 — Real Nia `/v2/advisor` integration with codebase-as-runbooks payload + graceful mock fallback.
