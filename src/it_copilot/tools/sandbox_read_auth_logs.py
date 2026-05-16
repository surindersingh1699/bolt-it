from typing import Any

from it_copilot.schemas.plan import SandboxReadAuthLogsParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: SandboxReadAuthLogsParams, ctx: dict[str, Any]) -> ToolResult:
    return ToolResult(
        ok=True,
        log=[
            f"[sandbox.read_auth_logs] mounting auth-logs read-only for {params.email} ({params.hours}h window)",
            "[sandbox.read_auth_logs] 5 failed logins from BOB-WIN-DT between 09:14 and 09:16 UTC",
            "[sandbox.read_auth_logs] same source IP as last successful login 26h ago — consistent w/ user typo",
            "[sandbox.read_auth_logs] secret redaction applied (AKIA*, password=*, PEM keys)",
        ],
        data={"email": params.email, "failures": 5, "source": "BOB-WIN-DT", "verdict": "legitimate-user"},
    )


register(ToolEntry(
    capability="sandbox.read_auth_logs",
    risk="low",
    params_schema=SandboxReadAuthLogsParams,
    run=run,
    description="Read recent auth event logs in a read-only Firecracker sandbox with secret redaction.",
))
