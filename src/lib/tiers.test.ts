import { describe, it, expect } from "vitest";
import { TIERS, capabilityAllowed, nextTier, tierSpec, tierSystemPrompt } from "./tiers";

// Tier shape is independent of AUTONOMY by design — autonomy decides whether
// anyone WAITS on a person (reviewer.ts), never who the colleague is. No env
// pinning here, and a test that starts needing it is a regression.
describe("tier capability boundaries", () => {
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

  it("puts a different, stronger model at each depth", () => {
    // Cheap and fast at first line, strongest only where the hard problems land.
    // Collapsing these onto one model is what makes three agents into one.
    expect(tierSpec(1).model).toContain("haiku");
    expect(tierSpec(2).model).toContain("sonnet");
    expect(tierSpec(3).model).toContain("opus");
    const models = new Set([tierSpec(1).model, tierSpec(2).model, tierSpec(3).model]);
    expect(models.size).toBe(3);
  });

  it("gives each tier its own prompt, not the deepest one three times", () => {
    const prompts = new Set([tierSpec(1).promptBody, tierSpec(2).promptBody, tierSpec(3).promptBody]);
    expect(prompts.size).toBe(3);
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
