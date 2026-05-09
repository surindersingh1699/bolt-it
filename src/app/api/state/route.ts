import { NextResponse } from "next/server";
import { deflectionStats, listRunbooks, listTickets } from "@/lib/data";
import { ensureSeeded } from "@/lib/seed";
import { getCurrentWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const workspaceId = (await getCurrentWorkspaceId()) ?? undefined;
  const [tickets, runbooks, stats] = await Promise.all([
    listTickets(workspaceId),
    listRunbooks(workspaceId),
    deflectionStats(workspaceId),
  ]);
  return NextResponse.json({ tickets, runbooks, stats, workspaceId: workspaceId ?? null });
}
