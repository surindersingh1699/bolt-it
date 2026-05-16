"""PlanStep — the LLM's structured output schema.

The discriminated union over `capability` means the LLM cannot emit an unknown
capability and have it parse; malformed outputs fail validation rather than
silently executing as a wildcard. Each variant's `params` is independently
typed, so reporter_email substitution and similar foot-guns are impossible.
"""

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field

# ---------- shared types ----------

StepStatus = Literal["pending", "running", "ok", "failed", "skipped"]
StepRisk = Literal["low", "medium", "high", "blocked"]
StepKind = Literal["insforge", "aside", "tensorlake", "sandbox", "slack_reply", "search"]


class _StepBase(BaseModel):
    id: str = Field(description="Unique step id within this plan, e.g. 's1', 's2'")
    description: str = Field(min_length=1, max_length=512)
    status: StepStatus = "pending"
    risk: StepRisk | None = None
    risk_reason: str | None = None
    log: list[str] = Field(default_factory=list)
    result: dict | None = None


# ---------- search / RAG (the agent calls retrieval as a tool) ----------


class SearchRunbooksParams(BaseModel):
    query: str = Field(min_length=2, max_length=512)
    k: int = Field(default=4, ge=1, le=20)


class SearchRunbooksStep(_StepBase):
    kind: Literal["search"] = "search"
    capability: Literal["search.runbooks"] = "search.runbooks"
    params: SearchRunbooksParams


# ---------- Active Directory (InsForge-pattern: policy-gated backend) ----------


class ADLookupUserParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ADLookupUserStep(_StepBase):
    kind: Literal["insforge"] = "insforge"
    capability: Literal["ad.lookup_user"] = "ad.lookup_user"
    params: ADLookupUserParams


class ADUnlockAccountParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ADUnlockAccountStep(_StepBase):
    kind: Literal["insforge"] = "insforge"
    capability: Literal["ad.unlock_account"] = "ad.unlock_account"
    params: ADUnlockAccountParams


class ADResetPasswordParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    send_email: bool = True


class ADResetPasswordStep(_StepBase):
    kind: Literal["insforge"] = "insforge"
    capability: Literal["ad.reset_password"] = "ad.reset_password"
    params: ADResetPasswordParams


class ADRefreshKerberosParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class ADRefreshKerberosStep(_StepBase):
    kind: Literal["insforge"] = "insforge"
    capability: Literal["ad.refresh_kerberos"] = "ad.refresh_kerberos"
    params: ADRefreshKerberosParams


# ---------- Okta ----------


class OktaListGroupsParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class OktaListGroupsStep(_StepBase):
    kind: Literal["insforge"] = "insforge"
    capability: Literal["okta.list_groups"] = "okta.list_groups"
    params: OktaListGroupsParams


class OktaAddToGroupParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    group: str = Field(min_length=1, max_length=128)


class OktaAddToGroupStep(_StepBase):
    kind: Literal["aside"] = "aside"
    capability: Literal["okta.add_to_group"] = "okta.add_to_group"
    params: OktaAddToGroupParams


class OktaSendResetParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class OktaSendResetStep(_StepBase):
    kind: Literal["aside"] = "aside"
    capability: Literal["okta.send_reset"] = "okta.send_reset"
    params: OktaSendResetParams


# ---------- Identity verification ----------


class IdentityVerifyParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    method: Literal["sso_session", "magic_link", "yubikey"] = "sso_session"


class IdentityVerifyStep(_StepBase):
    kind: Literal["insforge"] = "insforge"
    capability: Literal["identity.verify"] = "identity.verify"
    params: IdentityVerifyParams


# ---------- MDM ----------


class MdmPushVpnConfigParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    profile: Literal["corp-vpn", "corp-vpn-secure"] = "corp-vpn"


class MdmPushVpnConfigStep(_StepBase):
    kind: Literal["insforge"] = "insforge"
    capability: Literal["mdm.push_vpn_config"] = "mdm.push_vpn_config"
    params: MdmPushVpnConfigParams


# ---------- Sandbox diagnostics ----------


class DiagNetworkProbeParams(BaseModel):
    target: Literal["corp-vpn-gateway", "okta", "internal-dns"]


class DiagNetworkProbeStep(_StepBase):
    kind: Literal["tensorlake"] = "tensorlake"
    capability: Literal["diag.network_probe"] = "diag.network_probe"
    params: DiagNetworkProbeParams


class SandboxReadAuthLogsParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    hours: int = Field(default=24, ge=1, le=168)


class SandboxReadAuthLogsStep(_StepBase):
    kind: Literal["sandbox"] = "sandbox"
    capability: Literal["sandbox.read_auth_logs"] = "sandbox.read_auth_logs"
    params: SandboxReadAuthLogsParams


class SandboxReadKerberosLogsParams(BaseModel):
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    hours: int = Field(default=24, ge=1, le=168)


class SandboxReadKerberosLogsStep(_StepBase):
    kind: Literal["sandbox"] = "sandbox"
    capability: Literal["sandbox.read_kerberos_logs"] = "sandbox.read_kerberos_logs"
    params: SandboxReadKerberosLogsParams


# ---------- Slack reply ----------


class SlackReplyParams(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


class SlackReplyStep(_StepBase):
    kind: Literal["slack_reply"] = "slack_reply"
    capability: Literal["slack.send_message"] = "slack.send_message"
    params: SlackReplyParams


# ---------- discriminated union ----------

PlanStep = Annotated[
    Union[
        SearchRunbooksStep,
        ADLookupUserStep,
        ADUnlockAccountStep,
        ADResetPasswordStep,
        ADRefreshKerberosStep,
        OktaListGroupsStep,
        OktaAddToGroupStep,
        OktaSendResetStep,
        IdentityVerifyStep,
        MdmPushVpnConfigStep,
        DiagNetworkProbeStep,
        SandboxReadAuthLogsStep,
        SandboxReadKerberosLogsStep,
        SlackReplyStep,
    ],
    Field(discriminator="capability"),
]


class Plan(BaseModel):
    """The structured output the LLM emits."""

    response: str = Field(description="Draft reply that will be sent to the reporter after execution")
    matched_runbook_id: str | None = None
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    reasoning: str = Field(default="", max_length=2000)
    steps: list[PlanStep] = Field(default_factory=list, max_length=12)
