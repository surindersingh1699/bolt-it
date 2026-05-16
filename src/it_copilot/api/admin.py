"""Admin / observability endpoints — read-only views of actual DB state and
LangGraph runtime.

These let the test console show that tool calls really mutated state, not
just that the agent claimed they did. They surface the same rows you could
query with psql, so the dashboard view and an independent DB check always
agree (or you've found a bug).
"""

from typing import Any

from fastapi import APIRouter, HTTPException
from sqlalchemy import desc, select

from it_copilot.db.models import AuditEntry, Runbook, User
from it_copilot.db.session import session_scope

router = APIRouter(prefix="/admin", tags=["admin"])


@router.get("/users/{email}")
async def get_user(email: str) -> dict:
    async with session_scope() as db:
        u = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if not u:
        raise HTTPException(404, f"no AD record for {email}")
    return {
        "email": u.email,
        "name": u.name,
        "status": u.status,
        "is_it_staff": u.is_it_staff,
        "groups": u.groups or [],
    }


@router.get("/users")
async def list_users() -> list[dict]:
    async with session_scope() as db:
        rows = (await db.execute(select(User).order_by(User.email))).scalars().all()
    return [
        {"email": u.email, "name": u.name, "status": u.status, "groups": u.groups or []}
        for u in rows
    ]


@router.get("/audit")
async def list_audit(ticket_id: str | None = None, limit: int = 50) -> list[dict]:
    limit = max(1, min(200, limit))
    async with session_scope() as db:
        q = select(AuditEntry).order_by(desc(AuditEntry.created_at)).limit(limit)
        if ticket_id:
            q = select(AuditEntry).where(AuditEntry.ticket_id == ticket_id).order_by(AuditEntry.created_at).limit(limit)
        rows = (await db.execute(q)).scalars().all()
    return [
        {
            "id": r.id,
            "ticket_id": r.ticket_id,
            "actor": r.actor,
            "action": r.action,
            "payload": r.payload or {},
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/runbooks/{runbook_id}")
async def get_runbook(runbook_id: str) -> dict:
    async with session_scope() as db:
        r = (await db.execute(select(Runbook).where(Runbook.id == runbook_id))).scalar_one_or_none()
    if not r:
        raise HTTPException(404, f"no runbook {runbook_id}")
    return {
        "id": r.id,
        "title": r.title,
        "tags": r.tags or [],
        "success_count": r.success_count,
        "failure_count": r.failure_count,
        "source_ticket_ids": r.source_ticket_ids or [],
        "auto_synthesized": r.auto_synthesized,
    }


# ---------- LangGraph introspection ----------


@router.get("/graph")
async def get_graph_structure() -> dict[str, Any]:
    """Static structure of the LangGraph state machine — nodes + edges + which
    edges are gated by an interrupt."""
    from it_copilot.agent.graph import get_graph

    graph = await get_graph()
    g = graph.get_graph()

    nodes = []
    for node_id, node in g.nodes.items():
        nodes.append({
            "id": node_id,
            "name": getattr(node, "name", node_id) or node_id,
        })

    edges = []
    for e in g.edges:
        edges.append({
            "source": e.source,
            "target": e.target,
            "conditional": bool(getattr(e, "conditional", False)),
        })

    # interrupt_before is the set of nodes whose entry blocks until resumed
    interrupts = list(getattr(graph, "interrupt_before_nodes", None) or [])
    if not interrupts:
        # langgraph compiled graphs expose this on the spec differently across
        # versions — fall back to our known list
        interrupts = ["execute", "confirm"]

    return {
        "nodes": nodes,
        "edges": edges,
        "interrupt_before": interrupts,
        "mermaid": g.draw_mermaid(),
    }


def _serialize_state_values(values: dict[str, Any]) -> dict[str, Any]:
    """Trim huge fields so the response is dashboard-friendly."""
    out = dict(values or {})
    # body/exec_log/plan can be large — cap them
    if "body" in out and isinstance(out["body"], str):
        out["body"] = out["body"][:500]
    if "plan" in out and isinstance(out["plan"], list):
        out["plan"] = [
            {k: v for k, v in s.items() if k in ("id", "capability", "status", "risk")}
            for s in out["plan"]
        ]
    if "exec_log" in out and isinstance(out["exec_log"], list):
        out["exec_log"] = out["exec_log"][-12:]
    return out


@router.get("/graph/{ticket_id}/state")
async def get_runtime_state(ticket_id: str) -> dict[str, Any]:
    """Where the graph IS right now for this ticket — next node(s), the state
    values at the latest checkpoint, and any pending tasks."""
    from it_copilot.agent.graph import get_graph

    graph = await get_graph()
    snap = await graph.aget_state({"configurable": {"thread_id": ticket_id}})
    if not snap:
        raise HTTPException(404, f"no graph state for {ticket_id}")
    return {
        "ticket_id": ticket_id,
        "next": list(snap.next or ()),
        "values": _serialize_state_values(snap.values or {}),
        "tasks": [
            {
                "name": getattr(t, "name", None),
                "state": getattr(t, "state", None),
                "error": str(getattr(t, "error", None)) if getattr(t, "error", None) else None,
            }
            for t in (getattr(snap, "tasks", None) or [])
        ],
        "metadata": dict(getattr(snap, "metadata", {}) or {}),
    }


@router.get("/graph/{ticket_id}/history")
async def get_runtime_history(ticket_id: str, limit: int = 40) -> list[dict[str, Any]]:
    """Checkpoint history — every node entry/exit captured by PostgresSaver.
    This is the canonical 'how did we get here' trace.
    """
    from it_copilot.agent.graph import get_graph

    graph = await get_graph()
    out: list[dict[str, Any]] = []
    cfg = {"configurable": {"thread_id": ticket_id}}
    async for snap in graph.aget_state_history(cfg):
        meta = dict(getattr(snap, "metadata", {}) or {})
        out.append({
            "step": meta.get("step"),
            "source": meta.get("source"),
            "writes": meta.get("writes"),
            "next": list(snap.next or ()),
            "status": (snap.values or {}).get("status"),
        })
        if len(out) >= limit:
            break
    # langgraph returns newest first; reverse so caller sees chronological
    return list(reversed(out))
