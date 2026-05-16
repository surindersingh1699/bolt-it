from typing import Any, TypedDict


class GraphState(TypedDict, total=False):
    ticket_id: str
    reporter: str
    reporter_email: str
    subject: str
    body: str
    citations: list[dict[str, Any]]
    plan: list[dict[str, Any]]
    response: str
    matched_runbook_id: str | None
    confidence: float
    reasoning: str
    exec_log: list[dict[str, Any]]
    status: str
    approved: bool
    user_confirmed: bool | None
    user_confirmation_note: str | None
