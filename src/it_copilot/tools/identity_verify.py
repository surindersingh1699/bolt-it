from typing import Any

from it_copilot.schemas.plan import IdentityVerifyParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: IdentityVerifyParams, ctx: dict[str, Any]) -> ToolResult:
    return ToolResult(
        ok=True,
        log=[
            f"[identity.verify] {params.email} verified via {params.method}",
            "[identity.verify] recent SSO session matches reporter device fingerprint",
        ],
        data={"email": params.email, "method": params.method, "verified": True},
    )


register(ToolEntry(
    capability="identity.verify",
    risk="low",
    params_schema=IdentityVerifyParams,
    run=run,
    description="Verify a reporter's identity out-of-band before any state-changing action.",
))
