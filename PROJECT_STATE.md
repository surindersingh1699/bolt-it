# PROJECT_STATE.md

> Source of truth for current milestone, what's done, and what's next. Update on every milestone change.

## Active queue (M5–M8 — "make every adapter real")

User directive 2026-05-09: stop tolerating mock-only branches; opt-in real path everywhere a real impl is reachable. Each item below is a self-contained milestone with its own done criteria and fallback. M4 (real Hyperspell memory queries) remains in progress in parallel.

### M5 — Real Slack outbound replies (`chat.postMessage`)

Replace the canned `[Slack] Posting reply…` log lines for `slack_reply` plan steps with a real call to `https://slack.com/api/chat.postMessage` using the workspace's stored bot token. Mock fallback retained whenever the token is missing or starts with `xoxb-mock-`.

Done criteria:

- [ ] `postSlackMessage(token, channel, text)` helper in [src/lib/slack.ts](src/lib/slack.ts) using `fetch`, no new deps
- [ ] `executePlan` in [src/app/actions/tickets.ts](src/app/actions/tickets.ts) loads `workspace.slackAccessToken`, posts when real, falls back to mock log when absent/mock
- [ ] Channel resolved from `params.channel` if present, else default `#it-support`
- [ ] Posts in-thread when `params.thread_ts` present (future-friendly, not required for current plan steps)
- [ ] `pnpm exec tsc --noEmit` clean
- [ ] Mock branch preserved (rule 1)

### M6 — Real identity verification via Hyperspell

Replace the 400ms-sleep-and-return-ok stub in [src/lib/integrations/insforge.ts:36-41](src/lib/integrations/insforge.ts) with a real `queryMemories(query, userEmail)` call. Pass when ≥1 hit ≥0.3 score; otherwise return `ok: false` so the plan halts and escalates.

Done criteria:
- [ ] `identity.verify` calls `queryMemories("recent login activity", userEmail)`
- [ ] Threshold: ≥1 hit with score ≥0.3 → verified; else → `ok: false` and escalation
- [ ] Logs include the matched memory titles for auditability
- [ ] When `HYPERSPELL_API_KEY` unset, falls back to current always-ok mock (rule 9)
- [ ] `pnpm exec tsc --noEmit` clean

### M7 — Vercel Sandbox real branch (BLOCKED — needs dep approval)

Implement the empty `realVercelSandboxRead` body in [src/lib/integrations/sandbox.ts:49-59](src/lib/integrations/sandbox.ts). Requires adding `@vercel/sandbox` (per CLAUDE.md rule 8 — not installed without explicit user OK) and a `VERCEL_SANDBOX_TOKEN` to test against.

Done criteria:
- [ ] **Blocked:** confirm `@vercel/sandbox` dep is acceptable
- [ ] Spin up Firecracker microVM, mount target paths read-only, grep for user identifier
- [ ] Pass redacted matches back through existing `SandboxLogReadResult` shape
- [ ] Falls back to mock log corpus when token missing
- [ ] Verified end-to-end against a `bob@acme.test` lockout ticket

### M8 — `.env.local.example` documenting every key

Single canonical file listing every env var the app honors, with one-line comments on what unlocks when set. Reduces "how do I make X real" to a copy-paste exercise.

Done criteria:
- [ ] All keys present: `HYPERSPELL_API_KEY`, `HYPERSPELL_DEMO_USER_ID`, `USE_NIA`, `NIA_API_KEY`, `NIA_API_URL`, `AI_GATEWAY_API_KEY`, `AI_GATEWAY_MODEL`, `AI_GATEWAY_URL`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `VERCEL_SANDBOX_TOKEN`, `NEXT_PUBLIC_INSFORGE_URL`, `NEXT_PUBLIC_INSFORGE_ANON_KEY`, `INSFORGE_SERVICE_ROLE_KEY`
- [ ] Each key has a one-line comment naming the adapter it enables
- [ ] File is `.env.local.example` (not `.env.local`) so it's safe to commit; ensure `.gitignore` keeps `.env.local` out

---

## Current milestone
**M4 — Real Hyperspell memory queries + seeded demo context.**

### M4 scope

Replace the 3-user mock dictionary in [src/lib/integrations/hyperspell.ts](src/lib/integrations/hyperspell.ts) with a real Hyperspell memory query that augments the LLM draft with semantically relevant context (Slack threads, calendar invites, prior tickets) for the reporter. New users start empty; demo mode uses a single shared Hyperspell account pre-seeded with synthetic IT context. Per-user onboarding (Slack/Gmail OAuth via Hyperspell's integration flow) is **explicitly deferred** to a post-hackathon milestone.

## Done criteria for M4

- [ ] `HYPERSPELL_API_TOKEN` env wiring + bearer auth against `https://api.hyperspell.com`
- [ ] New `queryMemories(ticketText, reporterEmail)` function returning ranked memory snippets
- [ ] `draftPlan` Server Action passes memory snippets as additional context to Nia / AI Gateway
- [ ] Demo seeding script (`scripts/seed-hyperspell.ts` or similar) populates demo account via `add-a-memory` with synthetic context for Alex / Priya / Jordan / Bob
- [ ] `?demo=1` toggle (or env-gated demo mode) routes Hyperspell calls to the seeded demo account
- [ ] Mock fallback preserved: when `HYPERSPELL_API_TOKEN` absent, falls back to current 3-user dictionary
- [ ] `pnpm exec tsc --noEmit` clean
- [ ] One demo prompt verifies real Hyperspell memory snippets visibly improve the draft (confidence or citation quality)

### Deferred (post-hackathon)

Per-user data source onboarding: settings page, Hyperspell integration OAuth flow, connection management UI, real Slack workspace. Out of M4 scope.

## Done criteria for M3 (kept for reference)

### M3 pivot rationale (2026-05-09, mid-session)

Started M3 as a Convex migration; tickets + runbooks were ported and verified working against `moonlit-dachshund-294.convex.cloud`. Mid-flight, decided to add an Active Directory user feature (`ADUser`/`ADGroup`/`ADAccount`) for the auth side of the demo. InsForge's strength is Postgres + auth + edge functions in one package, which is a better fit for the user/login surface than Convex's reactive document store. To avoid running two backends, moved everything to InsForge — Convex code stays in the repo (gated off via env) so we can roll back if needed.

## Done criteria for M3

- [x] `@insforge/sdk` installed and `src/lib/insforge-client.ts` instantiated from `NEXT_PUBLIC_INSFORGE_*` env vars
- [x] InsForge Postgres schema for `tickets`, `runbooks`, `ad_users`, `ad_groups`, `ad_accounts` (applied via `insforge db query`)
- [x] `src/lib/data.ts` repointed: InsForge primary, in-memory fallback (Convex branch retired; `isConvexEnabled()` returns false)
- [x] AD users seed + reads via InsForge — `/api/state` no longer 500s
- [x] Demo Figma prompt resolves end-to-end against InsForge (T-8158 → resolved, conf 0.95, 4 steps, rb-figma-sso success_count 4→5)
- [x] `pnpm exec tsc --noEmit` clean
- [x] Demo still runs with zero env vars (no `NEXT_PUBLIC_INSFORGE_URL` → falls back to in-memory)
- [x] HMAC-signed cookie auth ([src/lib/auth.ts](src/lib/auth.ts)) + login page at [/login](src/app/login/page.tsx); `/` redirects unauthenticated users
- [x] AD seed includes 9 users (2 IT staff: morgan@, sam@) + 11 groups + account states (active, locked, password_expired, stale_kerberos)
- [x] IT-staff approval gate: `approveAndExecute` checks `isITStaff` server-side; demo route uses `demoApproveAndExecute` to bypass for the public demo URL
- [x] InsForge AD capabilities ([src/lib/integrations/insforge.ts](src/lib/integrations/insforge.ts)): `ad.lookup_user`, `ad.unlock_account`, `ad.reset_password`, `ad.refresh_kerberos`
- [x] Vercel Sandbox read-only log inspection ([src/lib/integrations/sandbox.ts](src/lib/integrations/sandbox.ts)) wired through Tensorlake (`sandbox.read_auth_logs`, `sandbox.read_kerberos_logs`); secret redaction; mock-first with `VERCEL_SANDBOX_TOKEN` opt-in for real microVMs
- [x] Two new runbooks (`rb-ad-account-locked`, `rb-stale-kerberos`) — real Nia matches both at ≥0.9 confidence
- [x] End-to-end smoke: account-locked ticket as bob@acme.test → real Nia draft (conf 0.95) → IT approval → 4-step plan executes → resolved in 13.8s (in-memory fallback path, T-7823)

**Status: M3 complete as of 2026-05-09.**

## Done criteria for M2 (kept for reference)

- [x] Real AI Gateway tier inserted between Nia and mock (cascade: Nia → AI Gateway → mock)
- [x] AI Gateway uses runbooks-as-context with structured JSON output
- [x] Runbook cards show avg resolve time + resolution count + auto-generated badge
- [x] One-click "Run demo arc" button fires Figma → VPN → Salesforce → novel ticket sequentially
- [x] Demo arc auto-switches to Console tab and shows step counter while running
- [x] `pnpm exec tsc --noEmit` clean
- [x] Demo still runnable with zero env vars (mocks remain default)

**Status: M2 complete as of 2026-05-09. M3 in progress.**

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

- 2026-05-09 — **M3 shipped: AD + login + Vercel Sandbox + IT-staff approval gate.** Seeded mock AD (9 users, 11 groups, mixed account states); HMAC cookie sessions; `/login` page with one-click user picker; Vercel Sandbox read-only log inspection through Tensorlake (mock-first, `VERCEL_SANDBOX_TOKEN` opt-in); InsForge gains 4 AD capabilities; 2 new runbooks for account-locked and stale-Kerberos flows; both match real Nia at ≥0.9 confidence. End-to-end verified: account-locked ticket → 4-step plan → resolved in 13.8s.
- 2026-05-09 — **M2 shipped: AI Gateway tier + moat viz + one-click demo arc.** New `aiGatewayDraft()` adapter posts to `ai-gateway.vercel.sh/v1/chat/completions` (default model `anthropic/claude-haiku-4-5`); `niaDraft()` now cascades Nia → AI Gateway → mock. Runbook cards show avg resolve time + auto-generated badge. Header has a "Run demo arc" button that fires 4 tickets sequentially.
- 2026-05-09 — **Removed AI Gateway adapter; Nia advisor now drafts response + action plan in one call.** Sponsor count 8→7. Verified 100% deflection across 3 demo tickets with real Nia (avg ~16s per ticket end-to-end). Demo helper now polls for `awaiting_approval` before auto-approving.
- 2026-05-09 — Real Nia `/v2/advisor` integration with codebase-as-runbooks payload + graceful mock fallback.
