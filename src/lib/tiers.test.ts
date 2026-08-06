import { describe, it, expect, beforeAll, afterAll } from "vitest";

// tiers.ts reads AUTONOMY once at module load, and under AUTONOMY=full it
// collapses all three tiers onto tier 3's model, prompt and capability set —
// there is then no boundary left to test. These are the guarantees of the GATED
// design, so the mode is pinned before the module is loaded.
let TIERS: typeof import("./tiers").TIERS;
let capabilityAllowed: typeof import("./tiers").capabilityAllowed;
let nextTier: typeof import("./tiers").nextTier;
let tierSpec: typeof import("./tiers").tierSpec;
let tierSystemPrompt: typeof import("./tiers").tierSystemPrompt;

beforeAll(async () => {
  process.env.AUTONOMY = "gated";
  ({ TIERS, capabilityAllowed, nextTier, tierSpec, tierSystemPrompt } = await import("./tiers"));
});

// Same convention as policy.test.ts: leave the env as we found it, so no other
// test file inherits a mode it did not ask for.
afterAll(() => {
  delete process.env.AUTONOMY;
});

describe("tier capability boundaries (AUTONOMY=gated)", () => {
  it("keeps the destructive identity write at the deepest tier only", () => {
    expect(capabilityAllowed(1, "ad.reset_password")).toBe(false);
    expect(capabilityAllowed(2, "ad.reset_password")).toBe(false);
    expect(capabilityAllowed(3, "ad.reset_password")).toBe(true);
  });

  it("keeps machine-changing fixes away from first line", () => {
    expect(capabilityAllowed(1, "fix.clear_app_cache")).toBe(false);
    expect(capabilityAllowed(1, "fix.toggle_wifi")).toBe(false);
    expect(capabilityAllowed(1, "ad.unlock_account")).toBe(false);
  });

  it("nests each tier inside the next, so escalating never removes an option", () => {
    for (const cap of TIERS[1].capabilities) expect(capabilityAllowed(2, cap)).toBe(true);
    for (const cap of TIERS[2].capabilities) expect(capabilityAllowed(3, cap)).toBe(true);
  });

  it("treats an unknown capability as out of tier at every depth", () => {
    for (const tier of [1, 2, 3] as const) {
      expect(capabilityAllowed(tier, "fix.reformat_disk")).toBe(false);
    }
  });

  it("terminates the escalation chain at tier 3", () => {
    expect(nextTier(1)).toBe(2);
    expect(nextTier(2)).toBe(3);
    expect(nextTier(3)).toBeNull();
  });

  it("gets deeper, not shallower, as the tier rises", () => {
    expect(tierSpec(2).capabilities.size).toBeGreaterThan(tierSpec(1).capabilities.size);
    expect(tierSpec(3).capabilities.size).toBeGreaterThan(tierSpec(2).capabilities.size);
    expect(tierSpec(3).budgetMs).toBeGreaterThan(tierSpec(1).budgetMs);
  });

  it("names in the prompt exactly the capabilities the tier may use", () => {
    const prompt = tierSystemPrompt(1);
    for (const cap of TIERS[1].capabilities) expect(prompt).toContain(cap);
    // The prompt must not advertise depth the tier does not have — a model told
    // about a capability it cannot use will plan around it and then be filtered.
    expect(prompt).not.toContain("ad.reset_password");
  });
});
