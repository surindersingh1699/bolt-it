import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DEMO_COOKIE, getCurrentWorkspaceId } from "@/lib/workspace";
import { updateWorkspace } from "@/lib/data";
import { buildAuthorizeUrl, isSlackOAuthConfigured, mintOAuthState } from "@/lib/slack";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "slack_oauth_state";
const RETURN_COOKIE = "slack_install_return";

async function resolveReturnPath(): Promise<"/app" | "/demo"> {
  const user = await getCurrentUser();
  if (user) return "/app";
  const c = await cookies();
  return c.get(DEMO_COOKIE)?.value ? "/demo" : "/app";
}

export async function GET(req: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.redirect(new URL("/login?next=/app", req.url));
  }

  const returnPath = await resolveReturnPath();

  // Mock-first: if Slack isn't configured (no client id/secret), persist a fake
  // team and bounce the user back to where they started.
  if (!isSlackOAuthConfigured()) {
    await updateWorkspace(workspaceId, {
      slackTeamId: `T_MOCK_${workspaceId.slice(0, 8).toUpperCase()}`,
      slackTeamName: "Mock Slack Workspace",
      slackAccessToken: "xoxb-mock-not-a-real-token",
      slackConnectedAt: Date.now(),
    });
    return NextResponse.redirect(new URL(`${returnPath}?slack=mock`, req.url));
  }

  const state = mintOAuthState();
  const c = await cookies();
  c.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  c.set(RETURN_COOKIE, returnPath, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  const redirectUri = new URL("/api/slack/callback", req.url).toString();
  return NextResponse.redirect(buildAuthorizeUrl(state, redirectUri));
}
