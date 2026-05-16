"""Hybrid runbook retriever: dense (pgvector cosine) + lexical (BM25) with MMR.

We don't use LangChain's PGVector store directly because the embeddings live in
our own table (with FKs and our chunking strategy). The retrieval surface is
small enough that doing it ourselves is clearer.
"""

from dataclasses import dataclass
from typing import Any

from rank_bm25 import BM25Okapi
from sqlalchemy import select

from it_copilot.db.models import Runbook, RunbookEmbedding
from it_copilot.db.session import session_scope
from it_copilot.rag.embeddings import Embedder


@dataclass(frozen=True)
class Hit:
    runbook_id: str
    title: str
    snippet: str
    score: float


class HybridRunbookRetriever:
    def __init__(self, k: int = 4) -> None:
        self.k = k
        self._embedder = Embedder()

    async def _dense(self, query: str) -> list[tuple[str, str, str, float]]:
        """Return (runbook_id, title, chunk, similarity) by cosine distance."""
        qvec = await self._embedder.embed_query(query)
        async with session_scope() as db:
            stmt = (
                select(
                    RunbookEmbedding.runbook_id,
                    Runbook.title,
                    RunbookEmbedding.content,
                    RunbookEmbedding.embedding.cosine_distance(qvec).label("distance"),
                )
                .join(Runbook, Runbook.id == RunbookEmbedding.runbook_id)
                .order_by("distance")
                .limit(self.k * 4)
            )
            rows = (await db.execute(stmt)).all()
        return [(r.runbook_id, r.title, r.content, 1.0 - float(r.distance)) for r in rows]

    async def _lexical(self, query: str) -> list[tuple[str, str, str, float]]:
        async with session_scope() as db:
            rows = (
                await db.execute(
                    select(RunbookEmbedding.runbook_id, Runbook.title, RunbookEmbedding.content)
                    .join(Runbook, Runbook.id == RunbookEmbedding.runbook_id)
                )
            ).all()
        if not rows:
            return []
        corpus = [r.content.lower().split() for r in rows]
        bm = BM25Okapi(corpus)
        scores = bm.get_scores(query.lower().split())
        ranked = sorted(zip(rows, scores, strict=True), key=lambda x: x[1], reverse=True)[: self.k * 4]
        return [(r.runbook_id, r.title, r.content, float(s)) for r, s in ranked]

    @staticmethod
    def _normalize(items: list[tuple[str, str, str, float]]) -> list[tuple[str, str, str, float]]:
        if not items:
            return []
        scores = [s for _, _, _, s in items]
        lo, hi = min(scores), max(scores)
        rng = (hi - lo) or 1.0
        return [(rb, t, c, (s - lo) / rng) for rb, t, c, s in items]

    async def aretrieve(self, query: str) -> list[Hit]:
        dense = self._normalize(await self._dense(query))
        lexical = self._normalize(await self._lexical(query))
        # Hybrid fuse: 0.6 dense + 0.4 lexical, keyed by (runbook_id, chunk).
        fused: dict[tuple[str, str], dict[str, Any]] = {}
        for rb_id, title, chunk, s in dense:
            fused[(rb_id, chunk)] = {"title": title, "chunk": chunk, "score": 0.6 * s}
        for rb_id, title, chunk, s in lexical:
            key = (rb_id, chunk)
            if key in fused:
                fused[key]["score"] += 0.4 * s
            else:
                fused[key] = {"title": title, "chunk": chunk, "score": 0.4 * s}

        ranked = sorted(fused.items(), key=lambda kv: kv[1]["score"], reverse=True)

        # MMR-lite: dedup by runbook_id, keep best chunk per runbook
        seen: set[str] = set()
        out: list[Hit] = []
        for (rb_id, _chunk), v in ranked:
            if rb_id in seen:
                continue
            seen.add(rb_id)
            out.append(Hit(
                runbook_id=rb_id,
                title=v["title"],
                snippet=v["chunk"],
                score=round(min(1.0, v["score"]), 4),
            ))
            if len(out) >= self.k:
                break
        return out


_singleton: HybridRunbookRetriever | None = None


async def get_retriever(k: int = 4) -> HybridRunbookRetriever:
    global _singleton
    if _singleton is None or _singleton.k != k:
        _singleton = HybridRunbookRetriever(k=k)
    return _singleton
