# IT Support Copilot

A LangGraph-powered IT support agent with:

- **RAG** over your runbooks (pgvector + hybrid BM25/dense retrieval)
- **Capability-scoped tools** — every action declares its risk tier; the LLM cannot invent new tools
- **Hard human-in-the-loop approval gate** built on LangGraph's `interrupt_before`
- **DB-enforced audit log** — every tool call, policy decision, approval, and state transition is appended to an immutable table (triggers block UPDATE/DELETE)
- **Prompt-injection defense** — channel-separated prompts (TRUSTED vs USER_INPUT), structured tool calling, default-deny on unknown capabilities, verifier LLM second-pass on HIGH-risk steps
- **Idempotency** + **crash-safe resume** via LangGraph's PostgresSaver checkpoints

This is the Python rebuild of the concept prototyped in [it-support-agent](../it-support-agent) — same idea (Slack ticket → retrieve runbooks → plan → approve → execute → confirm → learn), much firmer foundation.

## Quick start

```bash
# 1. start local Postgres (pgvector)
docker compose up -d

# 2. install deps + run migrations
uv sync
uv run alembic upgrade head

# 3. seed runbooks + personas + build vector index
uv run python scripts/seed_db.py
uv run python scripts/reindex_runbooks.py

# 4. start the service
uv run uvicorn it_copilot.main:app --reload
```

No `OPENAI_API_KEY` needed for the demo — the service falls back to a deterministic stub planner. Set the key in `.env` to use real LLM planning.

## Try it

```bash
# Fire a ticket
curl -X POST http://localhost:8000/tickets \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"reporter":"Alice Nguyen","reporterEmail":"alice@acme.test",
       "subject":"AD account locked","body":"Cannot log in this morning"}'

# Stream agent events (intake → retrieve → plan → INTERRUPT)
curl -N http://localhost:8000/tickets/T-XXXX/stream

# Approve from another terminal — graph resumes through execute → confirm
curl -X POST http://localhost:8000/tickets/T-XXXX/approve

# Mock the user's "yes" reply
curl -X POST http://localhost:8000/tickets/T-XXXX/confirm \
  -H "Content-Type: application/json" -d '{"resolved":true}'

# Inspect the audit trail
psql postgresql://it_copilot:it_copilot@localhost:5432/it_copilot \
  -c "SELECT action, actor, created_at FROM audit_entries WHERE ticket_id='T-XXXX' ORDER BY created_at"
```

## Architecture

```
START → intake → retrieve → plan → policy → [interrupt: approval] →
        execute (loops over PlanSteps) → confirm → learn → END
```

Every node persists its state via PostgresSaver, so the service can crash mid-execute and resume from the last checkpoint. The approval gate is **structural** (LangGraph `interrupt_before`), not a runtime conditional — there is no code path that reaches `execute` without an explicit `graph.update_state(approved=True)`.

### Layers

| Path | Purpose |
|---|---|
| `src/it_copilot/schemas/` | Pydantic — `PlanStep` is a discriminated union; the LLM's structured-output spec |
| `src/it_copilot/tools/` | One file per capability — Schema + impl + RISK tier |
| `src/it_copilot/policy/` | Allowlist (deterministic) → LLM judge → **block** on unknown |
| `src/it_copilot/rag/` | Hybrid retrieval (pgvector + BM25 + MMR) |
| `src/it_copilot/agent/` | LangGraph state machine, nodes, prompts, checkpointer |
| `src/it_copilot/api/` | FastAPI surface (tickets, runbooks, SSE stream) |
| `src/it_copilot/audit.py` | `@audited` decorator; entries written to immutable table |

## What's mocked vs real (Phase 1)

| Layer | Status |
|---|---|
| LangGraph orchestration | **Real** |
| Postgres + pgvector + Alembic | **Real** (local Docker) |
| RAG retrieval (embeddings, BM25, MMR) | **Real** when `OPENAI_API_KEY` is set; deterministic stub embedding otherwise |
| Audit log with DB-enforced immutability | **Real** |
| Idempotency keys | **Real** |
| Capability-scoped tools (AD, Okta, MDM, Sandbox, Slack) | **Mocked** — same `{ok, log}` shape the real backends will return |
| LLM planner | **Real** when `OPENAI_API_KEY` is set; deterministic stub otherwise |
| Auth (Clerk / RBAC) | **Stub** — every request runs as `morgan@acme.test` admin |
| Slack webhook | **Stub** — replaced by `POST /tickets/{id}/confirm` |

## Follow-on phases (not in this build)

- **Phase 2:** Clerk auth, Upstash rate limiting, real Vercel Sandbox for diagnostics, verifier LLM second-pass
- **Phase 3:** Wire to the existing Next.js UI (replace 600ms polling with SSE consumer); real Slack Bolt webhook; first real tool backend (Okta or LDAP)
- **Phase 4:** LangSmith traces, Sentry, PostHog, golden-ticket evals in CI

## Testing

```bash
uv run pytest                                  # unit + integration
uv run python tests/evals/run_evals.py         # golden ticket eval
```
