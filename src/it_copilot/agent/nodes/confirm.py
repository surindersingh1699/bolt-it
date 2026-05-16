from it_copilot.agent.state import GraphState
from it_copilot.audit import write_audit


async def confirm(state: GraphState) -> GraphState:
    """Routes on the user_confirmed flag set by POST /tickets/{id}/confirm.

    Without the confirm endpoint posting in, the graph rests at the second
    interrupt and the ticket stays awaiting_confirmation.
    """
    user_confirmed = state.get("user_confirmed")
    if user_confirmed is True:
        await write_audit(
            ticket_id=state["ticket_id"], actor="user",
            action="confirm_resolved",
            payload={"note": state.get("user_confirmation_note")},
        )
        return {"status": "resolved"}
    if user_confirmed is False:
        await write_audit(
            ticket_id=state["ticket_id"], actor="user",
            action="confirm_not_resolved",
            payload={"note": state.get("user_confirmation_note")},
        )
        return {"status": "escalated"}
    # interrupt point — never reached because graph is interrupted before this
    return {}
