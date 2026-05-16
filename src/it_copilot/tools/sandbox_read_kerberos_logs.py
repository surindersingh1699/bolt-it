from typing import Any

from it_copilot.schemas.plan import SandboxReadKerberosLogsParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: SandboxReadKerberosLogsParams, ctx: dict[str, Any]) -> ToolResult:
    return ToolResult(
        ok=True,
        log=[
            f"[sandbox.read_kerberos_logs] mounted klog read-only for {params.email}",
            "[sandbox.read_kerberos_logs] TGT issued 25h ago, expired 1h ago",
            "[sandbox.read_kerberos_logs] cause: laptop hibernated past renewal window",
            "[sandbox.read_kerberos_logs] verdict: stale TGT — refresh required",
        ],
        data={"email": params.email, "tgt_age_hours": 25, "verdict": "expired"},
    )


register(ToolEntry(
    capability="sandbox.read_kerberos_logs",
    risk="low",
    params_schema=SandboxReadKerberosLogsParams,
    run=run,
    description="Read Kerberos TGT/klog events for a user in a read-only sandbox.",
))
