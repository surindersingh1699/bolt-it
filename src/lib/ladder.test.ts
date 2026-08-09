import { describe, it, expect } from "vitest";
import { PlanStep } from "./types";
import {
  DEFAULT_LIKELIHOOD,
  isRemediation,
  likelihoodsFrom,
  rankRemediations,
  remediationCost,
  rungsRemaining,
} from "./ladder";

function step(capability: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id: capability,
    kind: capability.startsWith("ad.") ? "backend" : "device",
    description: capability,
    capability,
    status: "pending",
    ...over,
  };
}

const order = (steps: PlanStep[], likelihoods?: Map<string, number>) =>
  rankRemediations(steps, likelihoods).map((s) => s.capability);

describe("what a fix costs to be wrong about", () => {
  it("charges nothing for a read, so looking always comes before changing", () => {
    expect(remediationCost("diag.network_state")).toBe(0);
    expect(remediationCost("fs.read")).toBe(0);
    expect(remediationCost("ad.lookup_user")).toBe(0);
  });

  it("charges an irreversible fix more than a reversible one at the same risk", () => {
    // Both are risk 2 on a device. The difference is that one is recorded with
    // an undo command and the other takes the employee's local state with it.
    expect(remediationCost("fix.set_dns_servers")).toBeLessThan(
      remediationCost("fix.clear_app_cache"),
    );
  });

  it("does not charge a fix for having no probe, because sometimes there is nothing to diff", () => {
    // fix.flush_dns has probe: null on purpose — a flushed cache has no
    // before/after fact and repopulates immediately. Charging that as cost is
    // what a first draft of this file did, and it put the cheapest and most
    // common network fix in the building BEHIND rewriting the resolvers.
    expect(remediationCost("fix.flush_dns")).toBeLessThan(remediationCost("fix.set_dns_servers"));
  });

  it("sends an unknown capability to the back rather than the front", () => {
    // It never executes — capabilityAllowed rejects it upstream. But an unknown
    // cost must never be read as a cheap one.
    expect(remediationCost("fix.not_a_real_capability")).toBe(Number.MAX_SAFE_INTEGER);
    expect(remediationCost(undefined)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("the order fixes are actually attempted in", () => {
  it("restarts the app before it clears the app's cache", () => {
    // The case that motivated the whole thing: both used to run in the same
    // round, so a ticket the restart settled also lost its local app state.
    expect(order([step("fix.clear_app_cache"), step("fix.restart_app")])).toEqual([
      "fix.restart_app",
      "fix.clear_app_cache",
    ]);
  });

  it("flushes the DNS cache before it rewrites the DNS servers", () => {
    expect(order([step("fix.set_dns_servers"), step("fix.flush_dns")])).toEqual([
      "fix.flush_dns",
      "fix.set_dns_servers",
    ]);
  });

  it("runs every read before the first change, whatever order they arrived in", () => {
    const ranked = order([
      step("fix.restart_app"),
      step("diag.app_logs"),
      step("fix.flush_dns"),
      step("diag.app_status"),
    ]);
    expect(ranked.slice(0, 2).sort()).toEqual(["diag.app_logs", "diag.app_status"]);
    expect(ranked.slice(2).every((c) => c!.startsWith("fix."))).toBe(true);
  });

  it("puts a password reset last, behind everything", () => {
    const ranked = order([
      step("ad.reset_password"),
      step("fix.restart_app"),
      step("fix.clear_app_cache"),
      step("diag.system_info"),
    ]);
    expect(ranked[ranked.length - 1]).toBe("ad.reset_password");
  });
});

describe("what the strategist's belief is allowed to do", () => {
  it("breaks a tie between two fixes that cost the same", () => {
    // Both risk 1, self-reversible, device-scoped, elevated, both probed:
    // identical on every axis the registry knows about.
    const tied = [step("fix.gpupdate"), step("fix.renew_dhcp_lease")];
    expect(remediationCost("fix.gpupdate")).toBe(remediationCost("fix.renew_dhcp_lease"));

    const likely = new Map([["fix.renew_dhcp_lease", 0.9], ["fix.gpupdate", 0.2]]);
    expect(order(tied, likely)).toEqual(["fix.renew_dhcp_lease", "fix.gpupdate"]);
  });

  it("cannot promote an unprovable fix over an equally cheap one it could verify", () => {
    // Same cost, and the belief is stacked behind the one that leaves no
    // evidence. A tie is where "can I prove this worked?" gets to decide, and
    // it outranks the model's opinion.
    expect(remediationCost("fix.flush_dns")).toBe(remediationCost("fix.renew_dhcp_lease"));
    const likely = new Map([["fix.flush_dns", 0.95], ["fix.renew_dhcp_lease", 0.05]]);
    expect(order([step("fix.flush_dns"), step("fix.renew_dhcp_lease")], likely)).toEqual([
      "fix.renew_dhcp_lease",
      "fix.flush_dns",
    ]);
  });

  it("cannot promote an irreversible fix over a reversible one, however sure it is", () => {
    // The property the whole file exists for. Confidence is a model's opinion
    // and a ticket body can argue with it; reversibility is a registry fact.
    const likely = new Map([["fix.clear_app_cache", 1], ["fix.restart_app", 0]]);
    expect(order([step("fix.clear_app_cache"), step("fix.restart_app")], likely)).toEqual([
      "fix.restart_app",
      "fix.clear_app_cache",
    ]);
  });

  it("prefers the belief carried on the step over the authorisation map", () => {
    // The operator re-emits steps with real parameters bound; the strategist's
    // own steps carry the number directly.
    const steps = [
      step("fix.flush_dns", { likelihood: 0.1 }),
      step("fix.renew_dhcp_lease", { likelihood: 0.8 }),
    ];
    expect(order(steps)).toEqual(["fix.renew_dhcp_lease", "fix.flush_dns"]);
  });

  it("is stable when nothing distinguishes two steps", () => {
    const a = step("fix.flush_dns", { id: "a" });
    const b = step("fix.flush_dns", { id: "b" });
    expect(rankRemediations([a, b]).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("reads beliefs off an authorisation, ignoring the ones that state none", () => {
    const map = likelihoodsFrom([
      step("fix.restart_app", { likelihood: 0.7 }),
      step("diag.app_logs"),
    ]);
    expect(map.get("fix.restart_app")).toBe(0.7);
    expect(map.has("diag.app_logs")).toBe(false);
    // A step with no stated belief sorts as if it were neutral.
    expect(DEFAULT_LIKELIHOOD).toBe(0.5);
  });
});

describe("which steps are rungs at all", () => {
  it("counts changes and not looks", () => {
    expect(isRemediation(step("fix.restart_app"))).toBe(true);
    expect(isRemediation(step("ad.unlock_account"))).toBe(true);
    expect(isRemediation(step("diag.app_status"))).toBe(false);
    expect(isRemediation(step("fs.grep"))).toBe(false);
    expect(isRemediation({ ...step("fix.restart_app"), kind: "reply" })).toBe(false);
  });

  it("counts only the untried ones as candidates still to come", () => {
    const plan = [
      step("fix.restart_app", { status: "succeeded" }),
      step("fix.clear_app_cache"),
      step("diag.app_logs"),
      step("fix.set_proxy", { status: "skipped" }),
    ];
    // The succeeded fix is spent, the read is not a rung, the skipped one was
    // ruled out. One candidate left.
    expect(rungsRemaining(plan)).toBe(1);
  });
});
