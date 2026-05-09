import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export const SLACK_OAUTH_AUTHORIZE = "https://slack.com/oauth/v2/authorize";
export const SLACK_OAUTH_ACCESS = "https://slack.com/api/oauth.v2.access";

export const SLACK_SCOPES = [
  "channels:history",
  "channels:read",
  "app_mentions:read",
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

export function isSlackSigningConfigured(): boolean {
  return Boolean(process.env.SLACK_SIGNING_SECRET);
}

export async function verifySlackRequest(req: Request, rawBody: string): Promise<boolean> {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return false;
  const timestamp = req.headers.get("x-slack-request-timestamp");
  const signature = req.headers.get("x-slack-signature");
  if (!timestamp || !signature) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac("sha256", secret).update(base).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function fetchSlackUserEmail(
  accessToken: string,
  userId: string,
): Promise<{ email?: string; name?: string }> {
  const url = new URL("https://slack.com/api/users.info");
  url.searchParams.set("user", userId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    ok?: boolean;
    user?: { real_name?: string; name?: string; profile?: { email?: string } };
  };
  if (!data.ok) return {};
  return {
    email: data.user?.profile?.email,
    name: data.user?.real_name ?? data.user?.name,
  };
}

export async function postSlackMessage(
  accessToken: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: threadTs,
    }),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: Boolean(data.ok), error: data.error };
}
