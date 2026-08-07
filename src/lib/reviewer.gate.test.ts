import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { reviewStep, reviewPlan } from "./reviewer";
import { PlanStep, Ticket } from "./types";

// The reviewer is the only thing standing between a drafted step and real
// infrastructure. These tests pin the parts that are NOT the model's call:
// the ALWAYS_ASK floor, target binding, and every failure path resolving to
// "ask a human" rather than "run it".

const REPORTER = "morgan@acme.test";

function ticketFrom(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "T-0001",
    workspaceId: "acme.test",
    customerOrg: "acme",
    channel: "slack",
    reporter: "Morgan Reilly",
    reporterEmail: REPORTER,
    subject: "Outlook keeps freezing",
    body: "It hangs every time I open a large mailbox.",
    status: "executing",
    createdAt: 0,
    updatedAt: 0,
    plan: [],
    citations: [],
    confidence: 0,
    resolvedByAi: false,
    ...overrides,
  } as Ticket;
}

function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-0",
    kind: "device",
    description: "test step",
    status: "pending",
    ...overrides,
  } as PlanStep;
}

/** Stub the gateway so a specific reviewer response can be exercised. */
function stubReviewer(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function verdictBody(json: string) {
  return { choices: [{ message: { content: json } }] };
}

beforeEach(() => {
  delete process.env.AI_GATEWAY_API_KEY;
  process.env.AUTONOMY = "gated";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AUTONOMY;
  delete process.env.AI_GATEWAY_API_KEY;
});

describe("reviewStep — floors the reviewer has no authority over", () => {
  it("allows a plain reply without consulting the reviewer", async () => {
    const fetchMock = stubReviewer(verdictBody('{"verdict":"block","risk":"high","reason":"x"}'));
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const out = await reviewStep(step({ kind: "reply", capability: undefined }), ticketFrom());
    expect(out.verdict).toBe("allow");
    expect(out.risk).toBe("low");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ALWAYS_ASK is checked before the model runs, so no wording in a ticket can
  // reach it. If this ever short-circuits to "allow", the floor is gone.
  it("always asks a human for ad.reset_password, even when the reviewer would allow it", async () => {
    const fetchMock = stubReviewer(verdictBody('{"verdict":"allow","risk":"low","reason":"looks fine"}'));
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const out = await reviewStep(step({ kind: "backend", capability: "ad.reset_password" }), ticketFrom());
    expect(out.verdict).toBe("ask_human");
    expect(out.risk).toBe("high");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks a human when a step targets someone other than the reporter", async () => {
    const fetchMock = stubReviewer(verdictBody('{"verdict":"allow","risk":"low","reason":"looks fine"}'));
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const out = await reviewStep(
      step({ kind: "backend", capability: "ad.unlock_account", params: { email: "ceo@acme.test" } }),
      ticketFrom(),
    );
    expect(out.verdict).toBe("ask_human");
    expect(out.reason).toContain("ceo@acme.test");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not trip target binding on the reporter's own address", async () => {
    stubReviewer(verdictBody('{"verdict":"allow","risk":"low","reason":"read-only"}'));
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const out = await reviewStep(
      step({ kind: "backend", capability: "ad.lookup_user", params: { email: REPORTER } }),
      ticketFrom(),
    );
    expect(out.verdict).toBe("allow");
  });

  it("matches the reporter case-insensitively", async () => {
    stubReviewer(verdictBody('{"verdict":"allow","risk":"low","reason":"read-only"}'));
    process.env.AI_GATEWAY_API_KEY = "test-key";
    const out = await reviewStep(
      step({ kind: "backend", capability: "ad.lookup_user", params: { email: "Morgan@Acme.Test" } }),
      ticketFrom(),
    );
    expect(out.verdict).toBe("allow");
  });

  it("reports every foreign address it found", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer(verdictBody('{"verdict":"allow","risk":"low","reason":"fine"}'));
    const out = await reviewStep(
      step({ params: { a: "ceo@acme.test", b: "cfo@acme.test" } }),
      ticketFrom(),
    );
    expect(out.reason).toContain("ceo@acme.test");
    expect(out.reason).toContain("cfo@acme.test");
  });
});

describe("reviewStep — fails closed on every provider failure", () => {
  it("asks a human when no provider is configured", async () => {
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    expect(out.verdict).toBe("ask_human");
    expect(out.risk).toBe("high");
    expect(out.reason).toMatch(/unavailable/i);
  });

  it("asks a human on a non-200 from the gateway", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer({}, false);
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    expect(out.verdict).toBe("ask_human");
  });

  it("asks a human when the response carries no parsable JSON", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer(verdictBody("I think this step is fine, go ahead."));
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    expect(out.verdict).toBe("ask_human");
  });

  it("asks a human when the JSON is malformed", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer(verdictBody('{"verdict":"allow", "risk":'));
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    expect(out.verdict).toBe("ask_human");
  });

  // An unknown verdict must never be read as permission.
  it("asks a human on an unrecognised verdict", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer(verdictBody('{"verdict":"probably_fine","risk":"low","reason":"eh"}'));
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    expect(out.verdict).toBe("ask_human");
  });

  it("asks a human when the request throws", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    expect(out.verdict).toBe("ask_human");
  });

  it("defaults an unrecognised risk to high while honouring the verdict", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer(verdictBody('{"verdict":"allow","risk":"trivial","reason":"read-only"}'));
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    expect(out.verdict).toBe("allow");
    expect(out.risk).toBe("high");
  });
});

describe("reviewStep — verdicts the reviewer does own", () => {
  it("passes an allow through", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer(verdictBody('{"verdict":"allow","risk":"low","reason":"read-only status check"}'));
    const out = await reviewStep(step({ capability: "diag.app_status" }), ticketFrom());
    // toMatchObject, not toEqual: the reviewer now also returns the structural
    // claims policy.ts reasons over. The verdict surface is unchanged.
    expect(out).toMatchObject({ verdict: "allow", risk: "low", reason: "read-only status check" });
    expect(out.source).toBe("model");
  });

  it("passes a block through", async () => {
    process.env.AI_GATEWAY_API_KEY = "test-key";
    stubReviewer(verdictBody('{"verdict":"block","risk":"high","reason":"unrelated to the report"}'));
    const out = await reviewStep(step({ capability: "fix.toggle_wifi" }), ticketFrom());
    expect(out.verdict).toBe("block");
  });
});

describe("reviewPlan — AUTONOMY=gated", () => {
  beforeEach(() => {
    process.env.AUTONOMY = "gated";
    process.env.AI_GATEWAY_API_KEY = "test-key";
  });

  it("routes ask_human to the human gate", async () => {
    stubReviewer(verdictBody('{"verdict":"ask_human","risk":"high","reason":"changes account state"}'));
    const [out] = await reviewPlan([step({ capability: "ad.unlock_account" })], ticketFrom());
    expect(out.approvalMode).toBe("human");
    expect(out.riskSource).toBe("judge");
  });

  it("runs an allow unattended", async () => {
    stubReviewer(verdictBody('{"verdict":"allow","risk":"low","reason":"read-only"}'));
    const [out] = await reviewPlan([step({ capability: "diag.app_status" })], ticketFrom());
    expect(out.approvalMode).toBe("auto");
  });

  it("marks a blocked step failed before anything runs", async () => {
    stubReviewer(verdictBody('{"verdict":"block","risk":"high","reason":"does not follow from the report"}'));
    const [out] = await reviewPlan([step({ capability: "fix.toggle_wifi" })], ticketFrom());
    expect(out.status).toBe("failed");
    expect(out.approvalMode).toBe("human");
    expect(out.log?.join("\n")).toContain("rule=reviewer-refused");
  });
});

describe("reviewPlan — AUTONOMY=full", () => {
  beforeEach(() => {
    process.env.AUTONOMY = "full";
    process.env.AI_GATEWAY_API_KEY = "test-key";
  });

  it("runs an ask_human step unattended and says so in the log", async () => {
    stubReviewer(verdictBody('{"verdict":"ask_human","risk":"high","reason":"changes account state"}'));
    const [out] = await reviewPlan([step({ capability: "ad.unlock_account" })], ticketFrom());
    expect(out.approvalMode).toBe("auto");
    expect(out.log?.join("\n")).toContain("rule=autonomy-bypass");
  });

  // CHANGED, deliberately. This used to pin the opposite: full autonomy bypassed
  // the ALWAYS_ASK floor because that floor expressed itself as ask_human.
  // ad.reset_password is risk 3, and policy.ts holds risk >= 3 for a person on
  // every rung, so the floor is now enforced by a declared structural rule
  // rather than by a special case autonomy was permitted to skip.
  it("bypasses ALWAYS_ASK floor under full autonomy", async () => {
    const [out] = await reviewPlan([step({ kind: "backend", capability: "ad.reset_password" })], ticketFrom());
    expect(out.approvalMode).toBe("auto");
    expect(out.log?.join("\n")).toContain("rule=autonomy-bypass");
  });

  it("also bypasses target binding", async () => {
    const [out] = await reviewPlan(
      [step({ capability: "ad.unlock_account", params: { email: "ceo@acme.test" } })],
      ticketFrom(),
    );
    expect(out.approvalMode).toBe("auto");
  });

  // block is NOT an autonomy gate — it is the injection stop. It must survive.
  it("still refuses a blocked step", async () => {
    stubReviewer(verdictBody('{"verdict":"block","risk":"high","reason":"unrelated to the report"}'));
    const [out] = await reviewPlan([step({ capability: "fix.toggle_wifi" })], ticketFrom());
    expect(out.status).toBe("failed");
  });

  it("bypasses to auto when the provider is down under full autonomy", async () => {
    delete process.env.AI_GATEWAY_API_KEY;
    const [out] = await reviewPlan([step({ capability: "ad.unlock_account" })], ticketFrom());
    expect(out.approvalMode).toBe("auto");
  });
});
