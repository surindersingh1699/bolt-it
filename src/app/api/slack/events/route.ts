import { NextResponse } from "next/server";
import { createTicket } from "@/app/actions/tickets";
import { getWorkspaceBySlackTeamId } from "@/lib/data";
import { fetchSlackUserEmail, isSlackSigningConfigured, verifySlackRequest } from "@/lib/slack";

export const dynamic = "force-dynamic";

interface SlackEventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: {
    type?: string;
    user?: string;
    bot_id?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!isSlackSigningConfigured()) {
    return NextResponse.json({ error: "slack_signing_not_configured" }, { status: 501 });
  }
  const ok = await verifySlackRequest(req, raw);
  if (!ok) return NextResponse.json({ error: "bad_signature" }, { status: 401 });

  const payload = JSON.parse(raw) as SlackEventEnvelope;
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const event = payload.event;
  if (!event || event.bot_id || event.subtype) return NextResponse.json({ ok: true });
  if (event.type !== "message" && event.type !== "app_mention") {
    return NextResponse.json({ ok: true });
  }

  const teamId = payload.team_id;
  if (!teamId) return NextResponse.json({ error: "missing_team" }, { status: 400 });
  const workspace = await getWorkspaceBySlackTeamId(teamId);
  if (!workspace?.slackAccessToken) {
    return NextResponse.json({ error: "workspace_not_connected" }, { status: 404 });
  }

  const text = (event.text ?? "").replace(/<@[^>]+>/g, "").trim();
  if (!text) return NextResponse.json({ ok: true });

  const user = event.user
    ? await fetchSlackUserEmail(workspace.slackAccessToken, event.user)
    : {};
  const reporterEmail = user.email ?? `${event.user ?? "slack-user"}@slack.local`;
  const reporter = user.name ?? "Slack user";
  const subject = text.split(/[.\n!?]/)[0].slice(0, 90) || "Slack IT request";

  const ticketId = await createTicket({
    reporter,
    reporterEmail,
    subject,
    body: [
      text,
      "",
      `Slack channel: ${event.channel ?? "unknown"}`,
      `Slack thread: ${event.thread_ts ?? event.ts ?? "unknown"}`,
    ].join("\n"),
    channel: "slack",
    workspaceId: workspace.id,
  });

  return NextResponse.json({ ok: true, ticketId });
}
