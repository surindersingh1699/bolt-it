"""LangGraph state machine.

Flow:
    intake → retrieve → plan → policy → [interrupt: await approval] →
        execute → [interrupt: await user confirm] → confirm → learn → END

Two structural interrupts:
- before `execute`: technician approval (POST /tickets/{id}/approve)
- before `confirm`: user reply (POST /tickets/{id}/confirm with resolved=true|false)
"""

from langgraph.graph import END, START, StateGraph

from it_copilot.agent.checkpointer import init_checkpointer
from it_copilot.agent.nodes.confirm import confirm
from it_copilot.agent.nodes.execute import execute
from it_copilot.agent.nodes.intake import intake
from it_copilot.agent.nodes.learn import learn
from it_copilot.agent.nodes.plan_node import plan_node
from it_copilot.agent.nodes.policy_node import policy_node
from it_copilot.agent.nodes.retrieve import retrieve
from it_copilot.agent.state import GraphState
from it_copilot.tools._registry import load_all_tools


def _build_graph_definition() -> StateGraph:
    g = StateGraph(GraphState)
    g.add_node("intake", intake)
    g.add_node("retrieve", retrieve)
    g.add_node("plan", plan_node)
    g.add_node("policy", policy_node)
    g.add_node("execute", execute)
    g.add_node("confirm", confirm)
    g.add_node("learn", learn)

    g.add_edge(START, "intake")
    g.add_edge("intake", "retrieve")
    g.add_edge("retrieve", "plan")
    g.add_edge("plan", "policy")
    g.add_edge("policy", "execute")
    g.add_edge("execute", "confirm")
    g.add_edge("confirm", "learn")
    g.add_edge("learn", END)
    return g


_compiled = None


async def get_graph():
    global _compiled
    if _compiled is None:
        load_all_tools()
        checkpointer = await init_checkpointer()
        _compiled = _build_graph_definition().compile(
            checkpointer=checkpointer,
            interrupt_before=["execute", "confirm"],
        )
    return _compiled
