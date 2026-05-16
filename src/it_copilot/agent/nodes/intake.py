from it_copilot.agent.state import GraphState
from it_copilot.audit import write_audit


async def intake(state: GraphState) -> GraphState:
    await write_audit(
        ticket_id=state["ticket_id"],
        actor="system",
        action="intake",
        payload={"subject": state["subject"], "reporter_email": state["reporter_email"]},
    )
    return {"status": "drafting"}
