import { NextResponse } from "next/server";
import { getCurrentSession } from "@/lib/auth";
import { z } from "zod";
import { HEARTBEAT_CONNECTED_WINDOW_MS, readHeartbeat, recordHeartbeat } from "@/lib/agent-heartbeat";

export const dynamic = "force-dynamic";

const CONNECTED_WINDOW_MS = HEARTBEAT_CONNECTED_WINDOW_MS;

const heartbeatSchema = z.object({
  hostname: z.string().min(1).max(253),
  os: z.string().min(1).max(200),
  version: z.string().min(1).max(64),
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
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  return NextResponse.json({
    connected: ageMs < CONNECTED_WINDOW_MS,
    hostname: hb.hostname,
    os: hb.os,
    lastPingAt: hb.lastPingAt,
    ageMs,
    currentJob: hb.currentJob,
  });
}
