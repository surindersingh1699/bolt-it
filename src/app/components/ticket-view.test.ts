import { describe, it, expect } from "vitest";
import { PlanStep, Ticket } from "@/lib/types";
import { summarizeAgentMetrics } from "./ticket-view";

// These numbers get quoted in conversations about whether the agent is working,
// so the arithmetic is pinned rather than eyeballed in the browser.

const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  id: "s-1",
  kind: "device",
  description: "Check whether Excel is responding",
  capability: "diag.app_status",
  status: "succeeded",
  ...over,
});

const ticket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "t-1",
  workspaceId: "acme.test",
  customerOrg: "Acme",
  channel: "slack",
  reporter: "Dana Reed",
  reporterEmail: "dana@acme.test",
  subject: "Excel keeps freezing",
  body: "It hangs when I open the budget file.",
  status: "resolved",
  createdAt: 0,
  updatedAt: 0,
  plan: [],
  citations: [],
  confidence: 0,
  resolvedByAi: true,
  ...over,
});

describe("summarizeAgentMetrics", () => {
  it("counts awaiting_confirmation as finished without a person", () => {
    // No technician touched it. Counting only `resolved` would understate
    // autonomy by every ticket still waiting on the employee to reply.
    const m = summarizeAgentMetrics([
      ticket({ status: "resolved" }),
      ticket({ id: "t-2", status: "awaiting_confirmation" }),
      ticket({ id: "t-3", status: "escalated" }),
    ]);
    expect(m.autonomous).toBe(2);
    expect(m.escalated).toBe(1);
  });

  it("buckets tickets by how many diagnostic looks they needed", () => {
    const m = summarizeAgentMetrics([
      ticket({ attempts: 2 }),
      ticket({ id: "t-2", attempts: 1 }),
      ticket({ id: "t-3" }),
    ]);
    expect(m.byLooks[2]).toBe(1);
    // A ticket with no recorded attempts has had exactly one look.
    expect(m.byLooks[1]).toBe(2);
    expect(m.multiLook).toBe(1);
  });

  it("counts failures by kind, ordered by how often they happen", () => {
    const m = summarizeAgentMetrics([
      ticket({
        plan: [
          step({ id: "a", status: "failed", failure: { kind: "no_effect", detail: "unchanged" } }),
          step({ id: "b", status: "failed", failure: { kind: "no_effect", detail: "unchanged" } }),
          step({ id: "c", status: "failed", failure: { kind: "timeout", detail: "offline" } }),
        ],
      }),
    ]);
    expect(m.failures[0]).toEqual(["no_effect", 2]);
    expect(m.failureTotal).toBe(3);
  });

  it("counts only the refusing verdicts as refusals", () => {
    // A timeout is not the gate refusing anything, and lumping it in would make
    // the safety gate look far busier than it is.
    const m = summarizeAgentMetrics([
      ticket({
        plan: [
          step({ id: "a", status: "failed", failure: { kind: "policy_block", detail: "unrelated" } }),
          step({ id: "b", status: "failed", failure: { kind: "unsupported_assumption", detail: "assumed" } }),
          step({ id: "c", status: "failed", failure: { kind: "timeout", detail: "offline" } }),
        ],
      }),
    ]);
    expect(m.refused).toBe(2);
    expect(m.steps).toBe(3);
  });

  it("averages tokens only over tickets that actually made a call", () => {
    // Dividing by every ticket would halve the figure the moment a ticket is
    // served entirely from the in-memory fallback path.
    const m = summarizeAgentMetrics([
      ticket({
        usage: {
          calls: 2,
          failedCalls: 0,
          promptTokens: 800,
          completionTokens: 200,
          totalTokens: 1000,
          modelMs: 500,
          byModel: {},
          byCall: { draft: { calls: 1, totalTokens: 600, modelMs: 300 } },
        },
      }),
      ticket({ id: "t-2" }),
    ]);
    expect(m.ticketsWithUsage).toBe(1);
    expect(m.tokens).toBe(1000);
    expect(m.byCall).toEqual([["draft", 600]]);
  });

  it("returns zeroes rather than NaN for an empty workspace", () => {
    const m = summarizeAgentMetrics([]);
    expect(m.total).toBe(0);
    expect(m.tokens).toBe(0);
    expect(m.failures).toEqual([]);
  });
});
