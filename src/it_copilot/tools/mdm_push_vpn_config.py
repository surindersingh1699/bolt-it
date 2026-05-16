from typing import Any

from it_copilot.schemas.plan import MdmPushVpnConfigParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: MdmPushVpnConfigParams, ctx: dict[str, Any]) -> ToolResult:
    return ToolResult(
        ok=True,
        log=[
            f"[mdm.push_vpn_config] pushed profile={params.profile} to device for {params.email}",
            "[mdm.push_vpn_config] gateway=us-east-1, MTU=1380 (was: us-west-1, MTU=1500 stale)",
        ],
        data={"email": params.email, "profile": params.profile},
    )


register(ToolEntry(
    capability="mdm.push_vpn_config",
    risk="high",
    params_schema=MdmPushVpnConfigParams,
    run=run,
    description="Push a refreshed VPN configuration to the user's managed device via MDM.",
))
