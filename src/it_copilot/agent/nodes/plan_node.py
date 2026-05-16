from it_copilot.agent.planner import generate_plan
from it_copilot.agent.state import GraphState
from it_copilot.audit import write_audit


async def plan_node(state: GraphState) -> GraphState:
    retrieved = [
        {"runbook_id": c["runbook_id"], "title": c.get("runbook_id", ""), "snippet": c["snippet"], "score": c["score"]}
        for c in state.get("citations", [])
        if c.get("runbook_id")
    ]
    plan = await generate_plan(
        subject=state["subject"],
        body=state["body"],
        reporter_email=state["reporter_email"],
        retrieved=retrieved,
    )
    steps = [s.model_dump() if hasattr(s, "model_dump") else s for s in plan.steps]
    await write_audit(
        ticket_id=state["ticket_id"],
        actor="agent.plan",
        action="plan",
        payload={
            "matched_runbook_id": plan.matched_runbook_id,
            "confidence": plan.confidence,
            "step_count": len(steps),
            "capabilities": [s.get("capability") for s in steps],
        },
    )
    return {
        "plan": steps,
        "response": plan.response,
        "matched_runbook_id": plan.matched_runbook_id,
        "confidence": plan.confidence,
        "reasoning": plan.reasoning,
    }
