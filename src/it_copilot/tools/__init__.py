"""Capability-scoped tools.

Each module exports (RISK, PARAMS_SCHEMA, run) — registered into _registry.TOOLS.
get_tool(capability) returns the entry or None; None triggers default-deny in the
execute node.
"""

from it_copilot.tools._registry import TOOLS, ToolEntry, get_tool, tool_capabilities

__all__ = ["TOOLS", "ToolEntry", "get_tool", "tool_capabilities"]
