import { NextResponse } from "next/server";
import { listTickets, updateTicket } from "@/lib/data";
import { getCurrentWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const STUCK_AGE_MS = 30_000;

export async function POST() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 401 });
  return clear(workspaceId);
}

export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "no workspace" }, { status: 401 });
  return clear(workspaceId);
}

async function clear(workspaceId: string) {
  const all = await listTickets(workspaceId);
  const now = Date.now();
  const stuck = all.filter(
    (t) => (t.status === "new" || t.status === "drafting") && now - t.createdAt > STUCK_AGE_MS,
  );
  for (const t of stuck) {
    await updateTicket(t.id, {
      status: "escalated",
      draftResponse:
        t.draftResponse ??
        `This ticket couldn't auto-draft (stuck >30s). Cleared by admin and routed for human review.`,
    });
  }
  return NextResponse.json({ cleared: stuck.map((t) => t.id), count: stuck.length });
}
