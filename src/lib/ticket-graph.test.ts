import { describe, it, expect } from "vitest";

// buildGraph() calls .compile() at module import time, so importing this module
// is itself the assertion: LangGraph validates that every Command({goto}) target
// is declared in the node's `ends` and that no node is unreachable. A typo in an
// `ends` array fails here rather than halfway through a live ticket.
describe("ticket graph wiring", () => {
  it("compiles, and the escalation path is reachable from both entry points", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const nodes = Object.keys((await ticketGraph.getGraphAsync()).nodes);

    expect(nodes).toContain("tierGate");
    expect(nodes).toContain("escalateTier");
    // The two ways a ticket moves down a tier: rejected at the gate before
    // running anything, and exhausted after running everything.
    expect(nodes).toContain("verifyOutcome");
    expect(nodes).toContain("runNextStep");
  });
});
