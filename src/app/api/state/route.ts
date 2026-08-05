import { NextResponse } from "next/server";
import { deflectionStats, getWorkspace, listRunbooks, listTickets } from "@/lib/data";
import { ensureSeeded } from "@/lib/seed";
import { getCurrentWorkspaceId } from "@/lib/workspace";
import { getTrace } from "@/lib/trace";
import { getChat } from "@/lib/chat";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  const workspaceId = (await getCurrentWorkspaceId()) ?? undefined;
  const [tickets, runbooks, stats, workspace] = await Promise.all([
    listTickets(workspaceId),
    listRunbooks(workspaceId),
    deflectionStats(workspaceId),
    workspaceId ? getWorkspace(workspaceId) : Promise.resolve(null),
  ]);
  return NextResponse.json({
    tickets: tickets.map((t) => ({ ...t, trace: getTrace(t.id), chat: getChat(t.id) })),
    runbooks,
    stats,
    workspaceId: workspaceId ?? null,
    integrations: {
      slackConnected: Boolean(workspace?.slackAccessToken),
      slackTeamName: workspace?.slackTeamName ?? null,
      hyperspellMode: process.env.HYPERSPELL_API_KEY ? ("live" as const) : ("mock" as const),
    },
  });
}
