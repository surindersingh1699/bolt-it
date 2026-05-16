"""Idempotency-Key store.

24h window on write endpoints. Phase 1 backs it with Postgres; Phase 2
moves it to Upstash Redis for sub-ms reads. The interface is the same.
"""

from datetime import timedelta

from sqlalchemy import select

from it_copilot.db.models import IdempotencyKey
from it_copilot.db.session import session_scope


class IdempotencyHit:
    def __init__(self, status: int, body: dict | None) -> None:
        self.status = status
        self.body = body


async def get_cached(key: str) -> IdempotencyHit | None:
    async with session_scope() as db:
        row = (await db.execute(select(IdempotencyKey).where(IdempotencyKey.key == key))).scalar_one_or_none()
    if not row:
        return None
    return IdempotencyHit(status=row.response_status or 200, body=row.response_body)


async def store(key: str, request_path: str, status: int, body: dict | None) -> None:
    async with session_scope() as db:
        existing = (await db.execute(select(IdempotencyKey).where(IdempotencyKey.key == key))).scalar_one_or_none()
        if existing is None:
            db.add(IdempotencyKey(
                key=key,
                request_path=request_path,
                response_status=status,
                response_body=body,
            ))
