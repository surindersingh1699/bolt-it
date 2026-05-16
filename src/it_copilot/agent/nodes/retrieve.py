from it_copilot.agent.state import GraphState
from it_copilot.audit import write_audit
from it_copilot.rag.retriever import get_retriever


async def retrieve(state: GraphState) -> GraphState:
    retriever = await get_retriever(k=4)
    query = f"{state['subject']}. {state['body']}"
    hits = await retriever.aretrieve(query)
    citations = [
        {
            "source": "runbook",
            "runbook_id": h.runbook_id,
            "snippet": h.snippet[:400],
            "score": h.score,
        }
        for h in hits
    ]
    await write_audit(
        ticket_id=state["ticket_id"],
        actor="agent.retrieve",
        action="retrieve",
        payload={"query": query[:512], "hits": [{"id": h.runbook_id, "score": h.score} for h in hits]},
    )
    return {"citations": citations}
