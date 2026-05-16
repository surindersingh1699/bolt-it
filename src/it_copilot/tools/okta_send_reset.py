from typing import Any

from it_copilot.schemas.plan import OktaSendResetParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: OktaSendResetParams, ctx: dict[str, Any]) -> ToolResult:
    return ToolResult(
        ok=True,
        log=[
            f"[okta.send_reset] (Aside) sent Okta password reset email to {params.email}",
        ],
        data={"email": params.email, "sent": True},
    )


register(ToolEntry(
    capability="okta.send_reset",
    risk="high",
    params_schema=OktaSendResetParams,
    run=run,
    description="Trigger Okta's password reset flow (in user's own browser via Aside).",
))
