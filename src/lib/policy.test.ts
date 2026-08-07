import { describe, expect, it } from "vitest";
import { PolicyInput, ReviewScore, decide, policyLogLine } from "./policy";
import { CapabilitySpec, capabilitySpec } from "./capabilities";
import type { ExecutionMode } from "./autonomy";

const CLEAN: ReviewScore = {
  risk: "low",
  rollbackAvailable: true,
  verificationAvailable: true,
  leastPrivilege: true,
  blastRadius: "low",
  requiresHuman: false,
  reasoning: ["reversible and confined to the reporter's own machine"],
};

const ASKS: ReviewScore = { ...CLEAN, requiresHuman: true, reasoning: ["touches the network link"] };

function input(over: Partial<PolicyInput> = {}): PolicyInput {
  return {
    spec: capabilitySpec("fix.restart_app"),
    kind: "device",
    score: CLEAN,
    refusal: null,
    floor: null,
    intent: "clear",
    intentUnexplained: false,
    mode: "gated",
    ...over,
  };
}

const MODES: ExecutionMode[] = ["simulation", "shadow", "limited", "gated", "full"];

/** A lease, for the provenance rules. */
function lease(over: Partial<CapabilitySpec> = {}): CapabilitySpec {
  return {
    ...capabilitySpec("fix.restart_app")!,
    id: "fix.leased_thing",
    provenance: {
      source: "temporary",
      version: "0.1",
      author: "strategist",
      approvedBy: "Dana",
      createdAt: "2026-08-01",
      expiresAt: "2026-08-08",
    },
    ...over,
  };
}

describe("refusals come first", () => {
  for (const mode of MODES) {
    it(`refuses a blocked step on ${mode}`, () => {
      expect(decide(input({ refusal: "block", mode })).decision).toBe("refuse");
    });
    it(`refuses a plan the intent validator rejected on ${mode}`, () => {
      expect(decide(input({ intent: "refuse", mode })).decision).toBe("refuse");
    });
    it(`refuses an unknown capability on ${mode}`, () => {
      expect(decide(input({ spec: undefined, mode })).decision).toBe("refuse");
    });
  }

  it("records that full autonomy was refused a bypass for block", () => {
    const o = decide(input({ refusal: "block", mode: "full" }));
    expect(o.bypassRefused).toBe(true);
    expect(policyLogLine(o)).toContain("could not bypass");
  });
});

describe("reply steps", () => {
  it("always run — no capability, nothing outside the thread", () => {
    for (const mode of MODES) {
      expect(decide(input({ kind: "reply", spec: undefined, score: null, mode })).decision).toBe("auto");
    }
  });
});

describe("structural floors under full autonomy", () => {
  it("bypasses risk-3 capability for a person on full mode", () => {
    const o = decide(input({ spec: capabilitySpec("ad.reset_password"), kind: "backend", mode: "full" }));
    expect(o.decision).toBe("auto");
    expect(o.rule).toBe("autonomy-bypass");
  });

  it("bypasses an irreversible elevated change under full mode", () => {
    const spec = { ...capabilitySpec("fix.set_dns_servers")!, reversible: "none" as const };
    const o = decide(input({ spec, mode: "full" }));
    expect(o.decision).toBe("auto");
    expect(o.rule).toBe("autonomy-bypass");
  });

  it("bypasses unexplained intent under full mode", () => {
    const o = decide(input({ intentUnexplained: true, mode: "full" }));
    expect(o.decision).toBe("auto");
    expect(o.rule).toBe("autonomy-bypass");
  });
});

describe("provenance", () => {
  it("refuses a lease that has expired", () => {
    const o = decide(input({ spec: lease(), now: Date.parse("2026-08-09") }));
    expect(o.decision).toBe("refuse");
    expect(o.rule).toBe("lease-expired");
  });

  it("allows a lease that has not", () => {
    expect(decide(input({ spec: lease(), now: Date.parse("2026-08-07") })).decision).toBe("auto");
  });

  it("refuses a lease carrying more than risk 1, however long it has left", () => {
    const o = decide(input({ spec: lease({ risk: 2 }), now: Date.parse("2026-08-01") }));
    expect(o.decision).toBe("refuse");
    expect(o.rule).toBe("lease-over-risk");
  });

  it("refuses an over-risk lease on full autonomy too", () => {
    const o = decide(input({ spec: lease({ risk: 2 }), mode: "full", now: Date.parse("2026-08-01") }));
    expect(o.decision).toBe("refuse");
    expect(o.bypassRefused).toBe(true);
  });

  it("does not apply expiry rules to built-in capabilities", () => {
    expect(decide(input({ now: Date.parse("2099-01-01") })).decision).toBe("auto");
  });
});

describe("an unreachable reviewer", () => {
  it("holds a change for a person in gated mode", () => {
    const o = decide(input({ score: null, mode: "gated" }));
    expect(o.decision).toBe("human");
    expect(o.rule).toBe("reviewer-unavailable");
  });

  it("holds a read for a person in gated mode", () => {
    const o = decide(input({ spec: capabilitySpec("diag.process_list"), score: null, mode: "gated" }));
    expect(o.decision).toBe("human");
  });

  it("lets full autonomy auto-approve when reviewer is unavailable", () => {
    const o = decide(input({ spec: capabilitySpec("diag.process_list"), score: null, mode: "full" }));
    expect(o.decision).toBe("auto");
    expect(o.rule).toBe("autonomy-bypass");
  });
});

describe("the rungs", () => {
  it("gated: honours the reviewer's request for a person", () => {
    expect(decide(input({ score: ASKS, mode: "gated" })).decision).toBe("human");
  });

  it("full: bypasses a reviewer's request for a person", () => {
    const o = decide(input({ score: ASKS, mode: "full" }));
    expect(o.decision).toBe("auto");
    expect(o.rule).toBe("autonomy-bypass");
  });

  it("full: still bypasses the cross-account floor, as it did before", () => {
    expect(decide(input({ floor: "cross_account", mode: "full" })).decision).toBe("auto");
    expect(decide(input({ floor: "cross_account", mode: "gated" })).decision).toBe("human");
  });

  it("limited: runs risk 0 and 1 unattended", () => {
    expect(decide(input({ spec: capabilitySpec("diag.process_list"), mode: "limited" })).decision).toBe("auto");
    expect(decide(input({ spec: capabilitySpec("fix.restart_app"), mode: "limited" })).decision).toBe("auto");
  });

  it("limited: holds risk 2 for a person even when the reviewer cleared it", () => {
    const o = decide(input({ spec: capabilitySpec("fix.set_dns_servers"), mode: "limited" }));
    expect(o.decision).toBe("human");
    expect(o.rule).toBe("over-mode-risk-cap");
  });

  it("simulation and shadow: nothing waits, because nothing is sent", () => {
    for (const mode of ["simulation", "shadow"] as const) {
      const o = decide(input({ score: ASKS, mode }));
      expect(o.decision, mode).toBe("auto");
      expect(o.rule).toBe("dry-run");
      // The reason the reviewer gave still rides along, so the artifact records
      // what this would have been gated on.
      expect(o.reason).toContain("network link");
    }
  });

  it("simulation and shadow: a refused step is still refused", () => {
    // Otherwise a dry run would show a clean plan that the real run would stop.
    for (const mode of ["simulation", "shadow"] as const) {
      expect(decide(input({ refusal: "block", mode })).decision, mode).toBe("refuse");
    }
  });
});

describe("the ordinary path", () => {
  it("clears a reviewed, reversible, in-scope change", () => {
    const o = decide(input());
    expect(o.decision).toBe("auto");
    expect(o.rule).toBe("cleared");
  });

  it("holds a plan-level concern even when this step looks fine alone", () => {
    expect(decide(input({ intent: "human" })).decision).toBe("human");
  });

  it("is a pure function of its inputs", () => {
    const a = input({ mode: "gated" });
    expect(decide(a)).toEqual(decide(a));
  });
});
