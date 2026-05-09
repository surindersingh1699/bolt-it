import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getCurrentWorkspaceId } from "@/lib/workspace";
import { updateWorkspace } from "@/lib/data";
import { exchangeSlackCode, isSlackOAuthConfigured } from "@/lib/slack";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "slack_oauth_state";

export async function GET(req: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.redirect(new URL("/login", req.url));
  if (!isSlackOAuthConfigured()) {
    return NextResponse.redirect(new URL("/app?slack=not_configured", req.url));
  }

  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const slackError = url.searchParams.get("error");
  if (slackError) {
    return NextResponse.redirect(new URL(`/app?slack=denied&detail=${slackError}`, req.url));
  }
  if (!code) {
    return NextResponse.redirect(new URL("/app?slack=missing_code", req.url));
  }

  const c = await cookies();
  const expectedState = c.get(STATE_COOKIE)?.value;
  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(new URL("/app?slack=bad_state", req.url));
  }
  c.delete(STATE_COOKIE);

  const redirectUri = new URL("/api/slack/callback", req.url).toString();
  const exchange = await exchangeSlackCode(code, redirectUri);
  if (!exchange.ok) {
    return NextResponse.redirect(
      new URL(`/app?slack=exchange_failed&detail=${exchange.error}`, req.url),
    );
  }

  await updateWorkspace(workspaceId, {
    slackTeamId: exchange.teamId,
    slackTeamName: exchange.teamName,
    slackAccessToken: exchange.accessToken,
    slackConnectedAt: Date.now(),
  });
  return NextResponse.redirect(new URL("/app?slack=connected", req.url));
}
