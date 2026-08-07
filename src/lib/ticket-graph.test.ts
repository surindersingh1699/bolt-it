import { describe, it, expect } from "vitest";

// buildGraph() calls .compile() at module import time, so importing this module
// is itself the assertion: LangGraph validates that every Command({goto}) target
// is declared in the node's `ends` and that no node is unreachable. A typo in an
// `ends` array fails here rather than halfway through a live ticket.
describe("ticket graph wiring", () => {
  it("is the eleven nodes the two loops actually need, and nothing else", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const nodes = Object.keys((await ticketGraph.getGraphAsync()).nodes)
      .filter((n) => n !== "__start__" && n !== "__end__")
      .sort();

    expect(nodes).toEqual(
      [
        "awaitApproval",
        "finalize",
        "humanHandoff",
        "intentValidator",
        "markAwaitingApproval",
        "observe",
        "operator",
        "researcher",
        "reviewSteps",
        "runNextStep",
        "strategist",
      ].sort(),
    );
  });

  it("has no tier machinery left anywhere", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const nodes = Object.keys((await ticketGraph.getGraphAsync()).nodes);
    for (const gone of [
      "draftPlan",
      "classifyRisk",
      "tierGate",
      "escalateTier",
      "verifyOutcome",
      "replan",
      "persistPlan",
      "contextReady",
      "gatherProfile",
      "gatherMemory",
      "gatherIncidentHistory",
      "gatherDeviceContext",
    ]) {
      expect(nodes, gone).not.toContain(gone);
    }
  });

  it("reads the machine before anything is diagnosed", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const graph = await ticketGraph.getGraphAsync();

    // One context branch, so there is no barrier join left to deadlock on —
    // which is what lets both loops re-enter their own node freely.
    const intoStrategist = graph.edges
      .filter((e) => e.target === "strategist" && !e.conditional)
      .map((e) => e.source);
    expect(intoStrategist).toEqual(["observe"]);
    expect(graph.edges.filter((e) => e.target === "observe").map((e) => e.source)).toEqual(["__start__"]);
  });

  it("keeps the cheap loop cheap: execution returns to the operator, not the strategist", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const graph = await ticketGraph.getGraphAsync();

    // The whole cost argument. If finished steps went straight back to the
    // strategist, every mechanical retry would cost an opus call.
    const intoOperator = graph.edges.filter((e) => e.target === "operator").map((e) => e.source).sort();
    expect(intoOperator).toEqual(["runNextStep", "strategist"]);
  });

  it("calls the expensive model only from the places that need a diagnosis", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const graph = await ticketGraph.getGraphAsync();

    const intoStrategist = graph.edges.filter((e) => e.target === "strategist").map((e) => e.source).sort();
    expect(intoStrategist).toEqual([
      // Its own retry, when it claimed a resolution the evidence did not support.
      "observe",
      "operator",
      "researcher",
      "runNextStep",
      "strategist",
    ]);
  });

  it("keeps the approval interrupt on the only path to execution", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const graph = await ticketGraph.getGraphAsync();
    const nodes = Object.keys(graph.nodes);

    // markAwaitingApproval is separate from awaitApproval on purpose: on resume,
    // LangGraph re-runs the whole node from the top, so anything before
    // interrupt() would fire a second time.
    expect(nodes).toContain("markAwaitingApproval");
    expect(nodes).toContain("awaitApproval");

    // Nothing reaches the executor except the reviewer's output, the resumed
    // approval, and the executor's own self-loop.
    const intoExec = graph.edges.filter((e) => e.target === "runNextStep").map((e) => e.source).sort();
    expect(intoExec).toEqual(["awaitApproval", "reviewSteps", "runNextStep"]);

    // And nothing reaches the reviewer except the intent validator: the plan is
    // weighed as a whole before any step is weighed on its own, and the operator
    // has no way to skip that stage.
    const intoReview = graph.edges.filter((e) => e.target === "reviewSteps").map((e) => e.source);
    expect(intoReview).toEqual(["intentValidator"]);

    // ...and nothing reaches the intent validator except the operator, so the
    // full path to execution is operator → intent → reviewer → gate → executor.
    const intoIntent = graph.edges.filter((e) => e.target === "intentValidator").map((e) => e.source);
    expect(intoIntent).toEqual(["operator"]);
  });

  it("sends a refused plan to a person, not back to the planner for another try", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const graph = await ticketGraph.getGraphAsync();

    // A plan that reached for credential material is not a planning mistake to
    // be retried with better wording. The only two exits are "carry on to the
    // reviewer" and "a human looks at this".
    const outOfIntent = graph.edges
      .filter((e) => e.source === "intentValidator")
      .map((e) => e.target)
      .sort();
    expect(outOfIntent).toEqual(["humanHandoff", "reviewSteps"]);
  });

  it("terminates at a human handoff rather than a resolved-looking finalize", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const nodes = Object.keys((await ticketGraph.getGraphAsync()).nodes);

    // The handoff is a distinct terminal node, not a branch of finalize:
    // finalize marks awaiting_confirmation, which would tell the employee the
    // problem was solved when nobody solved it.
    expect(nodes).toContain("humanHandoff");
    expect(nodes).toContain("finalize");
  });
});
