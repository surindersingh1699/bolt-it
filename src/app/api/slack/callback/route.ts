import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DEMO_COOKIE, getCurrentWorkspaceId } from "@/lib/workspace";
import { updateWorkspace } from "@/lib/data";
import { exchangeSlackCode, isSlackOAuthConfigured } from "@/lib/slack";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "slack_oauth_state";
const RETURN_COOKIE = "slack_install_return";

async function resolveReturnPath(): Promise<"/app" | "/demo"> {
  const c = await cookies();
  const stored = c.get(RETURN_COOKIE)?.value;
  if (stored === "/demo" || stored === "/app") return stored;
  const user = await getCurrentUser();
  if (user) return "/app";
  return c.get(DEMO_COOKIE)?.value ? "/demo" : "/app";
}

export async function GET(req: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.redirect(new URL("/login", req.url));
  const returnPath = await resolveReturnPath();
  if (!isSlackOAuthConfigured()) {
    return NextResponse.redirect(new URL(`${returnPath}?slack=not_configured`, req.url));
  }

  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const slackError = url.searchParams.get("error");
  if (slackError) {
    return NextResponse.redirect(new URL(`${returnPath}?slack=denied&detail=${slackError}`, req.url));
  }
  if (!code) {
    return NextResponse.redirect(new URL(`${returnPath}?slack=missing_code`, req.url));
  }

  const c = await cookies();
  const expectedState = c.get(STATE_COOKIE)?.value;
  if (!expectedState || expectedState !== state) {
    return NextResponse.redirect(new URL(`${returnPath}?slack=bad_state`, req.url));
  }
  c.delete(STATE_COOKIE);
  c.delete(RETURN_COOKIE);

  const redirectUri = new URL("/api/slack/callback", req.url).toString();
  const exchange = await exchangeSlackCode(code, redirectUri);
  if (!exchange.ok) {
    return NextResponse.redirect(
      new URL(`${returnPath}?slack=exchange_failed&detail=${exchange.error}`, req.url),
    );
  }

  await updateWorkspace(workspaceId, {
    slackTeamId: exchange.teamId,
    slackTeamName: exchange.teamName,
    slackAccessToken: exchange.accessToken,
    slackConnectedAt: Date.now(),
  });
  return NextResponse.redirect(new URL(`${returnPath}?slack=connected`, req.url));
}
