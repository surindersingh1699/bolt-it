import { randomBytes } from "crypto";

export const SLACK_OAUTH_AUTHORIZE = "https://slack.com/oauth/v2/authorize";
export const SLACK_OAUTH_ACCESS = "https://slack.com/api/oauth.v2.access";

export const SLACK_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "users:read",
  "users:read.email",
].join(",");

export function isSlackOAuthConfigured(): boolean {
  return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
}

export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const u = new URL(SLACK_OAUTH_AUTHORIZE);
  u.searchParams.set("client_id", process.env.SLACK_CLIENT_ID!);
  u.searchParams.set("scope", SLACK_SCOPES);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  return u.toString();
}

export interface SlackOAuthExchange {
  ok: boolean;
  teamId?: string;
  teamName?: string;
  accessToken?: string;
  error?: string;
}

export async function exchangeSlackCode(
  code: string,
  redirectUri: string,
): Promise<SlackOAuthExchange> {
  const body = new URLSearchParams({
    code,
    client_id: process.env.SLACK_CLIENT_ID!,
    client_secret: process.env.SLACK_CLIENT_SECRET!,
    redirect_uri: redirectUri,
  });
  try {
    const res = await fetch(SLACK_OAUTH_ACCESS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      access_token?: string;
      team?: { id?: string; name?: string };
    };
    if (!data.ok) return { ok: false, error: data.error ?? "unknown_error" };
    return {
      ok: true,
      teamId: data.team?.id,
      teamName: data.team?.name,
      accessToken: data.access_token,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function mintOAuthState(): string {
  return randomBytes(16).toString("hex");
}
