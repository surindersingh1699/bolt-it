"""Plan generator.

When OPENAI_API_KEY is set, uses ChatOpenAI with `.with_structured_output(Plan)`
to emit a validated Plan via tool calling. Without a key, falls back to a
deterministic tag-scored planner that matches the original project's mock
behavior — enough to demo the entire graph without external dependencies.
"""

from it_copilot.agent.prompts import build_system_prompt, build_user_prompt
from it_copilot.config import get_settings
from it_copilot.schemas.plan import Plan


async def generate_plan(
    *,
    subject: str,
    body: str,
    reporter_email: str,
    retrieved: list[dict],
) -> Plan:
    settings = get_settings()
    if settings.has_openai:
        try:
            return await _llm_plan(subject=subject, body=body, reporter_email=reporter_email, retrieved=retrieved)
        except Exception as e:  # noqa: BLE001
            # Never let an LLM failure break the graph — fall through to stub
            print(f"[planner] LLM failed: {e!r}; falling back to stub")
    return _stub_plan(subject=subject, body=body, reporter_email=reporter_email, retrieved=retrieved)


async def _llm_plan(*, subject: str, body: str, reporter_email: str, retrieved: list[dict]) -> Plan:
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_openai import ChatOpenAI

    settings = get_settings()
    llm = ChatOpenAI(
        model=settings.openai_model,
        api_key=settings.openai_api_key,
        temperature=0,
    ).with_structured_output(Plan)
    return await llm.ainvoke([
        SystemMessage(content=build_system_prompt()),
        HumanMessage(content=build_user_prompt(
            subject=subject, body=body, reporter_email=reporter_email, retrieved=retrieved,
        )),
    ])


# --------------- deterministic stub ----------------

_STUB_PLANS: dict[str, callable] = {}


def _register_stub(runbook_id: str):
    def deco(fn):
        _STUB_PLANS[runbook_id] = fn
        return fn
    return deco


@_register_stub("rb-ad-account-locked")
def _ad_locked(reporter_email: str, _retrieved):
    return Plan(
        response="Your AD account is unlocked. Try signing in again — please reply 'yes' to confirm or 'no' if you still can't get in.",
        matched_runbook_id="rb-ad-account-locked",
        confidence=0.92,
        reasoning="Symptoms match account-lockout runbook (failed-login pattern). Verify, read recent auth logs, unlock.",
        steps=[
            {
                "id": "s1", "kind": "insforge", "capability": "ad.lookup_user",
                "description": "Confirm account is locked", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s2", "kind": "sandbox", "capability": "sandbox.read_auth_logs",
                "description": "Read recent auth events to confirm legitimate user", "status": "pending",
                "params": {"email": reporter_email, "hours": 24},
            },
            {
                "id": "s3", "kind": "insforge", "capability": "identity.verify",
                "description": "Out-of-band identity check", "status": "pending",
                "params": {"email": reporter_email, "method": "sso_session"},
            },
            {
                "id": "s4", "kind": "insforge", "capability": "ad.unlock_account",
                "description": "Clear the lock", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s5", "kind": "slack_reply", "capability": "slack.send_message",
                "description": "Notify reporter the account is unlocked", "status": "pending",
                "params": {"message": "Your account is unlocked. Try signing in again — reply 'yes' to confirm or 'no' if not."},
            },
        ],
    )


@_register_stub("rb-figma-sso")
def _figma_sso(reporter_email: str, _retrieved):
    return Plan(
        response="Re-added you to the figma-designers Okta group — please retry. Reply 'yes' if you're in or 'no' if still blocked.",
        matched_runbook_id="rb-figma-sso",
        confidence=0.9,
        reasoning="Classic group-drift symptom after a team change.",
        steps=[
            {
                "id": "s1", "kind": "insforge", "capability": "okta.list_groups",
                "description": "Confirm figma-designers is missing", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s2", "kind": "aside", "capability": "okta.add_to_group",
                "description": "Re-add to figma-designers via Aside", "status": "pending",
                "params": {"email": reporter_email, "group": "figma-designers"},
            },
            {
                "id": "s3", "kind": "slack_reply", "capability": "slack.send_message",
                "description": "Notify reporter", "status": "pending",
                "params": {"message": "You're back in figma-designers. Reload Figma and reply 'yes' if access is restored."},
            },
        ],
    )


@_register_stub("rb-vpn-slow")
def _vpn_slow(reporter_email: str, _retrieved):
    return Plan(
        response="Pushed a refreshed VPN profile pointing at the current us-east-1 gateway. Reconnect and reply 'yes' if speed improves.",
        matched_runbook_id="rb-vpn-slow",
        confidence=0.85,
        reasoning="Stale client config pointing at decommissioned us-west-1; standard MTU mismatch.",
        steps=[
            {
                "id": "s1", "kind": "tensorlake", "capability": "diag.network_probe",
                "description": "Probe VPN gateway to confirm stale routing", "status": "pending",
                "params": {"target": "corp-vpn-gateway"},
            },
            {
                "id": "s2", "kind": "insforge", "capability": "mdm.push_vpn_config",
                "description": "Push refreshed VPN profile", "status": "pending",
                "params": {"email": reporter_email, "profile": "corp-vpn"},
            },
            {
                "id": "s3", "kind": "slack_reply", "capability": "slack.send_message",
                "description": "Ask user to reconnect", "status": "pending",
                "params": {"message": "Pushed a fresh VPN profile. Reconnect and reply 'yes' if it's better."},
            },
        ],
    )


@_register_stub("rb-password-reset")
def _password_reset(reporter_email: str, _retrieved):
    return Plan(
        response="Sent an Okta reset email. Check your inbox and reply 'yes' once you're back in.",
        matched_runbook_id="rb-password-reset",
        confidence=0.88,
        reasoning="Standard password reset for a verified user.",
        steps=[
            {
                "id": "s1", "kind": "insforge", "capability": "identity.verify",
                "description": "Out-of-band identity check", "status": "pending",
                "params": {"email": reporter_email, "method": "sso_session"},
            },
            {
                "id": "s2", "kind": "aside", "capability": "okta.send_reset",
                "description": "Trigger reset in user's own browser", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s3", "kind": "slack_reply", "capability": "slack.send_message",
                "description": "Notify reporter", "status": "pending",
                "params": {"message": "Reset email sent. Check your inbox and reply 'yes' once you're in."},
            },
        ],
    )


@_register_stub("rb-stale-kerberos")
def _stale_kerb(reporter_email: str, _retrieved):
    return Plan(
        response="Refreshed your Kerberos ticket. Try the mapped drives again and reply 'yes' if they work.",
        matched_runbook_id="rb-stale-kerberos",
        confidence=0.86,
        reasoning="Expired TGT after hibernation; standard refresh.",
        steps=[
            {
                "id": "s1", "kind": "insforge", "capability": "ad.lookup_user",
                "description": "Confirm account is healthy", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s2", "kind": "sandbox", "capability": "sandbox.read_kerberos_logs",
                "description": "Confirm expired TGT", "status": "pending",
                "params": {"email": reporter_email, "hours": 24},
            },
            {
                "id": "s3", "kind": "insforge", "capability": "ad.refresh_kerberos",
                "description": "Issue klist purge + krenew", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s4", "kind": "slack_reply", "capability": "slack.send_message",
                "description": "Notify reporter", "status": "pending",
                "params": {"message": "Refreshed your Kerberos ticket. Retry mapped drives and reply 'yes' if they work."},
            },
        ],
    )


@_register_stub("rb-laptop-onboard")
def _laptop_onboard(reporter_email: str, _retrieved):
    return Plan(
        response="Laptop onboarding kicked off — MDM profile pushed, default groups added. Reply 'yes' once you're set up.",
        matched_runbook_id="rb-laptop-onboard",
        confidence=0.82,
        reasoning="Standard Day-0 onboarding plan.",
        steps=[
            {
                "id": "s1", "kind": "insforge", "capability": "ad.lookup_user",
                "description": "Confirm AD record exists", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s2", "kind": "insforge", "capability": "mdm.push_vpn_config",
                "description": "Push baseline VPN profile", "status": "pending",
                "params": {"email": reporter_email, "profile": "corp-vpn"},
            },
            {
                "id": "s3", "kind": "slack_reply", "capability": "slack.send_message",
                "description": "Welcome the user", "status": "pending",
                "params": {"message": "Welcome! Your laptop is set up. Reply 'yes' once you can sign in to everything."},
            },
        ],
    )


def _stub_plan(*, subject: str, body: str, reporter_email: str, retrieved: list[dict]) -> Plan:
    if retrieved:
        top = retrieved[0]
        rb_id = top["runbook_id"]
        if rb_id in _STUB_PLANS:
            plan = _STUB_PLANS[rb_id](reporter_email, retrieved)
            plan.confidence = min(plan.confidence, max(0.5, top.get("score", 0.5)))
            return plan

    # No runbook match — minimal escalation plan
    return Plan(
        response="I don't have a runbook for this yet — a technician will take a look.",
        matched_runbook_id=None,
        confidence=0.3,
        reasoning="No runbook match; safe fallback that hands off to a human.",
        steps=[
            {
                "id": "s1", "kind": "insforge", "capability": "ad.lookup_user",
                "description": "Gather basic context on the reporter", "status": "pending",
                "params": {"email": reporter_email},
            },
            {
                "id": "s2", "kind": "slack_reply", "capability": "slack.send_message",
                "description": "Acknowledge and hand off", "status": "pending",
                "params": {"message": "Thanks — I've logged this and a technician will follow up shortly."},
            },
        ],
    )
