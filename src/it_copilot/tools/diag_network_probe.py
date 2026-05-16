from typing import Any

from it_copilot.schemas.plan import DiagNetworkProbeParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register

_RESULTS = {
    "corp-vpn-gateway": [
        "[diag.network_probe] traceroute to corp-vpn-gateway:",
        "[diag.network_probe]   hop 4: 10.20.30.40 (us-west-1.legacy) — high latency 380ms",
        "[diag.network_probe]   hop 7: 10.50.60.70 (us-east-1.current) — 22ms",
        "[diag.network_probe] verdict: client is routing via decommissioned us-west-1; push fresh profile",
    ],
    "okta": [
        "[diag.network_probe] DNS okta.com -> 173.222.149.105 (OK)",
        "[diag.network_probe] HTTPS handshake 1.2s, cert valid",
    ],
    "internal-dns": [
        "[diag.network_probe] internal-dns:53 reachable, query for sso.internal returns A 10.0.0.42",
    ],
}


async def run(params: DiagNetworkProbeParams, ctx: dict[str, Any]) -> ToolResult:
    log = _RESULTS.get(params.target, [f"[diag.network_probe] unknown target {params.target}"])
    return ToolResult(ok=True, log=log, data={"target": params.target})


register(ToolEntry(
    capability="diag.network_probe",
    risk="low",
    params_schema=DiagNetworkProbeParams,
    run=run,
    description="Sandboxed traceroute/probe against a known target. Read-only, no egress to corp prod.",
))
