import { NextResponse } from "next/server";
import { listADUsers, listADAccounts, listDevices } from "@/lib/data";
import { ensureSeeded } from "@/lib/seed";
import { getCurrentWorkspaceId } from "@/lib/workspace";
import { readHeartbeat, HEARTBEAT_CONNECTED_WINDOW_MS } from "@/lib/agent-heartbeat";
import { buildFleetView } from "@/lib/fleet";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const workspaceId = (await getCurrentWorkspaceId()) ?? undefined;
  const [users, accounts, devices] = await Promise.all([
    listADUsers(workspaceId),
    listADAccounts(workspaceId),
    listDevices(workspaceId),
  ]);
  const heartbeat = readHeartbeat();
  const heartbeatConnected = heartbeat ? Date.now() - heartbeat.lastPingAt < HEARTBEAT_CONNECTED_WINDOW_MS : false;
  return NextResponse.json(buildFleetView({ users, accounts, devices, heartbeat, heartbeatConnected }));
}
