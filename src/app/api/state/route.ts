import { NextResponse } from "next/server";
import { listTickets } from "@/lib/data";
import { ensureSeeded } from "@/lib/seed";
import { getCurrentWorkspaceId } from "@/lib/workspace";
import { getTrace } from "@/lib/trace";
import { getChat } from "@/lib/chat";
import { getUsage, summarizeUsage } from "@/lib/usage";
import { sweepOrphanedTickets } from "@/lib/ticket-graph";

export const dynamic = "force-dynamic";

export async function GET() {
  await ensureSeeded();
  // Recovery for tickets whose run died with the process. Throttled inside;
  // fire-and-forget so the poll stays fast.
  void sweepOrphanedTickets();
  const workspaceId = (await getCurrentWorkspaceId()) ?? undefined;
  const tickets = await listTickets(workspaceId);
  return NextResponse.json({
    tickets: tickets.map((t) => ({
      ...t,
      trace: getTrace(t.id),
      chat: getChat(t.id),
      usage: summarizeUsage(getUsage(t.id)),
    })),
    workspaceId: workspaceId ?? null,
  });
}
