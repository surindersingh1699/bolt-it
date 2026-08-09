import { describe, it, expect } from "vitest";
import { agentJobToRow, agentJobFromRow } from "./data";
import type { AgentJob } from "./types";

/**
 * The bug this exists to make impossible.
 *
 * `AgentJob` grew `deviceId`, `deviceHostname` and `grantedBinaries`. The row
 * mapper did not, so all three were built, written, and lost — routing quietly
 * stopped binding jobs to machines, and an approved grant never reached the
 * agent, so the technician's Approve click produced the identical refusal and
 * the graph parked on it again. Four times, on T-4935, before someone stopped
 * clicking.
 *
 * A mapper that drops a field is invisible in every other test, because every
 * other test builds the object directly. This one goes through the wire.
 */
describe("an agent job survives the round trip through the store", () => {
  const job: Required<Omit<AgentJob, "envelope">> & Pick<AgentJob, "envelope"> = {
    id: "job-abc123",
    workspaceId: "acme.test",
    ticketId: "T-4935",
    stepId: "step-7",
    deviceId: "acme.test:testpc",
    deviceHostname: "testpc",
    grantedBinaries: ["netsh"],
    kind: "network_probe",
    targetUserEmail: "sabys@acme.test",
    instructions: "Check the WinHTTP proxy configuration",
    allowlistedCommand: 'command_output --binary "netsh" --argv ["winhttp","show","proxy"]',
    status: "queued",
    createdAt: 1786160565904,
    updatedAt: 1786160565905,
    claimedAt: 1786160566000,
    completedAt: 1786160569000,
    output: "Direct access (no proxy server).",
    error: undefined as unknown as string,
    envelope: undefined,
    effectChanged: false,
    effectSummary: "observed proxy=none",
  } as Required<Omit<AgentJob, "envelope">> & Pick<AgentJob, "envelope">;

  it("keeps every field, not just the ones an early version had", () => {
    const back = agentJobFromRow(agentJobToRow(job as AgentJob));
    for (const key of Object.keys(job) as (keyof AgentJob)[]) {
      if (job[key] === undefined) continue;
      expect({ key, value: back[key] }).toEqual({ key, value: job[key] });
    }
  });

  // The grant is the field whose loss is silent AND looks like a model failure:
  // the step comes back refused, so it reads as the agent being difficult rather
  // than as the approval never having arrived.
  it("carries the technician's grant to the device", () => {
    expect(agentJobFromRow(agentJobToRow(job as AgentJob)).grantedBinaries).toEqual(["netsh"]);
  });

  it("carries the device binding, so a job cannot be claimed by another machine", () => {
    const row = agentJobToRow(job as AgentJob);
    expect(row.device_id).toBe("acme.test:testpc");
    expect(agentJobFromRow(row).deviceId).toBe("acme.test:testpc");
  });
});
