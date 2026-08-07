import { describe, it, expect } from "vitest";
import { authorizeOperatorSteps, OPERATOR_MODEL, operatorSystemPrompt } from "./operator";
import { CAPABILITIES, capabilityAllowed, isReadOnlyCapability } from "./capabilities";
import { PlanStep } from "./types";

const step = (capability: string | undefined, params?: Record<string, unknown>): PlanStep => ({
  id: `s-${capability ?? "none"}`,
  kind: capability?.startsWith("ad.") ? "backend" : "device",
  description: "x",
  capability,
  params,
  status: "pending",
});

describe("the operator's authorisation boundary", () => {
  it("lets the operator run any read without asking", () => {
    // This is the operator's room to manoeuvre: it works out the right app name
    // or path by looking, not by guessing twice.
    const { steps, rejected } = authorizeOperatorSteps(
      [step("fs.list"), step("diag.app_status"), step("diag.process_list")],
      [],
    );
    expect(steps).toHaveLength(3);
    expect(rejected).toHaveLength(0);
  });

  it("lets it run a change the strategist authorised", () => {
    const { steps, rejected } = authorizeOperatorSteps(
      [step("fix.restart_app", { app: "Microsoft Outlook" })],
      [step("fix.restart_app", { app: "Outlook" })],
    );
    expect(steps).toHaveLength(1);
    // The corrected param is the point — the operator's job is binding the real
    // app name, and matching on capability rather than on the whole step is what
    // allows that.
    expect(steps[0].params).toEqual({ app: "Microsoft Outlook" });
    expect(rejected).toHaveLength(0);
  });

  it("refuses a change the strategist did not authorise", () => {
    // The failure this exists to prevent: a cheap model deciding on its own that
    // clearing the cache is the obvious next thing. Clearing a cache destroys
    // the employee's local app state; that call belongs to the diagnostician.
    const { steps, rejected } = authorizeOperatorSteps(
      [step("fix.clear_app_cache", { app: "Outlook" })],
      [step("fix.restart_app", { app: "Outlook" })],
    );
    expect(steps).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("refuses a destructive directory write even when it looks related", () => {
    const { steps, rejected } = authorizeOperatorSteps(
      [step("ad.reset_password")],
      [step("ad.unlock_account")],
    );
    expect(steps).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("treats ad.lookup_user as the read it actually is", () => {
    // Prefix tests would get this wrong: it starts with ad. but changes nothing.
    expect(isReadOnlyCapability("ad.lookup_user")).toBe(true);
    const { steps } = authorizeOperatorSteps([step("ad.lookup_user")], []);
    expect(steps).toHaveLength(1);
  });

  it("refuses a capability that does not exist at all", () => {
    const { steps, rejected } = authorizeOperatorSteps(
      [step("fix.reformat_disk"), step(undefined)],
      [step("fix.reformat_disk")],
    );
    // Even an "authorised" unknown id is refused: authorisation cannot widen the
    // closed capability set, only select within it.
    expect(steps).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });

  it("never lets the operator write to the employee", () => {
    const reply: PlanStep = { id: "r", kind: "reply", description: "hi", status: "pending" };
    const { steps, rejected } = authorizeOperatorSteps([reply], []);
    expect(steps).toHaveLength(0);
    expect(rejected).toHaveLength(1);
  });

  it("keeps every authorised write inside the closed capability set", () => {
    for (const cap of CAPABILITIES) expect(capabilityAllowed(cap)).toBe(true);
    expect(capabilityAllowed("fix.anything")).toBe(false);
  });
});

describe("the operator's prompt", () => {
  it("runs on the cheap model, because this is the loop that runs often", () => {
    expect(OPERATOR_MODEL).toContain("sonnet");
  });

  it("tells the operator it does not decide the ticket is resolved", () => {
    // Resolution is a judgement about whether the problem is gone. It belongs to
    // the model that formed the diagnosis, and it is checked against evidence.
    expect(operatorSystemPrompt()).toContain("Decide the problem is solved");
  });

  it("tells the operator not to retry a step that changed nothing", () => {
    expect(operatorSystemPrompt()).toContain("NO EFFECT");
  });

  it("names every capability, since it must bind params for all of them", () => {
    const prompt = operatorSystemPrompt();
    for (const cap of CAPABILITIES) expect(prompt).toContain(cap);
  });
});
