"""End-to-end integration test against a real Postgres + the real graph.

Requires `docker compose up -d` and migrations applied. Uses the stub LLM
fallback (no OPENAI_API_KEY needed). Skips if the DB isn't reachable.
"""

import asyncio

import pytest
from sqlalchemy import select, text

from it_copilot.audit import write_audit
from it_copilot.db.models import AuditEntry, Ticket
from it_copilot.db.session import session_scope


async def _db_reachable() -> bool:
    """Build a throwaway engine so a poisoned connection in the shared pool
    (e.g. from a trigger-raised IntegrityError in a prior test) can't
    falsely report the DB as down."""
    from sqlalchemy.ext.asyncio import create_async_engine

    from it_copilot.config import get_settings

    e = create_async_engine(get_settings().database_url, pool_pre_ping=True)
    try:
        async with e.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception:  # noqa: BLE001
        return False
    finally:
        await e.dispose()


@pytest.mark.asyncio
async def test_db_audit_log_is_immutable():
    if not await _db_reachable():
        pytest.skip("Postgres not reachable — run `docker compose up -d && uv run alembic upgrade head`")

    import uuid

    from sqlalchemy.ext.asyncio import create_async_engine

    from it_copilot.config import get_settings

    ticket_id = f"IMM-{uuid.uuid4().hex[:8]}"[:16]

    # Use an isolated engine throughout so trigger-aborted transactions can't
    # poison the shared module-level pool that other tests depend on.
    iso = create_async_engine(get_settings().database_url, pool_pre_ping=True)
    try:
        async with iso.begin() as conn:
            await conn.execute(text(
                "INSERT INTO tickets (id, reporter, reporter_email, subject, body, status) "
                "VALUES (:i, 't', 't@t.test', 'immut-test', 'x', 'resolved')"
            ), {"i": ticket_id})
            await conn.execute(text(
                "INSERT INTO audit_entries (ticket_id, actor, action, payload) "
                "VALUES (:i, 'test', 'seed', '{}'::jsonb::json)"
            ), {"i": ticket_id})

        with pytest.raises(Exception):
            async with iso.begin() as conn:
                await conn.execute(text(
                    "UPDATE audit_entries SET actor='hacker' WHERE ticket_id=:i"
                ), {"i": ticket_id})

        with pytest.raises(Exception):
            async with iso.begin() as conn:
                await conn.execute(text(
                    "DELETE FROM audit_entries WHERE ticket_id=:i"
                ), {"i": ticket_id})

        async with iso.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT actor, action FROM audit_entries WHERE ticket_id=:i"
            ), {"i": ticket_id})).all()
            assert any(r.actor == "test" and r.action == "seed" for r in rows)
    finally:
        await iso.dispose()


@pytest.mark.asyncio
async def test_full_graph_alice_locked_account():
    if not await _db_reachable():
        pytest.skip("Postgres not reachable")

    from it_copilot.agent.graph import get_graph
    from it_copilot.rag.ingest import reindex_runbooks, seed_runbooks_and_users

    await seed_runbooks_and_users()
    await reindex_runbooks()

    import uuid
    ticket_id = f"T-{uuid.uuid4().hex[:6]}"
    async with session_scope() as db:
        db.add(Ticket(
            id=ticket_id, reporter="Alice Nguyen", reporter_email="alice@acme.test",
            subject="AD account locked", body="Cannot log in this morning", status="new",
        ))

    graph = await get_graph()
    cfg = {"configurable": {"thread_id": ticket_id}}

    # Reset thread (in case of prior run)
    try:
        await graph.aupdate_state(cfg, {"ticket_id": ticket_id})
    except Exception:
        pass

    await graph.ainvoke({
        "ticket_id": ticket_id,
        "reporter": "Alice Nguyen",
        "reporter_email": "alice@acme.test",
        "subject": "AD account locked",
        "body": "Cannot log in this morning",
    }, cfg)

    snap = await graph.aget_state(cfg)
    assert "execute" in snap.next, f"expected pause before execute, got next={snap.next}"
    assert snap.values["status"] == "awaiting_approval"
    assert snap.values.get("citations"), "retrieval produced no citations"
    assert len(snap.values["plan"]) >= 2

    # Approve
    await graph.ainvoke(None, cfg)
    snap = await graph.aget_state(cfg)
    assert "confirm" in snap.next, f"expected pause before confirm, got next={snap.next}"
    assert snap.values["status"] == "awaiting_confirmation"
    # all steps executed
    assert all(s["status"] in ("ok", "skipped") for s in snap.values["plan"])

    # Confirm
    await graph.aupdate_state(cfg, {"user_confirmed": True})
    await graph.ainvoke(None, cfg)
    snap = await graph.aget_state(cfg)
    assert snap.values["status"] == "resolved"

    # Audit log has many entries
    async with session_scope() as db:
        rows = (await db.execute(select(AuditEntry).where(AuditEntry.ticket_id == ticket_id))).scalars().all()
    actions = [r.action for r in rows]
    # Note: "approve" is written by the /approve API, not the graph — this test
    # drives the graph directly so it's expected to be absent here.
    assert "intake" in actions
    assert "retrieve" in actions
    assert "plan" in actions
    assert "classify" in actions
    assert any(a == "tool_call" for a in actions), f"expected tool_call audit entries, got {actions}"
    assert "confirm_resolved" in actions
