import { describe, it, expect } from "vitest";
import type { PlanStep } from "./types";

// buildGraph() calls .compile() at module import time, so importing this module
// is itself the assertion: LangGraph validates that every Command({goto}) target
// is declared in the node's `ends` and that no node is unreachable. A typo in an
// `ends` array fails here rather than halfway through a live ticket.
describe("ticket graph wiring", () => {
  it("is the thirteen nodes the two loops actually need, and nothing else", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const nodes = Object.keys((await ticketGraph.getGraphAsync()).nodes)
      .filter((n) => n !== "__start__" && n !== "__end__")
      .sort();

    expect(nodes).toEqual(
      [
        "awaitApproval",
        // The ladder's pause. Two nodes for the same reason the approval gate is
        // two: on resume LangGraph re-runs the node from the top, so the message
        // has to live before the interrupt, in its own node.
        "askEmployeeToVerify",
        "awaitEmployeeVerdict",
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
      // The ladder ran out of candidates and the employee still has the problem.
      // That is a diagnosis problem, so it costs a look — but only then. A "still
      // broken" with candidates left never reaches here.
      "awaitEmployeeVerdict",
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
    // approval, the resumed ladder check, and the executor's own self-loop.
    // Every one of those has already been through reviewSteps.
    const intoExec = graph.edges.filter((e) => e.target === "runNextStep").map((e) => e.source).sort();
    expect(intoExec).toEqual([
      "awaitApproval",
      "awaitEmployeeVerdict",
      "reviewSteps",
      "runNextStep",
    ]);

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

describe("reopening a ticket the employee sent back", () => {
  it("gives them one more look and no more", async () => {
    const { MAX_REOPENS } = await import("./ticket-graph");

    // One. A fix that did not work earns a second look with the employee's own
    // account of what is still happening — that is new evidence. A second
    // failure is not a third round; it means this system has the wrong model of
    // the problem, and more rounds of the same conversation only cost opus
    // calls and the employee's afternoon.
    expect(MAX_REOPENS).toBe(1);
  });

  it("hands a ticket past that bound to a person", async () => {
    const { ticketGraph } = await import("./ticket-graph");
    const graph = await ticketGraph.getGraphAsync();

    // The overflow check sits at the top of the strategist, before the
    // expensive call. Without this edge the bound would have nowhere to send a
    // ticket and the reopen path would be an unbounded loop.
    const outOfStrategist = graph.edges.filter((e) => e.source === "strategist").map((e) => e.target);
    expect(outOfStrategist).toContain("humanHandoff");
  });
});

describe("what the employee is left with at the end", () => {
  it("no longer posts a bare yes/no question under the resolution message", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./ticket-graph.ts", import.meta.url), "utf8");
    // Comments stripped: the comment where finalize explains why this line was
    // deleted quotes the line, and a guard that fires on its own explanation is
    // a guard nobody keeps.
    const code = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

    // This line used to go out as its own message directly beneath the
    // resolution text, which is what made every ticket end on a half-answer
    // followed by a form question. EmployeePortal already renders Yes/No
    // buttons for the same decision; the desk's `resolution` moment asks for
    // the one specific observation that would settle it.
    expect(code).not.toMatch(/Is the issue resolved\?/);
    expect(code).not.toMatch(/Reply \*yes\* or \*no\*/);
  });
});

// A step still sitting `pending` is filtered out of `buildReplyEvidence`, so the
// operator planning a fresh round cannot see it. Handing back the moment one
// step fails therefore asks it to plan against a round it can only half see, and
// it proposes the outstanding checks a second time — the employee reads the same
// proxy check and the same HTTPS test twice on one ticket.
describe("what happens to the rest of the round when one step fails", () => {
  it("finishes the steps already queued before the operator plans again", async () => {
    const { shouldDrainRound } = await import("./ticket-graph");
    expect(shouldDrainRound("execution", true)).toBe(true);
    expect(shouldDrainRound("no_effect", true)).toBe(true);
    expect(shouldDrainRound("conflicting_evidence", true)).toBe(true);
  });

  it("hands back immediately when the round is already empty", async () => {
    const { shouldDrainRound } = await import("./ticket-graph");
    expect(shouldDrainRound("execution", false)).toBe(false);
    expect(shouldDrainRound("no_effect", false)).toBe(false);
  });

  // Draining is only worth it when the remaining steps can still produce an
  // answer. A dead agent or a dead provider gives the same failure four more
  // times, one job timeout apiece, and the operator waits the whole time.
  it("does not drain when the failure took the execution surface with it", async () => {
    const { shouldDrainRound } = await import("./ticket-graph");
    expect(shouldDrainRound("timeout", true)).toBe(false);
    expect(shouldDrainRound("dependency_unavailable", true)).toBe(false);
  });
});

// The rule that makes this a ladder instead of a batch. It used to be that every
// authorised fix ran back to back, so a ticket a restart would have settled also
// had its application cache cleared — and afterwards nothing on the ticket could
// say which of the two had worked.
describe("one change at a time", () => {
  const fix = (id: string): PlanStep => ({
    id,
    kind: "device",
    description: id,
    capability: "fix.restart_app",
    status: "pending",
  });
  const read = (id: string): PlanStep => ({
    id,
    kind: "device",
    description: id,
    capability: "diag.app_status",
    status: "pending",
  });

  it("will not start a second fix while the first is unverified", async () => {
    const { nextRungAction } = await import("./ticket-graph");
    expect(nextRungAction(fix("b"), true)).toBe("verify");
  });

  it("runs the next fix freely when nothing is waiting on the employee", async () => {
    const { nextRungAction } = await import("./ticket-graph");
    expect(nextRungAction(fix("a"), false)).toBe("run");
  });

  it("still runs reads while a fix is unverified — they are free and they are the evidence", async () => {
    const { nextRungAction } = await import("./ticket-graph");
    expect(nextRungAction(read("r"), true)).toBe("run");
    expect(nextRungAction(read("r"), false)).toBe("run");
  });

  it("asks the employee at the end of a round in which a fix landed", async () => {
    const { nextRungAction } = await import("./ticket-graph");
    expect(nextRungAction(undefined, true)).toBe("verify");
  });

  it("hands back normally when the round ends with nothing unverified", async () => {
    const { nextRungAction } = await import("./ticket-graph");
    expect(nextRungAction(undefined, false)).toBe("handBack");
  });
});

// Climbing a rung is not the employee reopening a finished ticket, and it must
// not be charged as one: the reopen bound exists to stop a third round of the
// same conversation, while "still broken" halfway up a ladder is the ladder
// working exactly as designed.
describe("what climbing the ladder costs", () => {
  it("answers a paused check by resuming the run, never by reopening it", async () => {
    const code = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./ticket-graph.ts", import.meta.url), "utf8"),
    );
    const body = code.slice(code.indexOf("export async function answerRungVerdict"));
    // A resume carries the whole run — the queued candidates, the diagnosis, the
    // evidence. A reopen would re-observe the machine and spend an opus look to
    // arrive back at a fix that was already authorised and already queued.
    expect(body).toMatch(/Command\(\{ resume: answer \}\)/);
    expect(body.slice(0, body.indexOf("\n}"))).not.toMatch(/reopens/);
  });
});

// Asking "what fixes this symptom" before authorising a ladder is now the
// recommended opening move. Charging it a strategist look quietly punished the
// tickets that followed the advice, leaving them two looks instead of three.
describe("what a research round costs", () => {
  it("does not spend a strategist look", async () => {
    const code = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./ticket-graph.ts", import.meta.url), "utf8"),
    );
    const researcher = code.slice(
      code.indexOf("async function researcher"),
      code.indexOf("async function strategist"),
    );
    expect(researcher).toContain("researchRounds: state.researchRounds + 1");
    expect(researcher).not.toContain("strategyRound: state.strategyRound + 1");
  });

  it("is still bounded, so free does not mean unlimited", async () => {
    const { MAX_RESEARCH_ROUNDS } = await import("./research");
    // The bound that replaced the look budget. Worst case is
    // MAX_STRATEGY_ROUNDS + MAX_RESEARCH_ROUNDS opus calls, not an open loop.
    expect(MAX_RESEARCH_ROUNDS).toBe(2);

    const code = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./ticket-graph.ts", import.meta.url), "utf8"),
    );
    expect(code).toContain("state.researchRounds < MAX_RESEARCH_ROUNDS");
  });
});
