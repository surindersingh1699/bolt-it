"""Ingest runbooks from YAML into Postgres (rows + chunked embeddings)."""

from pathlib import Path

import yaml
from sqlalchemy import delete, select

from it_copilot.db.models import Runbook, RunbookEmbedding, User
from it_copilot.db.session import session_scope
from it_copilot.rag.chunker import chunk_runbook
from it_copilot.rag.embeddings import Embedder
from it_copilot.schemas.runbook import RunbookSeed

SEED_DIR = Path(__file__).resolve().parents[3] / "seed"


def _load_runbook_seeds() -> list[RunbookSeed]:
    raw = yaml.safe_load((SEED_DIR / "runbooks.yaml").read_text())
    return [RunbookSeed(**r) for r in raw]


def _load_user_seeds() -> list[dict]:
    return yaml.safe_load((SEED_DIR / "users.yaml").read_text())


async def seed_runbooks_and_users() -> tuple[int, int]:
    seeds = _load_runbook_seeds()
    users = _load_user_seeds()
    async with session_scope() as db:
        for s in seeds:
            existing = (await db.execute(select(Runbook).where(Runbook.id == s.id))).scalar_one_or_none()
            if existing:
                existing.title = s.title
                existing.body = s.body
                existing.tags = s.tags
                existing.success_count = s.success_count
            else:
                db.add(Runbook(
                    id=s.id,
                    title=s.title,
                    body=s.body,
                    tags=s.tags,
                    success_count=s.success_count,
                ))
        for u in users:
            existing_u = (await db.execute(select(User).where(User.email == u["email"]))).scalar_one_or_none()
            if existing_u:
                existing_u.name = u["name"]
                existing_u.status = u.get("status", "active")
                existing_u.is_it_staff = u.get("is_it_staff", False)
                existing_u.groups = u.get("groups", [])
            else:
                db.add(User(
                    email=u["email"],
                    name=u["name"],
                    status=u.get("status", "active"),
                    is_it_staff=u.get("is_it_staff", False),
                    groups=u.get("groups", []),
                ))
    return len(seeds), len(users)


async def reindex_runbooks() -> int:
    embedder = Embedder()
    async with session_scope() as db:
        runbooks = (await db.execute(select(Runbook))).scalars().all()
        await db.execute(delete(RunbookEmbedding))
        total = 0
        for rb in runbooks:
            chunks = chunk_runbook(rb.title, rb.body)
            vecs = await embedder.embed_documents(chunks)
            for i, (chunk, vec) in enumerate(zip(chunks, vecs, strict=True)):
                db.add(RunbookEmbedding(
                    runbook_id=rb.id,
                    chunk_index=i,
                    content=chunk,
                    embedding=vec,
                ))
                total += 1
    return total
