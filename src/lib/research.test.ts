import { describe, it, expect } from "vitest";
import { researchAsContext, type ResearchFinding } from "./research";
import { EXECUTORS } from "./executors";

const findings: ResearchFinding[] = [
  {
    claim: "Error 0x8004010f indicates a corrupt Outlook offline address book.",
    sourceUrl: "https://learn.microsoft.com/outlook/troubleshoot/x",
    relevance: "the error code in the crash log",
  },
];

describe("research rendering", () => {
  it("renders nothing when nothing was established", () => {
    expect(researchAsContext([])).toBe("");
  });

  it("keeps every claim tied to the page it came from", () => {
    const text = researchAsContext(findings);
    expect(text).toContain("0x8004010f");
    expect(text).toContain("https://learn.microsoft.com/outlook/troubleshoot/x");
  });

  it("tells the planner a source explains the world, not this machine", () => {
    // The failure this guards against is a planner treating "this error is
    // usually caused by X" as evidence that X happened here, and then proposing
    // a fix for X on a machine nothing was ever read from.
    expect(researchAsContext(findings)).toContain("must still be justifiable");
    expect(researchAsContext(findings)).toContain("device evidence");
  });
});

describe("web lookup is not an executable action", () => {
  it("has no executor, because it is not a step kind any more", () => {
    // A search touches no company system and changes nothing, so paying for a
    // safety review and an approval decision to run one was pure overhead. The
    // registry is the enforcement: with no "knowledge" key, a plan step of that
    // kind cannot be dispatched at all.
    expect(Object.keys(EXECUTORS).sort()).toEqual(["backend", "device", "reply"]);
  });
});
