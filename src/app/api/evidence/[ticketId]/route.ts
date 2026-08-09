import { NextResponse } from "next/server";
import { listAgentJobsForTicket } from "@/lib/data";
import { getCurrentWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

interface Params {
  params: Promise<{ ticketId: string }>;
}

/**
 * The execution envelopes for one ticket — every probe, every command, every
 * before/after fact the machine reported.
 *
 * Deliberately NOT on `/api/state`. That route is polled every 600ms by every
 * open tab, and one envelope carries up to 24 commands with 4000 characters of
 * stdout each. Putting proof on the poll would have made the page heavier by two
 * orders of magnitude to serve a panel that is closed almost all the time, so
 * this is fetched once, when someone actually opens it.
 */
export async function GET(_req: Request, { params }: Params) {
  const { ticketId } = await params;
  const workspaceId = await getCurrentWorkspaceId();
  // No anonymous mode. An empty list would read as "this ticket has no
  // evidence", which is a different and much worse answer than "you are not
  // signed in".
  if (!workspaceId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json({ jobs: await listAgentJobsForTicket(ticketId, workspaceId) });
}
