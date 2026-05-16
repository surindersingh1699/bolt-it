from typing import Any

from it_copilot.schemas.plan import ADResetPasswordParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: ADResetPasswordParams, ctx: dict[str, Any]) -> ToolResult:
    log = [
        f"[ad.reset_password] issued temporary credential for {params.email}",
    ]
    if params.send_email:
        log.append(f"[ad.reset_password] reset email dispatched to {params.email}")
    return ToolResult(ok=True, log=log, data={"email": params.email, "email_sent": params.send_email})


register(ToolEntry(
    capability="ad.reset_password",
    risk="high",
    params_schema=ADResetPasswordParams,
    run=run,
    description="Reset a user's AD password and (optionally) email a temporary credential.",
))
