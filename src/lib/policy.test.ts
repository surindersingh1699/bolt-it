import { describe, it, expect, beforeEach } from "vitest";
import { classifyPlan } from "./policy";
import { recordCleanExecution, PROMOTION_THRESHOLD } from "./governance";
import { PlanStep, Ticket } from "./types";

// No AI_GATEWAY_API_KEY in the test env, so the LLM judge is never reached and
// unlisted capabilities take the fallback branch. That is the behaviour under
// test: the fallback must be the SAFE one.
beforeEach(() => {
  delete process.env.AI_GATEWAY_API_KEY;
});

let n = 0;
const ticketIn = (workspaceId: string): Ticket =>
  ({
    id: "T-0001",
    workspaceId,
    customerOrg: "acme",
    channel: "slack",
    reporter: "Bob Martinez",
    reporterEmail: "bob@acme.test",
    subject: "Locked out",
    body: "Cannot log in",
    status: "new",
    createdAt: 0,
    updatedAt: 0,
    plan: [],
    citations: [],
    confidence: 0,
    resolvedByAi: false,
  }) as Ticket;

const step = (capability?: string, kind: PlanStep["kind"] = "backend"): PlanStep => ({
  id: "step-0",
  kind,
  description: "test step",
  capability,
  status: "pending",
});

describe("risk classification", () => {
  it("classifies allowlisted reads as low and runs them without a human", async () => {
    const [out] = await classifyPlan([step("ad.lookup_user")], ticketIn(`ws-${++n}`));
    expect(out.risk).toBe("low");
    expect(out.riskSource).toBe("allowlist");
    expect(out.approvalMode).toBe("auto");
  });

  it("classifies allowlisted identity writes as high and gates them", async () => {
    const [out] = await classifyPlan([step("ad.unlock_account")], ticketIn(`ws-${++n}`));
    expect(out.risk).toBe("high");
    expect(out.approvalMode).toBe("human");
  });

  it("treats slack_reply as low regardless of capability", async () => {
    const [out] = await classifyPlan([step(undefined, "reply")], ticketIn(`ws-${++n}`));
    expect(out.risk).toBe("low");
    expect(out.approvalMode).toBe("auto");
  });

  // The important one: an unknown capability must never slip through as auto.
  it("defaults an unlisted capability to high with a human gate", async () => {
    const [out] = await classifyPlan([step("payroll.wire_funds")], ticketIn(`ws-${++n}`));
    expect(out.risk).toBe("high");
    expect(out.riskSource).toBe("fallback");
    expect(out.approvalMode).toBe("human");
  });

  it("records the decision on the step log for audit", async () => {
    const [out] = await classifyPlan([step("ad.unlock_account")], ticketIn(`ws-${++n}`));
    expect(out.log?.some((l) => l.includes("[Policy]"))).toBe(true);
  });
});

describe("governance interaction", () => {
  it("still gates a high-risk capability with no precedent", async () => {
    const w = `ws-${++n}`;
    const [out] = await classifyPlan([step("ad.unlock_account")], ticketIn(w));
    expect(out.approvalMode).toBe("human");
    expect(out.governancePromoted).toBeUndefined();
  });

  it("auto-runs a high-risk capability once precedent promotes it", async () => {
    const w = `ws-${++n}`;
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanExecution(w, "ad.unlock_account", { name: "Morgan", email: "morgan@acme.test" });
    }
    const [out] = await classifyPlan([step("ad.unlock_account")], ticketIn(w));
    expect(out.risk).toBe("high");
    expect(out.approvalMode).toBe("auto");
    expect(out.governancePromoted).toBe(true);
  });

  it("does not let precedent on one capability promote another", async () => {
    const w = `ws-${++n}`;
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      recordCleanExecution(w, "ad.unlock_account", { name: "Morgan", email: "morgan@acme.test" });
    }
    const [out] = await classifyPlan([step("mdm.push_vpn_config")], ticketIn(w));
    expect(out.approvalMode).toBe("human");
  });
});
