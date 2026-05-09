import { NextRequest, NextResponse } from "next/server";
import { createTicket, approveAndExecute } from "@/app/actions/tickets";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = await createTicket({
    reporter: body.reporter ?? "Alex Reyes",
    reporterEmail: body.reporterEmail ?? "alex@acme.test",
    subject: body.subject ?? "Can't access Figma anymore",
    body: body.body ?? "I switched teams yesterday and now Figma says I don't have access.",
    channel: "slack",
  });
  if (body.autoApprove === true) {
    void waitAndApprove(id);
  }
  return NextResponse.json({ ticketId: id });
}

async function waitAndApprove(id: string) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const t = db.getTicket(id);
    if (!t) return;
    if (t.status === "awaiting_approval") {
      await approveAndExecute(id);
      return;
    }
    if (t.status === "resolved" || t.status === "escalated") return;
  }
}
