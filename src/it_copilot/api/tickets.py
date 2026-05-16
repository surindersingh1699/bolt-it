"""Tickets API — POST to create, GET to read, SSE to stream graph events,
POST /approve to resume from the approval interrupt, POST /confirm to resume
from the user-confirmation interrupt.
"""

import asyncio
import json
import random
import string
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from sqlalchemy import select
from sse_starlette.sse import EventSourceResponse

from it_copilot.agent.graph import get_graph
from it_copilot.audit import write_audit
from it_copilot.db.models import Ticket
from it_copilot.db.session import session_scope
from it_copilot.idempotency import get_cached, store
from it_copilot.schemas.ticket import ConfirmRequest, TicketCreate

router = APIRouter(prefix="/tickets", tags=["tickets"])


def _ticket_id() -> str:
    return "T-" + "".join(random.choices(string.digits, k=4))


def _config_for(ticket_id: str) -> dict[str, Any]:
    return {"configurable": {"thread_id": ticket_id}}


async def _kick_off(ticket_id: str, payload: TicketCreate) -> None:
    graph = await get_graph()
    initial = {
        "ticket_id": ticket_id,
        "reporter": payload.reporter,
        "reporter_email": payload.reporter_email,
        "subject": payload.subject,
        "body": payload.body,
    }
    await graph.ainvoke(initial, _config_for(ticket_id))
    await _persist_from_state(ticket_id)


async def _persist_from_state(ticket_id: str) -> None:
    """Mirror the latest graph checkpoint into the ticket row for easy reads."""
    graph = await get_graph()
    snap = await graph.aget_state(_config_for(ticket_id))
    if not snap or not snap.values:
        return
    v = snap.values
    async with session_scope() as db:
        row = (await db.execute(select(Ticket).where(Ticket.id == ticket_id))).scalar_one_or_none()
        if not row:
            return
        row.status = v.get("status", row.status)
        row.plan = v.get("plan", row.plan)
        row.citations = v.get("citations", row.citations)
        row.exec_log = v.get("exec_log", row.exec_log)
        row.confidence = float(v.get("confidence", row.confidence or 0))
        row.runbook_source_id = v.get("matched_runbook_id", row.runbook_source_id)
        if v.get("status") == "resolved":
            row.resolved_by_ai = True
        rt = v.get("resolution_time_ms")
        if rt is not None:
            row.resolution_time_ms = rt


@router.post("/")
async def create_ticket(
    payload: TicketCreate,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    if idempotency_key:
        hit = await get_cached(idempotency_key)
        if hit and hit.body:
            return hit.body

    ticket_id = _ticket_id()
    async with session_scope() as db:
        db.add(Ticket(
            id=ticket_id,
            reporter=payload.reporter,
            reporter_email=payload.reporter_email,
            subject=payload.subject,
            body=payload.body,
            channel=payload.channel,
            status="new",
        ))
    await write_audit(
        ticket_id=ticket_id, actor="api",
        action="ticket_created",
        payload={"subject": payload.subject, "reporter_email": payload.reporter_email},
    )
    # Kick off the graph in the background — it will pause at the approval interrupt.
    asyncio.create_task(_kick_off(ticket_id, payload))
    response = {"id": ticket_id, "status": "new"}
    if idempotency_key:
        await store(idempotency_key, "/tickets", 200, response)
    return response


@router.get("/{ticket_id}")
async def get_ticket(ticket_id: str) -> dict[str, Any]:
    async with session_scope() as db:
        row = (await db.execute(select(Ticket).where(Ticket.id == ticket_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "ticket not found")
    return {
        "id": row.id,
        "reporter": row.reporter,
        "reporter_email": row.reporter_email,
        "subject": row.subject,
        "body": row.body,
        "status": row.status,
        "plan": row.plan or [],
        "citations": row.citations or [],
        "exec_log": row.exec_log or [],
        "confidence": row.confidence,
        "resolved_by_ai": row.resolved_by_ai,
        "runbook_source_id": row.runbook_source_id,
        "resolution_time_ms": row.resolution_time_ms,
        "created_at": row.created_at.isoformat(),
        "updated_at": row.updated_at.isoformat(),
    }


@router.get("/{ticket_id}/stream")
async def stream_ticket(ticket_id: str) -> EventSourceResponse:
    """Polls the ticket row + graph state, emits an event when status changes
    or any field updates. Phase 2 swaps this for native LangGraph
    astream_events when we move the kick-off into the request hot path.
    """

    async def gen():
        graph = await get_graph()
        cfg = _config_for(ticket_id)
        last_payload: str | None = None
        terminal = {"resolved", "escalated"}
        deadline = 60.0
        elapsed = 0.0
        while elapsed < deadline:
            await _persist_from_state(ticket_id)
            row = await get_ticket(ticket_id)
            snap = await graph.aget_state(cfg)
            row["_next"] = list(snap.next) if snap else []
            payload = json.dumps(row, default=str)
            if payload != last_payload:
                yield {"event": "update", "data": payload}
                last_payload = payload
            if row["status"] in terminal:
                yield {"event": "done", "data": payload}
                return
            await asyncio.sleep(0.4)
            elapsed += 0.4
        yield {"event": "timeout", "data": json.dumps({"id": ticket_id, "elapsed": elapsed})}

    return EventSourceResponse(gen())


@router.post("/{ticket_id}/approve")
async def approve_ticket(ticket_id: str) -> dict[str, Any]:
    graph = await get_graph()
    cfg = _config_for(ticket_id)
    snap = await graph.aget_state(cfg)
    if not snap or "execute" not in (snap.next or ()):
        raise HTTPException(400, f"ticket not awaiting approval (next: {list(snap.next) if snap else []})")
    await write_audit(
        ticket_id=ticket_id, actor="morgan@acme.test",
        action="approve",
        payload={"approver": "morgan@acme.test"},
    )
    # Resume the graph — it runs execute, then pauses again before confirm.
    async def _resume():
        await graph.ainvoke(None, cfg)
        await _persist_from_state(ticket_id)
    asyncio.create_task(_resume())
    return {"id": ticket_id, "status": "executing"}


@router.post("/{ticket_id}/confirm")
async def confirm_ticket(ticket_id: str, payload: ConfirmRequest) -> dict[str, Any]:
    graph = await get_graph()
    cfg = _config_for(ticket_id)
    snap = await graph.aget_state(cfg)
    if not snap or "confirm" not in (snap.next or ()):
        raise HTTPException(400, f"ticket not awaiting confirmation (next: {list(snap.next) if snap else []})")
    await graph.aupdate_state(cfg, {
        "user_confirmed": payload.resolved,
        "user_confirmation_note": payload.note,
    })

    async def _resume():
        await graph.ainvoke(None, cfg)
        await _persist_from_state(ticket_id)
    asyncio.create_task(_resume())
    return {"id": ticket_id, "user_confirmed": payload.resolved}


@router.post("/{ticket_id}/escalate")
async def escalate_ticket(ticket_id: str) -> dict[str, Any]:
    async with session_scope() as db:
        row = (await db.execute(select(Ticket).where(Ticket.id == ticket_id))).scalar_one_or_none()
        if not row:
            raise HTTPException(404, "not found")
        row.status = "escalated"
    await write_audit(ticket_id=ticket_id, actor="morgan@acme.test", action="escalate", payload={})
    return {"id": ticket_id, "status": "escalated"}
