"""Execute every step in the plan serially.

Each step routes through the tool registry; unknown capabilities are blocked
(default-deny) and the ticket escalates. State-changing steps re-validate
their params against the tool's Pydantic schema right before invocation —
the orchestrator forces `reporter_email` from the trusted graph state, never
from anything the LLM emitted via USER_INPUT.
"""

import time
from typing import Any

from it_copilot.agent.state import GraphState
from it_copilot.audit import write_audit
from it_copilot.tools import get_tool

_REPORTER_FIELDS = {"email"}  # params we always override with the trusted reporter_email


async def execute(state: GraphState) -> GraphState:
    started = time.monotonic()
    reporter_email = state["reporter_email"]
    ctx: dict[str, Any] = {"reporter_email": reporter_email, "ticket_id": state["ticket_id"]}

    plan = [dict(s) for s in state["plan"]]
    exec_log = list(state.get("exec_log", []))

    for step in plan:
        cap = step["capability"]
        if step.get("risk") == "blocked":
            step["status"] = "skipped"
            step["log"] = [*step.get("log", []), "[execute] BLOCKED by policy — escalating"]
            exec_log.append({"step_id": step["id"], "ok": False, "blocked": True})
            await write_audit(
                ticket_id=state["ticket_id"], actor="execute", action="blocked",
                payload={"step_id": step["id"], "capability": cap},
            )
            return {"plan": plan, "exec_log": exec_log, "status": "escalated"}

        tool = get_tool(cap)
        if tool is None:
            step["status"] = "skipped"
            step["log"] = [*step.get("log", []), f"[execute] unknown capability {cap} — escalating"]
            exec_log.append({"step_id": step["id"], "ok": False, "unknown": True})
            await write_audit(
                ticket_id=state["ticket_id"], actor="execute", action="unknown_capability",
                payload={"step_id": step["id"], "capability": cap},
            )
            return {"plan": plan, "exec_log": exec_log, "status": "escalated"}

        step["status"] = "running"
        raw_params = dict(step.get("params", {}))
        # Trust boundary: any `email` param is forced to the authenticated reporter.
        for f in _REPORTER_FIELDS:
            if f in raw_params:
                raw_params[f] = reporter_email
        try:
            parsed = tool.params_schema(**raw_params)
        except Exception as e:  # noqa: BLE001
            step["status"] = "failed"
            step["log"] = [*step.get("log", []), f"[execute] params invalid: {e}"]
            exec_log.append({"step_id": step["id"], "ok": False, "error": str(e)})
            await write_audit(
                ticket_id=state["ticket_id"], actor="execute", action="invalid_params",
                payload={"step_id": step["id"], "capability": cap, "error": str(e)[:300]},
            )
            return {"plan": plan, "exec_log": exec_log, "status": "escalated"}

        try:
            result = await tool.run(parsed, ctx)
        except Exception as e:  # noqa: BLE001
            step["status"] = "failed"
            step["log"] = [*step.get("log", []), f"[execute] error: {e}"]
            exec_log.append({"step_id": step["id"], "ok": False, "error": str(e)})
            await write_audit(
                ticket_id=state["ticket_id"], actor="execute", action="tool_error",
                payload={"step_id": step["id"], "capability": cap, "error": str(e)[:300]},
            )
            return {"plan": plan, "exec_log": exec_log, "status": "escalated"}

        step["status"] = "ok" if result.ok else "failed"
        step["log"] = [*step.get("log", []), *result.log]
        step["result"] = result.data
        exec_log.append({"step_id": step["id"], "capability": cap, "ok": result.ok, "log": result.log})
        await write_audit(
            ticket_id=state["ticket_id"], actor="execute", action="tool_call",
            payload={
                "step_id": step["id"], "capability": cap,
                "ok": result.ok, "params": parsed.model_dump(mode="json"),
            },
        )
        if not result.ok:
            return {"plan": plan, "exec_log": exec_log, "status": "escalated"}

    elapsed_ms = int((time.monotonic() - started) * 1000)
    return {"plan": plan, "exec_log": exec_log, "status": "awaiting_confirmation",
            "resolution_time_ms": elapsed_ms}
