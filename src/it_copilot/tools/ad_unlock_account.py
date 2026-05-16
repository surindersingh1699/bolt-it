from typing import Any

from sqlalchemy import select

from it_copilot.db.models import User
from it_copilot.db.session import session_scope
from it_copilot.schemas.plan import ADUnlockAccountParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: ADUnlockAccountParams, ctx: dict[str, Any]) -> ToolResult:
    async with session_scope() as db:
        user = (await db.execute(select(User).where(User.email == params.email))).scalar_one_or_none()
        if not user:
            return ToolResult(ok=False, log=[f"[ad.unlock_account] {params.email} not found"])
        prior = user.status
        user.status = "active"
    return ToolResult(
        ok=True,
        log=[
            f"[ad.unlock_account] cleared lock on {params.email} (prior status: {prior})",
        ],
        data={"email": params.email, "prior_status": prior, "status": "active"},
    )


register(ToolEntry(
    capability="ad.unlock_account",
    risk="high",
    params_schema=ADUnlockAccountParams,
    run=run,
    description="Clear an account lockout in Active Directory. State-changing.",
))
