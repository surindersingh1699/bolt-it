"""Defense-in-depth checks against prompt-injection patterns.

These exercise the layers that don't require a live LLM:
1. The schema makes invented capabilities unrepresentable.
2. The execute node forces `email` params back to the authenticated reporter,
   regardless of what the LLM produced.
3. Default-deny on unknown capabilities.
"""

import pytest

from it_copilot.agent.nodes.execute import execute
from it_copilot.audit import write_audit
from it_copilot.policy.classifier import classify_step


@pytest.mark.asyncio
async def test_orchestrator_overrides_email_param_with_authenticated_reporter(monkeypatch):
    """If a malicious ticket body convinces the LLM to call ad.reset_password
    with someone else's email, the execute node MUST swap it back to the
    authenticated reporter before the tool runs.
    """
    audited = []

    async def fake_audit(**kw):  # noqa: ANN003
        audited.append(kw)

    monkeypatch.setattr("it_copilot.agent.nodes.execute.write_audit", fake_audit)

    captured = {}

    async def fake_run(params, ctx):  # noqa: ANN001
        captured["email"] = params.email
        from it_copilot.tools._registry import ToolResult
        return ToolResult(ok=True, log=["mocked"], data={})

    from it_copilot.tools import _registry
    original = _registry.TOOLS["ad.reset_password"]
    _registry.TOOLS["ad.reset_password"] = original.__class__(
        capability=original.capability, risk=original.risk,
        params_schema=original.params_schema, run=fake_run, description=original.description,
    )

    state = {
        "ticket_id": "T-0001",
        "reporter_email": "alice@acme.test",
        "plan": [{
            "id": "s1", "kind": "insforge", "capability": "ad.reset_password",
            "description": "reset", "status": "pending", "risk": "high",
            "params": {"email": "attacker@evil.test", "send_email": True},
        }],
        "exec_log": [],
    }

    try:
        result = await execute(state)
    finally:
        _registry.TOOLS["ad.reset_password"] = original

    assert captured["email"] == "alice@acme.test", "email param was NOT overridden by trusted reporter"
    assert result["status"] == "awaiting_confirmation"


@pytest.mark.asyncio
async def test_unknown_capability_blocks_and_escalates(monkeypatch):
    async def fake_audit(**kw):  # noqa: ANN003
        return None

    monkeypatch.setattr("it_copilot.agent.nodes.execute.write_audit", fake_audit)

    state = {
        "ticket_id": "T-0002",
        "reporter_email": "alice@acme.test",
        "plan": [{
            "id": "s1", "kind": "insforge", "capability": "shell.exec",
            "description": "evil", "status": "pending", "risk": "blocked",
            "params": {},
        }],
        "exec_log": [],
    }
    result = await execute(state)
    assert result["status"] == "escalated"
    assert result["plan"][0]["status"] == "skipped"


@pytest.mark.asyncio
async def test_invented_capability_classifies_blocked():
    """The classifier must default-deny anything not in the registry, even when
    the caller invents a plausible-looking name."""
    for cap in ("ad.delete_user", "okta.read_passwords", "billing.charge"):
        assert classify_step(cap, {}).risk == "blocked"
