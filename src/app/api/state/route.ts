import { NextResponse } from "next/server";
import { deflectionStats, listRunbooks, listTickets } from "@/lib/data";
import { ensureSeeded } from "@/lib/seed";
import { getCurrentWorkspaceId } from "@/lib/workspace";
import { getTrace } from "@/lib/trace";
import { getChat } from "@/lib/chat";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const workspaceId = (await getCurrentWorkspaceId()) ?? undefined;
  const [tickets, runbooks, stats] = await Promise.all([
    listTickets(workspaceId),
    listRunbooks(workspaceId),
    deflectionStats(workspaceId),
  ]);
  return NextResponse.json({
    tickets: tickets.map((t) => ({ ...t, trace: getTrace(t.id), chat: getChat(t.id) })),
    runbooks,
    stats,
    workspaceId: workspaceId ?? null,
  });
}
