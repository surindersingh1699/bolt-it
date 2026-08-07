/**
 * The dry-run rungs.
 *
 * A plan whose steps depend on each other breaks under simulation: step 1's
 * write never lands, so step 2's pre-probe reads the un-mutated machine and
 * fails. Two separate things go wrong if that is not handled, and both are
 * pinned here:
 *
 *   1. The dependent step looks like a defect in the plan rather than an
 *      artifact of the rung, and routes a healthy ticket to a human handoff.
 *   2. Every simulated write satisfies `expectsChange && !changed`, so the whole
 *      run reports as universal `no_effect` failure and the mode is useless.
 */

import { describe, expect, it } from "vitest";
import { deriveJobStatus, effectSummaryFor, formatProofLines, isRealSuccess } from "./evidence";
import { resolutionSupported } from "./resolution";
import { AgentJob, ExecutionEnvelope } from "./types";
import type { ReplyEvidence } from "./integrations/ai-gateway";

const envelope = (over: Partial<ExecutionEnvelope> = {}): ExecutionEnvelope => ({
  jobId: "job-1",
  command: 'restart_app --app "Outlook"',
  host: "dana-mbp",
  os: "darwin",
  agentVersion: "local-agent/0.6.0",
  startedAt: 0,
  finishedAt: 10,
  durationMs: 10,
  expectsChange: true,
  probes: [],
  commands: [],
  effect: { changed: false, diff: [], summary: "no change" },
  ...over,
});

const job = (over: Partial<AgentJob> = {}): AgentJob => ({
  id: "job-1",
  workspaceId: "w-1",
  ticketId: "t-1",
  kind: "app_diagnostic",
  targetUserEmail: "dana@acme.test",
  instructions: "",
  allowlistedCommand: 'restart_app --app "Outlook"',
  status: "simulated",
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const evidence = (status: ReplyEvidence["status"]): ReplyEvidence => ({
  stepDescription: "Restart Outlook",
  capability: "fix.restart_app",
  status,
  logLines: [],
});

describe("deriveJobStatus", () => {
  it("checks simulated BEFORE the no_effect rule", () => {
    // The ordering is the fix. A simulated write is always "expected a change
    // and did not produce one", so checked second it would be no_effect —
    // which fails the step — on every step of every simulation run.
    expect(deriveJobStatus(true, envelope({ simulated: true }))).toBe("simulated");
  });

  it("still reports a real unchanged write as no_effect", () => {
    expect(deriveJobStatus(true, envelope())).toBe("no_effect");
  });

  it("still reports a real changed write as succeeded", () => {
    expect(
      deriveJobStatus(true, envelope({ effect: { changed: true, diff: [], summary: "relaunched" } })),
    ).toBe("succeeded");
  });

  it("reports a failure as failed even when simulated", () => {
    expect(deriveJobStatus(false, envelope({ simulated: true }))).toBe("failed");
  });
});

describe("a simulated result is never evidence that something happened", () => {
  it("is not a real success", () => {
    expect(isRealSuccess("simulated")).toBe(false);
    expect(isRealSuccess("succeeded")).toBe(true);
  });

  it("cannot support a resolution claim on its own", () => {
    const check = resolutionSupported([evidence("simulated"), evidence("simulated")]);
    expect(check.ok).toBe(false);
  });

  it("cannot be laundered into a resolution by sitting next to a failure", () => {
    expect(resolutionSupported([evidence("simulated"), evidence("failed")]).ok).toBe(false);
  });

  it("still lets a genuinely succeeded step resolve the ticket", () => {
    expect(resolutionSupported([evidence("simulated"), evidence("succeeded")]).ok).toBe(true);
  });

  it("says plainly what it is, in the line handed to the reply writer", () => {
    const s = effectSummaryFor("simulated");
    expect(s).toContain("never sent");
    expect(s).not.toContain("VERIFIED");
  });
});

describe("simulated dependencies", () => {
  it("records an unmet pre-probe as a warning, not a failure", () => {
    const lines = formatProofLines(
      job({
        envelope: envelope({
          simulated: true,
          simulatedDependencyUnmet: ["step-1"],
        }),
      }),
    );
    const text = lines.join("\n");
    expect(text).toContain("simulated_dependency_unmet");
    expect(text).toContain("step-1");
    // Named as an artifact of the rung, so a reader does not chase it as a bug.
    expect(text).toContain("not a defect in the plan");
  });

  it("does not emit the warning on a real run", () => {
    const text = formatProofLines(job({ status: "succeeded", envelope: envelope() })).join("\n");
    expect(text).not.toContain("simulated_dependency_unmet");
  });
});

describe("the proof block cannot be misread", () => {
  it("leads with an unmissable dry-run banner", () => {
    const lines = formatProofLines(job({ envelope: envelope({ simulated: true }) }));
    expect(lines[0]).toContain("DRY RUN");
    expect(lines[0]).toContain("Nothing was sent");
  });

  it("refuses to print an EFFECT line for a simulated run", () => {
    const text = formatProofLines(
      job({
        envelope: envelope({
          simulated: true,
          effect: { changed: true, diff: [], summary: "would have relaunched Outlook" },
        }),
      }),
    ).join("\n");
    expect(text).toContain("SIMULATED");
    expect(text).not.toContain("[Proof] EFFECT:");
  });

  it("does not claim NO EFFECT either — nothing was attempted", () => {
    const text = formatProofLines(job({ envelope: envelope({ simulated: true }) })).join("\n");
    expect(text).not.toContain("NO EFFECT");
  });

  it("leaves a real run's proof block exactly as it was", () => {
    const text = formatProofLines(
      job({
        status: "succeeded",
        envelope: envelope({ effect: { changed: true, diff: [], summary: "relaunched" } }),
      }),
    ).join("\n");
    expect(text).not.toContain("DRY RUN");
    expect(text).toContain("[Proof] EFFECT: relaunched");
  });
});
