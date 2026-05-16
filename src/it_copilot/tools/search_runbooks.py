from typing import Any

from it_copilot.rag.retriever import get_retriever
from it_copilot.schemas.plan import SearchRunbooksParams
from it_copilot.tools._registry import ToolEntry, ToolResult, register


async def run(params: SearchRunbooksParams, ctx: dict[str, Any]) -> ToolResult:
    retriever = await get_retriever(k=params.k)
    hits = await retriever.aretrieve(params.query)
    log = [f"[search.runbooks] q='{params.query}' -> {len(hits)} hits"]
    for h in hits:
        log.append(f"[search.runbooks]   {h.runbook_id} (score={h.score:.2f}) {h.title}")
    return ToolResult(
        ok=True,
        log=log,
        data={
            "hits": [
                {"runbook_id": h.runbook_id, "title": h.title, "score": h.score, "snippet": h.snippet}
                for h in hits
            ]
        },
    )


register(ToolEntry(
    capability="search.runbooks",
    risk="low",
    params_schema=SearchRunbooksParams,
    run=run,
    description="Search the runbook corpus via hybrid BM25 + dense retrieval. Use to refine plans.",
))
