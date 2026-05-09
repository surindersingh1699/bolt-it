# PROJECT_STATE.md

> Source of truth for current milestone, what's done, and what's next. Update on every milestone change.

## Current milestone
**M1 — End-to-end happy path with mock pipeline + real Nia retrieval.**

## Done criteria for M1
- [x] Slack mock chat → ticket → live console queue
- [x] AI drafts plan with citations (mock + real Nia)
- [x] Technician approval gate enforced
- [x] Plan execution wired through 4 capability kinds (insforge, aside, tensorlake, slack_reply)
- [x] Resolution auto-extracts to runbook (existing match) or synthesizes new runbook (low confidence)
- [x] Deflection dashboard updates live
- [x] Real Nia advisor returns correct match for the Figma demo prompt with confidence ≥ 0.8
- [x] `pnpm exec tsc --noEmit` clean
- [x] Demo runnable with zero env vars (mocks-only mode works)

**Status: M1 complete as of 2026-05-09.**

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
- **AI Gateway key** not provided — LLM draft is currently a hardcoded mock that pattern-matches on keywords. The plan structure is realistic but the *intelligence* is fake. Blocks M2.
- **Hyperspell key** not provided — user-context citations come from a 3-user mock dictionary.
- **Convex deployment** not linked — schema exists but we're using the in-memory mirror.
- **No real customer Slack workspace** — the in-app mock is the only intake surface.

## Next 3 tasks (proposed for M2 — NOT YET APPROVED)
1. **Visualize the moat.** Surface "avg resolve time per runbook" + "5 tickets resolved by this runbook" on each runbook card. The moat claim is currently invisible unless you compare two runs by stopwatch.
2. **One-click demo arc.** Add a "Run demo sequence" button that fires Figma → VPN → Salesforce → novel ticket in sequence with paced delays. Judge sees the entire 60-second story without clicking around.
3. **Real AI Gateway draft.** Replace the keyword-mock LLM call with a real `ai-gateway.vercel.sh` call. Falls back to mock on missing key or failure. Makes the plan generation actually intelligent.

Each task ships in <90 minutes. Each has a fallback. Each adds visible demo value. **None of these start until you approve the milestone.**

## Risks
- Real Nia advisor adds ~10s latency per ticket draft. Push past the 60s demo budget if we fire 3 tickets serially with real Nia. Mitigation: keep first ticket on real Nia; force the rest to mock for demo speed.
- LLM via AI Gateway adds another ~3–5s. Total budget tight. Mitigation: kick off Nia retrieval + LLM draft in parallel.
- Free Nia tier exhausts faster than expected during dev iteration. Mitigation: re-set `NIA_API_KEY=` empty when iterating UI.

## Last 3 changes (most recent first)
- 2026-05-09 — **Removed AI Gateway adapter; Nia advisor now drafts response + action plan in one call.** Sponsor count 8→7. Verified 100% deflection across 3 demo tickets with real Nia (avg ~16s per ticket end-to-end). Demo helper now polls for `awaiting_approval` before auto-approving.
- 2026-05-09 — Real Nia `/v2/advisor` integration with codebase-as-runbooks payload + graceful mock fallback.
- 2026-05-09 — Initial scaffold: Next.js 16 + Convex schema + in-memory mirror + sponsor adapters + Console/Slack/Runbooks UI + ticket lifecycle Server Actions.
