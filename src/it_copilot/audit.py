"""Append-only audit log writer.

The audit_entries table has DB-level triggers blocking UPDATE and DELETE
(see migration 0001). The app layer cannot weaken this guarantee — even a
compromised process can only insert.
"""

from typing import Any

from it_copilot.db.models import AuditEntry
from it_copilot.db.session import session_scope


async def write_audit(
    *,
    ticket_id: str | None,
    actor: str,
    action: str,
    payload: dict[str, Any] | None = None,
) -> None:
    async with session_scope() as db:
        db.add(AuditEntry(
            ticket_id=ticket_id,
            actor=actor,
            action=action,
            payload=payload or {},
        ))
