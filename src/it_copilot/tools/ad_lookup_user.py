from typing import Any

from sqlalchemy import select

from it_copilot.db.models import User
from it_copilot.db.session import session_scope
from it_copilot.schemas.plan import ADLookupUserParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: ADLookupUserParams, ctx: dict[str, Any]) -> ToolResult:
    async with session_scope() as db:
        user = (await db.execute(select(User).where(User.email == params.email))).scalar_one_or_none()
    if not user:
        return ToolResult(ok=False, log=[f"[ad.lookup_user] no AD record for {params.email}"])
    return ToolResult(
        ok=True,
        log=[
            f"[ad.lookup_user] {params.email}: status={user.status}, "
            f"groups={','.join(user.groups or [])}",
        ],
        data={"email": user.email, "name": user.name, "status": user.status, "groups": user.groups},
    )


register(ToolEntry(
    capability="ad.lookup_user",
    risk="low",
    params_schema=ADLookupUserParams,
    run=run,
    description="Look up an AD user by email. Returns status, groups, name. Read-only.",
))
