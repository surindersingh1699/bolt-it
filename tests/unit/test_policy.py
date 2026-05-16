from it_copilot.policy.classifier import classify_step
from it_copilot.tools import tool_capabilities

EXPECTED = {
    "search.runbooks": "low",
    "ad.lookup_user": "low",
    "ad.unlock_account": "high",
    "ad.reset_password": "high",
    "ad.refresh_kerberos": "high",
    "okta.list_groups": "low",
    "okta.add_to_group": "high",
    "okta.send_reset": "high",
    "identity.verify": "low",
    "mdm.push_vpn_config": "high",
    "diag.network_probe": "low",
    "sandbox.read_auth_logs": "low",
    "sandbox.read_kerberos_logs": "low",
    "slack.send_message": "low",
}


def test_every_registered_capability_classifies_to_expected_tier() -> None:
    for cap in tool_capabilities():
        result = classify_step(cap, {})
        assert result.risk == EXPECTED[cap], f"{cap}: got {result.risk}, expected {EXPECTED[cap]}"
        assert result.source == "allowlist"


def test_registry_matches_expected_set() -> None:
    assert set(tool_capabilities()) == set(EXPECTED.keys())


def test_unknown_capability_is_blocked_default_deny() -> None:
    result = classify_step("rm.minus_rf", {})
    assert result.risk == "blocked"
    assert result.source == "default-deny"
    assert "unknown capability" in result.reason


def test_made_up_capability_is_blocked() -> None:
    for cap in ("aws.delete_bucket", "shell.exec", "ad.list_all_users", "billing.refund"):
        assert classify_step(cap, {}).risk == "blocked", f"{cap} should be blocked"
