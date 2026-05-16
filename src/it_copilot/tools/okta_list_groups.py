from typing import Any

from sqlalchemy import select

from it_copilot.db.models import User
from it_copilot.db.session import session_scope
from it_copilot.schemas.plan import OktaListGroupsParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register

_EXPECTED_GROUPS_BY_TEAM = {
    "designers": ["figma-designers"],
    "engineering": ["github-org", "vpn-users"],
    "sales": ["salesforce-users"],
    "finance": [],
}


async def run(params: OktaListGroupsParams, ctx: dict[str, Any]) -> ToolResult:
    async with session_scope() as db:
        user = (await db.execute(select(User).where(User.email == params.email))).scalar_one_or_none()
    if not user:
        return ToolResult(ok=False, log=[f"[okta.list_groups] {params.email} not found"])
    groups = user.groups or []
    expected = next(
        (extras for team, extras in _EXPECTED_GROUPS_BY_TEAM.items() if team in groups),
        [],
    )
    missing = [g for g in expected if g not in groups]
    return ToolResult(
        ok=True,
        log=[
            f"[okta.list_groups] {params.email}: groups={','.join(groups) or '(none)'}",
            f"[okta.list_groups] missing for role: {','.join(missing) or '(none)'}",
        ],
        data={"groups": groups, "missing": missing},
    )


register(ToolEntry(
    capability="okta.list_groups",
    risk="low",
    params_schema=OktaListGroupsParams,
    run=run,
    description="List Okta groups the user is a member of, and any expected-for-role groups missing.",
))
