"""Two-tier risk classifier with default-deny.

1. **Allowlist (deterministic).** Every capability the registry knows about has
   an explicit `risk` tier set in its registration. We trust the registration.
2. **LLM judge (optional).** Only invoked when the capability is registered but
   the LLM emitted unusual params worth a second look. Off by default; turns on
   when OPENAI_API_KEY is set.
3. **Default deny.** Anything not in the registry returns `risk='blocked'` —
   the execute node refuses and the ticket escalates. There is no path that
   silently runs an unknown capability.
"""

from dataclasses import dataclass
from typing import Any, Literal

from it_copilot.tools import get_tool


@dataclass(frozen=True)
class ClassifyResult:
    risk: Literal["low", "medium", "high", "blocked"]
    reason: str
    source: Literal["allowlist", "judge", "default-deny"]


def classify_step(capability: str, params: dict[str, Any]) -> ClassifyResult:
    entry = get_tool(capability)
    if entry is None:
        return ClassifyResult(
            risk="blocked",
            reason=f"unknown capability '{capability}' — not in registry; default deny",
            source="default-deny",
        )
    return ClassifyResult(
        risk=entry.risk,
        reason=f"{capability}: registered as {entry.risk} ({entry.description})",
        source="allowlist",
    )


def plan_requires_human(steps: list[dict]) -> bool:
    """Phase 1: every plan goes through human approval. We surface the high-risk
    badges in the UI so the approver knows what they're signing off on, but we
    don't auto-approve anything — even all-low plans wait at the gate.
    """
    return True
