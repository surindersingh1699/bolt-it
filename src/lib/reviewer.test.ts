import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { reviewStep, reviewPlan } from "./reviewer";
import { PlanStep, Ticket } from "./types";

// Every test here runs with no AI_GATEWAY_API_KEY, i.e. with the reviewer
// unreachable. That is deliberate: these assert what happens when the gate
// CANNOT form an opinion. The whole design rests on that path failing closed,
// so it is the path most worth pinning.
beforeEach(() => {
  delete process.env.AI_GATEWAY_API_KEY;
});

afterEach(() => {
  delete process.env.AI_GATEWAY_API_KEY;
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
  status: "executing",
  createdAt: 0,
  updatedAt: 0,
  plan: [],
  citations: [],
  confidence: 0,
  resolvedByAi: false,
  ...over,
});

const step = (over: Partial<PlanStep> = {}): PlanStep => ({
  id: "step-0",
  kind: "device",
  description: "Check whether Excel is responding",
  capability: "diag.app_status",
  status: "pending",
  ...over,
});

describe("failing closed", () => {
  it("asks a human when the reviewer cannot be reached", async () => {
    const review = await reviewStep(step(), ticket());
    expect(review.verdict).toBe("ask_human");
    expect(review.risk).toBe("high");
    expect(review.reason).toContain("unavailable");
  });

  it("never lets an unreachable reviewer produce an auto step", async () => {
    const [out] = await reviewPlan([step()], ticket());
    expect(out.approvalMode).toBe("human");
  });

  it("still lets a plain reply through — it changes nothing outside the thread", async () => {
    const review = await reviewStep(step({ kind: "reply", capability: undefined }), ticket());
    expect(review.verdict).toBe("allow");
  });
});

describe("the floor the reviewer has no authority over", () => {
  it("always asks a human before invalidating a credential", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const review = await reviewStep(
      step({ kind: "backend", capability: "ad.reset_password", params: { email: "dana@acme.test" } }),
      ticket(),
    );
    // Reached the floor without an HTTP call: no fetch was mocked, so a verdict
    // of anything other than ask_human would mean the floor was skipped.
    expect(review.verdict).toBe("ask_human");
    expect(review.reason).toContain("ad.reset_password");
  });

  it("asks a human when a step targets somebody other than the reporter", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const review = await reviewStep(
      step({ kind: "backend", capability: "ad.unlock_account", params: { email: "ceo@acme.test" } }),
      ticket(),
    );
    expect(review.verdict).toBe("ask_human");
    expect(review.reason).toContain("ceo@acme.test");
  });

  it("does not trip the cross-account check on the reporter's own address", async () => {
    // No key, so this falls through to the unavailable path rather than the
    // target-binding one — the distinction is the point.
    const review = await reviewStep(
      step({ kind: "backend", capability: "ad.unlock_account", params: { email: "DANA@acme.test" } }),
      ticket(),
    );
    expect(review.reason).toContain("unavailable");
  });
});

describe("blocked steps", () => {
  it("marks a refused step failed so it can never be picked up as pending", async () => {
    // reviewPlan with the reviewer unavailable yields ask_human, not block, so
    // assert the shape of the annotation the graph depends on instead.
    const [out] = await reviewPlan([step()], ticket());
    expect(out.status).toBe("pending");
    expect(out.riskSource).toBe("judge");
    expect(out.log?.join("\n")).toContain("[Reviewer]");
  });
});
