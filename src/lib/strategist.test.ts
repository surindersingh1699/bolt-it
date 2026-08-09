import { describe, it, expect } from "vitest";
import {
  MAX_AUTHORIZED_STEPS,
  MAX_STRATEGY_ROUNDS,
  STRATEGIST_MODEL,
  strategistSystemPrompt,
} from "./strategist";
import { CAPABILITIES } from "./capabilities";

const prompt = strategistSystemPrompt();

describe("the strategist's prompt", () => {
  it("runs on the expensive model, because this is the judgement", () => {
    expect(STRATEGIST_MODEL).toContain("opus");
  });

  it("names every capability it may authorise", () => {
    for (const cap of CAPABILITIES) expect(prompt).toContain(cap);
  });

  it("states the authorisation bound it is given", () => {
    expect(prompt).toContain(String(MAX_AUTHORIZED_STEPS));
  });
});

// These two rules are a pair and must stay one. Together they say: how much
// evidence a change needs depends on what being wrong about it costs. Delete the
// first and the agent goes back to reading for three rounds and reaching a
// person having changed nothing — the T-YouTube failure. Delete the second and
// "try the cheap thing on a hunch" silently becomes "reset their password on a
// hunch", which is the reason the first one was ever safe to write.
describe("how much evidence a change needs", () => {
  it("lets a cheap reversible fix be tried on a plausible link alone", () => {
    expect(prompt).toMatch(/self-reversible fix/i);
    expect(prompt).toMatch(/plausible link/i);
  });

  it("still demands a real observation for an irreversible or far-reaching one", () => {
    expect(prompt).toMatch(/irreversible or far-reaching/i);
    expect(prompt).toMatch(/must follow from something you actually observed/i);
  });

  it("explains WHY the cheap one is safe, so the rule survives an edit", () => {
    // The justification is the ladder: tried alone, employee asked straight
    // after. Without that sentence the relaxation reads as general permission.
    expect(prompt).toMatch(/tried on its own/i);
  });
});

describe("authorising a ladder rather than a batch", () => {
  it("says several authorised fixes are candidates, not a to-do list", () => {
    expect(prompt).toContain("AUTHORISE A LADDER, NOT A BATCH");
    expect(prompt).toMatch(/one change at a time/i);
  });

  it("tells it the order is computed, not chosen", () => {
    expect(prompt).toMatch(/You do not choose the order/i);
    expect(prompt).toMatch(/likelihood/i);
  });
});

describe("asking the web what fixes this", () => {
  it("has a question kind for remediation, not only for error codes", () => {
    expect(prompt).toContain("WHAT FIXES THIS");
    expect(prompt).toMatch(/known fixes for/i);
  });

  it("says to ask it early rather than reading until a cause is proven", () => {
    expect(prompt).toMatch(/FIRST look/i);
  });

  // The quarantine, restated where the strategist can act on it. research.ts
  // guarantees a finding cannot carry a command or a capability id; this is the
  // other half — the planner must know that naming the action is ITS job.
  it("keeps naming the capability the strategist's job, never the source's", () => {
    expect(prompt).toMatch(/A source never names a capability/i);
    expect(prompt).toMatch(/Match a described fix to a real capability id/i);
  });

  it("routes a fix with no capability to a capability_request, not a near-miss", () => {
    expect(prompt).toMatch(/NOTHING in the list can perform it/i);
    expect(prompt).toContain("capability_request");
  });

  it("does not let a source's confidence stand in for a result", () => {
    expect(prompt).toMatch(/never a reason to report it as done/i);
  });
});

describe("the round budget", () => {
  it("is three looks, and the prompt is told which one it is on", () => {
    expect(MAX_STRATEGY_ROUNDS).toBe(3);
  });
});
