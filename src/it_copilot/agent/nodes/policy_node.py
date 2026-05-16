from it_copilot.agent.state import GraphState
from it_copilot.audit import write_audit
from it_copilot.policy.classifier import classify_step


async def policy_node(state: GraphState) -> GraphState:
    annotated: list[dict] = []
    for step in state["plan"]:
        cls = classify_step(step["capability"], step.get("params", {}))
        annotated.append({
            **step,
            "risk": cls.risk,
            "risk_reason": cls.reason,
            "log": [*step.get("log", []), f"[policy] {cls.risk} ({cls.source}) — {cls.reason}"],
        })
        await write_audit(
            ticket_id=state["ticket_id"],
            actor="policy",
            action="classify",
            payload={
                "step_id": step.get("id"),
                "capability": step["capability"],
                "risk": cls.risk,
                "source": cls.source,
            },
        )
    return {"plan": annotated, "status": "awaiting_approval"}
