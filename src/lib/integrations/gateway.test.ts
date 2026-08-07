import { describe, it, expect } from "vitest";
import { supportsTemperature } from "./gateway";

// The Claude 5 family answers a request carrying `temperature` with a 400 and
// "`temperature` is deprecated for this model". Every call in this system passes
// one, so getting this wrong means every model call fails — invisibly, because
// gatewayChat returns null and callers post their deterministic fallback text.
describe("temperature support", () => {
  it("omits it for the Claude 5 family, in both slug forms", () => {
    for (const model of [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
    ]) {
      expect(supportsTemperature(model), model).toBe(false);
    }
  });

  it("keeps it for models that still accept it", () => {
    for (const model of [
      "claude-haiku-4-5-20251001",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-5-20250929",
      "anthropic/claude-haiku-4-5",
      "gpt-4o-mini",
    ]) {
      expect(supportsTemperature(model), model).toBe(true);
    }
  });

  // `claude-haiku-4-5` ends in "-5" and must NOT match: the pattern keys on the
  // major version slot, not on the last character of the string.
  it("does not mistake a 4.5 model for a 5 model", () => {
    expect(supportsTemperature("claude-haiku-4-5")).toBe(true);
    expect(supportsTemperature("anthropic/claude-haiku-4-5")).toBe(true);
  });
});
