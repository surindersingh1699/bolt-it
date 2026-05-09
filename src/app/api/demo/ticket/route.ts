import { NextRequest, NextResponse } from "next/server";
import { createTicket, demoApproveAndExecute } from "@/app/actions/tickets";
import { getTicket } from "@/lib/data";
import { getCurrentWorkspaceId, getOrMintDemoWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const existing = await getCurrentWorkspaceId();
  const workspaceId = existing ?? (await getOrMintDemoWorkspaceId());
  const id = await createTicket({
    reporter: body.reporter ?? "Alex Reyes",
    reporterEmail: body.reporterEmail ?? "alex@acme.test",
    subject: body.subject ?? "Can't access Figma anymore",
    body: body.body ?? "I switched teams yesterday and now Figma says I don't have access.",
    channel: "slack",
    workspaceId,
  });
  if (body.autoApprove === true) {
    void waitAndApprove(id, workspaceId);
  }
  return NextResponse.json({ ticketId: id, workspaceId });
}

async function waitAndApprove(id: string, workspaceId: string) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const t = await getTicket(id, workspaceId);
    if (!t) return;
    if (t.status === "awaiting_approval") {
      await demoApproveAndExecute(id);
      return;
    }
    if (t.status === "resolved" || t.status === "escalated") return;
  }
}
