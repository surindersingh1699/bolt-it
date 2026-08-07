import { describe, it, expect } from "vitest";
import { resolutionSupported } from "./resolution";
import type { ReplyEvidence } from "./integrations/ai-gateway";

const ev = (status: ReplyEvidence["status"], deviceEffect?: string): ReplyEvidence => ({
  stepDescription: "checked the thing",
  status,
  logLines: [],
  deviceEffect,
});

describe("resolutionSupported", () => {
  it("refuses a resolution when nothing has run", () => {
    // The specific failure: the strategist reads the pre-plan device readings,
    // decides they look fine, and closes a ticket without touching anything.
    const r = resolutionSupported([]);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/nothing/i);
  });

  it("refuses when the only fix left the machine unchanged", () => {
    const r = resolutionSupported([
      ev("failed", "NO EFFECT — commands ran but the device's before/after state is identical; nothing changed."),
    ]);
    expect(r.ok).toBe(false);
    expect(r.why).toMatch(/unchanged/i);
  });

  it("refuses when every step errored on the device", () => {
    const r = resolutionSupported([ev("failed", "FAILED — the command did not complete on the device.")]);
    expect(r.ok).toBe(false);
  });

  it("accepts a verified change", () => {
    expect(resolutionSupported([ev("succeeded", "VERIFIED CHANGE — running: no → yes")]).ok).toBe(true);
  });

  it("accepts a read that answered the question, with nothing changed", () => {
    // "What's my hostname?" is resolved by looking. Requiring a mutation would
    // make every question ticket permanently unresolvable, so the bar is that
    // something ran and something worked — not that something moved.
    expect(resolutionSupported([ev("succeeded", "Read-only: collected system info")]).ok).toBe(true);
  });

  it("accepts a mixed round where at least one step landed", () => {
    const r = resolutionSupported([
      ev("failed", "FAILED — the command did not complete on the device."),
      ev("succeeded", "VERIFIED CHANGE — dns: 10.0.0.1 → 1.1.1.1"),
    ]);
    expect(r.ok).toBe(true);
  });
});
