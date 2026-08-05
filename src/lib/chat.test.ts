import { describe, it, expect } from "vitest";
import { classifyConfirmation } from "./chat";

// Drives whether a ticket resolves or escalates when the user replies in the
// Slack thread. A false "yes" closes a ticket that is still broken.
describe("classifyConfirmation", () => {
  it("reads plain affirmatives as yes", () => {
    for (const t of ["yes", "y", "yep", "fixed", "works", "resolved", "that worked", "all good"]) {
      expect(classifyConfirmation(t)).toBe("yes");
    }
  });

  it("reads plain negatives as no", () => {
    for (const t of ["no", "nope", "still broken", "not working", "didn't work", "same"]) {
      expect(classifyConfirmation(t)).toBe("no");
    }
  });

  it("ignores case and surrounding whitespace", () => {
    expect(classifyConfirmation("  YES  ")).toBe("yes");
    expect(classifyConfirmation("  Nope ")).toBe("no");
  });

  it("falls back to ambiguous rather than guessing", () => {
    for (const t of ["maybe", "what do you mean?", "", "hmm"]) {
      expect(classifyConfirmation(t)).toBe("ambiguous");
    }
  });

  // "no" must win on its own; a negation that merely contains "work" must not
  // be read as success.
  it("does not read a negated success as yes", () => {
    expect(classifyConfirmation("not working")).toBe("no");
    expect(classifyConfirmation("no, still broken")).toBe("no");
  });
});
