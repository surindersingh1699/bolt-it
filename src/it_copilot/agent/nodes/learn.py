from sqlalchemy import select

from it_copilot.agent.state import GraphState
from it_copilot.audit import write_audit
from it_copilot.db.models import Runbook
from it_copilot.db.session import session_scope


async def learn(state: GraphState) -> GraphState:
    if state.get("status") != "resolved":
        return {}
    rb_id = state.get("matched_runbook_id")
    if rb_id and state.get("confidence", 0) >= 0.6:
        async with session_scope() as db:
            rb = (await db.execute(select(Runbook).where(Runbook.id == rb_id))).scalar_one_or_none()
            if rb:
                rb.success_count += 1
                src = list(rb.source_ticket_ids or [])
                if state["ticket_id"] not in src:
                    src.append(state["ticket_id"])
                rb.source_ticket_ids = src
        await write_audit(
            ticket_id=state["ticket_id"], actor="learn",
            action="runbook_success",
            payload={"runbook_id": rb_id},
        )
    return {}
