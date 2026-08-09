import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { recordHeartbeat } from "./agent-heartbeat";
import { unsupportedByDevice } from "./executors";
import { decideGrant } from "./grants";
import type { PlanStep } from "./types";

const step = (params: Record<string, unknown>, capability = "diag.command_output"): PlanStep =>
  ({ id: "s1", kind: "device", capability, params, status: "pending", description: "d" }) as PlanStep;

const heartbeat = (surface: {
  handlers: string[];
  binaries: { default: string[]; grantable: string[] };
} | null) =>
  recordHeartbeat({
    hostname: "testpc",
    os: "win32",
    version: "local-agent/0.6.0",
    build: "abc123",
    surface,
  });

/**
 * The failure this exists to stop: the registry says `fs.grep` exists, the
 * device's build has no `fs_grep` handler, the step is dispatched anyway, and the
 * agent answers with prose (`Command is not allowlisted`) that the graph can only
 * classify as a generic execution failure. T-4935 spent three strategist looks on
 * exactly that, theorising about an allowlist that was working correctly.
 */
describe("planning against the machine that actually answers", () => {
  beforeEach(() => heartbeat({
    handlers: ["command_output", "network_state"],
    binaries: { default: ["nslookup", "ipconfig"], grantable: ["netsh"] },
  }));
  afterEach(() => heartbeat(null));

  it("catches a handler this build does not implement, before it is dispatched", () => {
    const f = unsupportedByDevice(step({ path: "C:\\hosts", pattern: "youtube" }, "fs.grep"));
    expect(f?.kind).toBe("capability_missing");
    expect(f?.detail).toContain("fs_grep");
    // Not grantable: no decision makes a missing handler run, so offering an
    // approval here would retry the identical step and fail identically.
    expect(f?.grantableBinary).toBeUndefined();
  });

  it("lets through a binary the machine runs by default", () => {
    expect(unsupportedByDevice(step({ binary: "nslookup", args: "youtube.com" }))).toBeNull();
  });

  it("marks a grantable binary as a missing DECISION, not a missing capability", () => {
    const f = unsupportedByDevice(step({ binary: "netsh", args: "winhttp show proxy" }));
    expect(f?.grantableBinary).toBe("netsh");
  });

  it("refuses a binary that is on neither list, and says so plainly", () => {
    const f = unsupportedByDevice(step({ binary: "curl", args: "https://youtube.com" }));
    expect(f?.kind).toBe("capability_missing");
    expect(f?.grantableBinary).toBeUndefined();
    expect(f?.detail).toContain("no approval can add it");
  });

  // A build too old to describe itself is not second-guessed. Assuming a surface
  // it never claimed would refuse work the machine can actually do.
  it("dispatches normally when the device reports no surface", () => {
    heartbeat(null);
    expect(unsupportedByDevice(step({ binary: "curl" }))).toBeNull();
  });
});

/**
 * A read-only diagnostic that needs nothing but a name on a list is not worth a
 * person's click at AUTONOMY=full — that is what the rung means. T-2384 sat on
 * "approve netsh winhttp show proxy" for thirteen hours because it was.
 */
describe("who decides a grant", () => {
  const refused = (grantableBinary?: string): PlanStep =>
    ({
      ...step({ binary: "netsh" }),
      status: "failed",
      failure: { kind: "capability_missing", detail: "needs approval", grantableBinary },
    }) as PlanStep;

  afterEach(() => {
    delete process.env.AUTONOMY;
  });

  it("grants itself at full autonomy", () => {
    process.env.AUTONOMY = "full";
    expect(decideGrant(refused("netsh"))).toMatchObject({ kind: "auto", binary: "netsh" });
  });

  it("keeps the human click on every rung below full", () => {
    process.env.AUTONOMY = "gated";
    expect(decideGrant(refused("netsh"))).toMatchObject({ kind: "ask_human", binary: "netsh" });
  });

  // The marker is the only thing that makes a step grantable. Without it, every
  // capability_missing on a command step would look like one — including "this
  // build has no such handler", which a grant cannot fix.
  it("is not a grant question at all without the agent's marker", () => {
    process.env.AUTONOMY = "full";
    expect(decideGrant(refused())).toEqual({ kind: "not_a_grant" });
  });

  // The technician on T-4935 clicked Approve four times against a step that came
  // back refused every time. One ask per binary per ticket, whatever the cause.
  it("never asks twice for a binary this ticket already granted", () => {
    process.env.AUTONOMY = "gated";
    expect(decideGrant(refused("netsh"), ["netsh"])).toEqual({ kind: "spent", binary: "netsh" });
    process.env.AUTONOMY = "full";
    expect(decideGrant(refused("netsh"), ["netsh"])).toEqual({ kind: "spent", binary: "netsh" });
  });
});
