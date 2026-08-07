/**
 * Device identity and job routing.
 *
 * The hole this closes, stated once so the tests below are legible: the agent
 * polled `/api/agent/jobs` with no workspace filter, the route listed EVERY
 * queued job in EVERY workspace, marked them all claimed in a non-atomic loop,
 * and returned them. `job.targetUserEmail` said whose machine the work was for
 * and nothing ever compared it to who was asking — so any machine holding the
 * shared token would run another employee's job against its own disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db";
import { claimAgentJob, getDeviceById, insertAgentJob, updateDevice } from "./data";
import { authenticateAgent, createEnrollmentCode, enrollDevice, hashToken } from "./device-auth";
import { AgentJob, Device } from "./types";

const WS = "acme.test";

function device(over: Partial<Device> = {}): Device {
  return {
    id: "dev-a",
    workspaceId: WS,
    hostname: "dana-mbp",
    os: "darwin",
    ownerEmail: "dana@acme.test",
    source: "manual",
    firstSeenAt: 0,
    lastSeenAt: 0,
    ...over,
  };
}

function job(over: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "job-1",
    workspaceId: WS,
    ticketId: "t-1",
    kind: "app_diagnostic",
    targetUserEmail: "dana@acme.test",
    instructions: "",
    allowlistedCommand: "process_list",
    status: "queued",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function req(token: string): Request {
  return new Request("http://localhost/api/agent/jobs", {
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  db.insertDevice(device({ id: "dev-a", hostname: "dana-mbp", ownerEmail: "dana@acme.test" }));
  db.insertDevice(device({ id: "dev-b", hostname: "sam-pc", ownerEmail: "sam@acme.test" }));
  delete process.env.ALLOW_SHARED_AGENT_TOKEN;
  delete process.env.LOCAL_AGENT_TOKEN;
});

afterEach(() => {
  delete process.env.ALLOW_SHARED_AGENT_TOKEN;
  delete process.env.LOCAL_AGENT_TOKEN;
});

describe("enrollment", () => {
  it("trades a one-time code for a token and binds it to the device", async () => {
    const code = createEnrollmentCode(WS, "dana@acme.test");
    const r = await enrollDevice(code.code, "dana-mbp", "darwin");
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const stored = await getDeviceById(r.deviceId);
    expect(stored?.tokenHash).toBe(hashToken(r.token));
  });

  it("never stores the token itself", async () => {
    const code = createEnrollmentCode(WS, "dana@acme.test");
    const r = await enrollDevice(code.code, "dana-mbp", "darwin");
    if (!r.ok) return;
    const stored = await getDeviceById(r.deviceId);
    // A leak of the device table must not be a leak of every agent's credential.
    expect(JSON.stringify(stored)).not.toContain(r.token);
  });

  it("burns the code — a replay gets nothing", async () => {
    const code = createEnrollmentCode(WS, "dana@acme.test");
    expect((await enrollDevice(code.code, "dana-mbp", "darwin")).ok).toBe(true);
    const second = await enrollDevice(code.code, "attacker-box", "linux");
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toContain("already been used");
  });

  it("refuses an unknown code", async () => {
    expect((await enrollDevice("not-a-code", "x", "linux")).ok).toBe(false);
  });

  it("refuses an expired code", async () => {
    const code = createEnrollmentCode(WS, "dana@acme.test");
    code.expiresAt = Date.now() - 1;
    const r = await enrollDevice(code.code, "dana-mbp", "darwin");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("expired");
  });
});

describe("authenticateAgent", () => {
  it("identifies the device that owns the token", async () => {
    const code = createEnrollmentCode(WS, "dana@acme.test");
    const r = await enrollDevice(code.code, "dana-mbp", "darwin");
    if (!r.ok) return;

    const auth = await authenticateAgent(req(r.token));
    expect(auth?.kind).toBe("device");
    expect(auth?.kind === "device" && auth.device.hostname).toBe("dana-mbp");
  });

  it("rejects an unknown token", async () => {
    expect(await authenticateAgent(req("garbage"))).toBeNull();
  });

  it("rejects a missing header", async () => {
    expect(await authenticateAgent(new Request("http://localhost/x"))).toBeNull();
  });

  it("rejects a revoked device's token", async () => {
    const code = createEnrollmentCode(WS, "dana@acme.test");
    const r = await enrollDevice(code.code, "dana-mbp", "darwin");
    if (!r.ok) return;
    await updateDevice(r.deviceId, { revokedAt: Date.now() });
    expect(await authenticateAgent(req(r.token))).toBeNull();
  });

  it("rejects the shared token unless it is explicitly re-enabled", async () => {
    process.env.LOCAL_AGENT_TOKEN = "shared-secret";
    expect(await authenticateAgent(req("shared-secret"))).toBeNull();

    process.env.ALLOW_SHARED_AGENT_TOKEN = "1";
    const auth = await authenticateAgent(req("shared-secret"));
    expect(auth?.kind).toBe("shared");
  });

  it("never reports the shared token as a device — it identifies no machine", async () => {
    process.env.LOCAL_AGENT_TOKEN = "shared-secret";
    process.env.ALLOW_SHARED_AGENT_TOKEN = "1";
    const auth = await authenticateAgent(req("shared-secret"));
    expect(auth?.kind).not.toBe("device");
  });
});

describe("claimAgentJob", () => {
  it("hands a device its own job", async () => {
    await insertAgentJob(job({ id: "j-own", deviceId: "dev-a" }));
    expect(await claimAgentJob("j-own", "dev-a")).not.toBeNull();
  });

  it("REFUSES another device's job — the whole point", async () => {
    await insertAgentJob(job({ id: "j-dana", deviceId: "dev-a", targetUserEmail: "dana@acme.test" }));
    // sam-pc asking for dana's job. This used to succeed.
    expect(await claimAgentJob("j-dana", "dev-b")).toBeNull();
    // ...and it is still there for the machine it was meant for.
    expect(await claimAgentJob("j-dana", "dev-a")).not.toBeNull();
  });

  it("is a compare-and-swap: two agents cannot both win one job", async () => {
    await insertAgentJob(job({ id: "j-race", deviceId: "dev-a" }));
    const first = await claimAgentJob("j-race", "dev-a");
    const second = await claimAgentJob("j-race", "dev-a");
    expect(first).not.toBeNull();
    expect(second, "the second claim must lose").toBeNull();
  });

  it("will not re-claim a job that already finished", async () => {
    await insertAgentJob(job({ id: "j-done", deviceId: "dev-a", status: "succeeded" }));
    expect(await claimAgentJob("j-done", "dev-a")).toBeNull();
  });

  it("marks the winner claimed with a timestamp", async () => {
    await insertAgentJob(job({ id: "j-ts", deviceId: "dev-a" }));
    const won = await claimAgentJob("j-ts", "dev-a");
    expect(won?.status).toBe("claimed");
    expect(won?.claimedAt).toBeGreaterThan(0);
  });

  it("lets an unbound job be claimed by anyone — the shared-token migration path", async () => {
    // Deliberate: a job created before any device was enrolled has no deviceId
    // and would otherwise be undeliverable forever.
    await insertAgentJob(job({ id: "j-unbound" }));
    expect(await claimAgentJob("j-unbound")).not.toBeNull();
  });
});
