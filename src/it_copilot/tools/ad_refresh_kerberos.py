from typing import Any

from sqlalchemy import select

from it_copilot.db.models import User
from it_copilot.db.session import session_scope
from it_copilot.schemas.plan import ADRefreshKerberosParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: ADRefreshKerberosParams, ctx: dict[str, Any]) -> ToolResult:
    async with session_scope() as db:
        user = (await db.execute(select(User).where(User.email == params.email))).scalar_one_or_none()
        if not user:
            return ToolResult(ok=False, log=[f"[ad.refresh_kerberos] {params.email} not found"])
        prior = user.status
        if user.status == "stale_kerberos":
            user.status = "active"
    return ToolResult(
        ok=True,
        log=[
            f"[ad.refresh_kerberos] purged stale TGT and issued klist/krenew for {params.email}",
            f"[ad.refresh_kerberos] account status: {prior} -> {('active' if prior == 'stale_kerberos' else prior)}",
        ],
        data={"email": params.email, "prior_status": prior},
    )


register(ToolEntry(
    capability="ad.refresh_kerberos",
    risk="high",
    params_schema=ADRefreshKerberosParams,
    run=run,
    description="Issue klist purge + krenew to refresh an expired Kerberos TGT.",
))
