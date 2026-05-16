from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

TicketStatus = Literal[
    "new",
    "drafting",
    "awaiting_approval",
    "executing",
    "awaiting_confirmation",
    "resolved",
    "escalated",
]


class TicketCreate(BaseModel):
    reporter: str = Field(min_length=1, max_length=256)
    # Looser-than-EmailStr regex so demo personas at @acme.test work
    # (Python's email-validator rejects .test as a reserved TLD).
    reporter_email: str = Field(
        alias="reporterEmail",
        pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$",
        max_length=256,
    )
    subject: str = Field(min_length=1, max_length=512)
    body: str = Field(min_length=1, max_length=8192)
    channel: Literal["slack", "email", "portal"] = "slack"

    model_config = {"populate_by_name": True}


class Citation(BaseModel):
    source: Literal["runbook", "user_context"] = "runbook"
    runbook_id: str | None = None
    snippet: str
    score: float = 0.0


class TicketRead(BaseModel):
    id: str
    reporter: str
    reporter_email: str
    subject: str
    body: str
    channel: str
    status: TicketStatus
    plan: list[dict] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    exec_log: list[dict] = Field(default_factory=list)
    confidence: float = 0.0
    resolved_by_ai: bool = False
    runbook_source_id: str | None = None
    resolution_time_ms: int | None = None
    created_at: datetime
    updated_at: datetime


class ConfirmRequest(BaseModel):
    resolved: bool
    note: str | None = None
