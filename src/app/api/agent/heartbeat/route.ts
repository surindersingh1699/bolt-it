import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { z } from "zod";
import { HEARTBEAT_CONNECTED_WINDOW_MS, readHeartbeat, recordHeartbeat } from "@/lib/agent-heartbeat";
import { authenticateAgent } from "@/lib/device-auth";
import { getDevice, updateDevice } from "@/lib/data";
import { agentBuildId, DEV_BUILD } from "@/lib/agent-bundle";

export const dynamic = "force-dynamic";

/**
 * Keep the device registry live from the heartbeat a connected agent already
 * sends. A registered device is what `observe` looks for; without this, a device
 * would only ever be as fresh as its last enrolment, and `liveDeviceFor` would
 * decide it had gone offline while the agent kept pinging.
 *
 * Attribution (which user owns the machine) comes from enrolment, never from a
 * heartbeat — a shared-token agent names no owner and we do not invent one. So
 * this refreshes an EXISTING device: an enrolled device by its own token, or,
 * for a shared-token agent, whatever device was already assigned to that
 * hostname. It never creates an unowned row that observe could not use anyway.
 */
async function refreshDeviceFromHeartbeat(
  auth: NonNullable<Awaited<ReturnType<typeof authenticateAgent>>>,
  hb: { hostname: string; os: string; version: string },
): Promise<void> {
  const patch = { lastSeenAt: Date.now(), os: hb.os, agentVersion: hb.version };
  if (auth.kind === "device") {
    await updateDevice(auth.device.id, patch);
    return;
  }
  const existing = await getDevice(hb.hostname);
  if (existing) await updateDevice(existing.id, patch);
}

const CONNECTED_WINDOW_MS = HEARTBEAT_CONNECTED_WINDOW_MS;

const heartbeatSchema = z.object({
  hostname: z.string().min(1).max(253),
  os: z.string().min(1).max(200),
  version: z.string().min(1).max(64),
  // Only an agent new enough to send it has one. Its absence is what the jobs
  // route reads as "too old to be handed work".
  build: z.string().min(1).max(64).nullable().optional(),
  // The device's own account of what its build implements. Bounded so a
  // compromised or broken agent cannot post an unbounded blob every 3 seconds.
  surface: z
    .object({
      handlers: z.array(z.string().min(1).max(64)).max(100),
      binaries: z.object({
        default: z.array(z.string().min(1).max(32)).max(200),
        grantable: z.array(z.string().min(1).max(32)).max(200),
      }),
    })
    .nullable()
    .optional(),
  // Set from the machine's own console by the person sitting at it. Optional so
  // an older agent, which cannot be paused at all, still validates.
  paused: z.boolean().optional(),
  currentJob: z
    .object({
      id: z.string().min(1).max(64),
      command: z.string().min(1).max(300),
      startedAt: z.number(),
    })
    .nullable()
    .optional(),
});

function authorized(req: Request): boolean {
  const expected = process.env.LOCAL_AGENT_TOKEN;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

export async function POST(req: Request) {
  // Accept a per-device token or the shared token, the same as the jobs route —
  // an enrolled agent must be able to heartbeat with its own credential.
  const auth = await authenticateAgent(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = heartbeatSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  recordHeartbeat(parsed.data);
  // Best-effort: keep the device registry fresh, but never fail a heartbeat over it.
  await refreshDeviceFromHeartbeat(auth, parsed.data).catch(() => {});
  return NextResponse.json({ ok: true });
}

/**
 * Agent status for the UI.
 *
 * This was unauthenticated, and it returns an employee's hostname, operating
 * system, and what is being run on their machine right now. That is a free
 * reconnaissance endpoint for anyone who can reach the deployment: it names a
 * live host and tells you when somebody is at the keyboard.
 *
 * Two callers, two credentials: a signed-in person in the UI, or the device
 * agent itself. Neither is "whoever asks".
 */
export async function GET(req: Request) {
  const session = await getCurrentSession().catch(() => null);
  if (!session && !authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const hb = readHeartbeat();
  if (!hb) return NextResponse.json({ connected: false });
  const ageMs = Date.now() - hb.lastPingAt;
  const serverBuild = await agentBuildId();
  return NextResponse.json({
    connected: ageMs < CONNECTED_WINDOW_MS,
    hostname: hb.hostname,
    os: hb.os,
    lastPingAt: hb.lastPingAt,
    ageMs,
    currentJob: hb.currentJob,
    // Why a connected agent is running nothing. Without it, a paused machine and
    // an idle one are the same picture.
    paused: hb.paused,
    version: hb.version,
    build: hb.build,
    serverBuild,
    // The same rule the jobs route enforces, reported so a person can see why a
    // connected agent is running nothing.
    staleBuild: hb.build !== DEV_BUILD && Boolean(serverBuild) && hb.build !== serverBuild,
  });
}
