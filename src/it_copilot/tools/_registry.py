"""Central tool registry — defines the universe of capabilities the agent can call.

Unknown capability → get_tool() returns None → execute node refuses → ticket escalates.
There is no fallback "general purpose" execution path. This is the security-relevant
invariant of the system.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel

from it_copilot.schemas.plan import StepRisk


@dataclass(frozen=True)
class ToolResult:
    ok: bool
    log: list[str]
    data: dict[str, Any] | None = None


@dataclass(frozen=True)
class ToolEntry:
    capability: str
    risk: StepRisk
    params_schema: type[BaseModel]
    run: Callable[[BaseModel, dict[str, Any]], Awaitable[ToolResult]]
    description: str


TOOLS: dict[str, ToolEntry] = {}


def register(entry: ToolEntry) -> ToolEntry:
    if entry.capability in TOOLS:
        raise RuntimeError(f"Duplicate tool registration: {entry.capability}")
    TOOLS[entry.capability] = entry
    return entry


def get_tool(capability: str) -> ToolEntry | None:
    return TOOLS.get(capability)


def tool_capabilities() -> list[str]:
    return sorted(TOOLS.keys())


def load_all_tools() -> None:
    """Import every tool module so its register() side-effect runs."""
    from it_copilot.tools import (  # noqa: F401
        ad_lookup_user,
        ad_refresh_kerberos,
        ad_reset_password,
        ad_unlock_account,
        diag_network_probe,
        identity_verify,
        mdm_push_vpn_config,
        okta_add_to_group,
        okta_list_groups,
        okta_send_reset,
        sandbox_read_auth_logs,
        sandbox_read_kerberos_logs,
        search_runbooks,
        slack_reply,
    )
