import pytest
from pydantic import TypeAdapter, ValidationError

from it_copilot.schemas.plan import Plan, PlanStep

_step_adapter = TypeAdapter(PlanStep)


def test_plan_step_accepts_known_capability() -> None:
    s = _step_adapter.validate_python({
        "id": "s1", "kind": "insforge", "capability": "ad.lookup_user",
        "description": "look up", "params": {"email": "x@y.com"},
    })
    assert s.capability == "ad.lookup_user"


def test_plan_step_rejects_unknown_capability() -> None:
    with pytest.raises(ValidationError):
        _step_adapter.validate_python({
            "id": "s1", "kind": "insforge", "capability": "shell.exec",
            "description": "exec", "params": {"cmd": "rm -rf /"},
        })


def test_plan_step_rejects_invalid_email_param() -> None:
    with pytest.raises(ValidationError):
        _step_adapter.validate_python({
            "id": "s1", "kind": "insforge", "capability": "ad.unlock_account",
            "description": "unlock", "params": {"email": "not-an-email"},
        })


def test_plan_step_rejects_missing_params() -> None:
    with pytest.raises(ValidationError):
        _step_adapter.validate_python({
            "id": "s1", "kind": "insforge", "capability": "ad.unlock_account",
            "description": "unlock", "params": {},
        })


def test_plan_round_trips() -> None:
    p = Plan(
        response="ok",
        matched_runbook_id="rb-ad-account-locked",
        confidence=0.9,
        reasoning="",
        steps=[{
            "id": "s1", "kind": "insforge", "capability": "ad.unlock_account",
            "description": "unlock", "params": {"email": "alice@acme.test"},
        }],
    )
    again = Plan.model_validate(p.model_dump())
    assert again.steps[0].capability == "ad.unlock_account"
