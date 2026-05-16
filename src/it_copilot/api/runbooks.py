from fastapi import APIRouter
from sqlalchemy import select

from it_copilot.db.models import Runbook
from it_copilot.db.session import session_scope

router = APIRouter(prefix="/runbooks", tags=["runbooks"])


@router.get("/")
async def list_runbooks() -> list[dict]:
    async with session_scope() as db:
        rows = (await db.execute(select(Runbook).order_by(Runbook.success_count.desc()))).scalars().all()
    return [
        {
            "id": r.id,
            "title": r.title,
            "tags": r.tags,
            "success_count": r.success_count,
            "failure_count": r.failure_count,
            "auto_synthesized": r.auto_synthesized,
        }
        for r in rows
    ]
