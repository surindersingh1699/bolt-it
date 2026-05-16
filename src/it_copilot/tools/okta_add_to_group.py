from typing import Any

from sqlalchemy import select

from it_copilot.db.models import User
from it_copilot.db.session import session_scope
from it_copilot.schemas.plan import OktaAddToGroupParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: OktaAddToGroupParams, ctx: dict[str, Any]) -> ToolResult:
    async with session_scope() as db:
        user = (await db.execute(select(User).where(User.email == params.email))).scalar_one_or_none()
        if not user:
            return ToolResult(ok=False, log=[f"[okta.add_to_group] {params.email} not found"])
        groups = list(user.groups or [])
        if params.group not in groups:
            groups.append(params.group)
            user.groups = groups
    return ToolResult(
        ok=True,
        log=[
            f"[okta.add_to_group] (Aside) added {params.email} to {params.group} in user's own session",
        ],
        data={"email": params.email, "group": params.group, "groups": groups},
    )


register(ToolEntry(
    capability="okta.add_to_group",
    risk="high",
    params_schema=OktaAddToGroupParams,
    run=run,
    description="Add a user to an Okta group via Aside (executes in the user's authenticated browser).",
))
