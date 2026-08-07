/**
 * Routing follows enrolment, observation follows registration.
 *
 * A device row can exist for attribution (an admin assigned a machine to a user,
 * or the shared-token heartbeat registered it) without the machine being able to
 * CLAIM a job — claiming needs a token. Binding a job to a token-less device
 * would leave it queued forever while the shared-token agent, which only drains
 * unbound jobs, skips it. So a job is stamped with deviceId only when the device
 * is enrolled (has a tokenHash).
 */

import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { enqueueAgentJob } from "./agent-jobs";
import { getAgentJob } from "./data";
import { Device, PlanStep, Ticket } from "./types";

const WS = "acme.test";

function device(over: Partial<Device> = {}): Device {
  return {
    id: "dev-x", workspaceId: WS, hostname: "box", os: "darwin",
    ownerEmail: "user@acme.test", source: "manual",
    firstSeenAt: 0, lastSeenAt: 0, ...over,
  };
}
function ticket(): Ticket {
  return {
    id: "T-ROUTE", workspaceId: WS, customerOrg: "acme", channel: "portal",
    reporter: "User", reporterEmail: "user@acme.test", subject: "s", body: "b",
    status: "executing", createdAt: 0, updatedAt: 0, plan: [], citations: [],
    confidence: 0, resolvedByAi: false,
  } as Ticket;
}
const step = (): PlanStep => ({
  id: "s1", kind: "device", capability: "diag.process_list", params: {},
  description: "list", status: "pending",
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_INSFORGE_URL; // force in-memory path
});

describe("job routing follows the token, not just the device row", () => {
  it("leaves a job UNBOUND when the owner's device has no token (attribution only)", async () => {
    db.insertDevice(device({ id: "dev-manual", tokenHash: undefined }));
    const r = await enqueueAgentJob(ticket(), step());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const job = await getAgentJob(r.job.id);
    // Unbound → the shared-token agent can drain it.
    expect(job?.deviceId).toBeUndefined();
  });

  it("BINDS a job to a device that is enrolled (has a token)", async () => {
    db.insertDevice(device({ id: "dev-enrolled", ownerEmail: "u2@acme.test", tokenHash: "abc123" }));
    const t = { ...ticket(), reporterEmail: "u2@acme.test" } as Ticket;
    const r = await enqueueAgentJob(t, step());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const job = await getAgentJob(r.job.id);
    expect(job?.deviceId).toBe("dev-enrolled");
  });
});
