import { cookies } from "next/headers";
import { getADAccount, getADUser, updateADAccount } from "./data";
import { ADAccount, ADUser, PublicUser, Session } from "./types";
import { verifyPassword } from "./password";

const COOKIE_NAME = "it_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();

function getSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  return "dev-only-it-support-agent-session-secret-do-not-use-in-prod";
}

function bytesToB64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  const b64 = typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64Url(s: string): string {
  return bytesToB64Url(enc.encode(s));
}

function b64UrlToStr(b64: string): string {
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const std = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = typeof atob === "function" ? atob(std) : Buffer.from(std, "base64").toString("binary");
  let out = "";
  for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i));
  return out;
}

async function hmacSign(payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return bytesToB64Url(new Uint8Array(sig));
}

async function encodeSession(session: Session): Promise<string> {
  const payload = strToB64Url(JSON.stringify(session));
  const sig = await hmacSign(payload);
  return `${payload}.${sig}`;
}

async function decodeSession(token: string): Promise<Session | null> {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = await hmacSign(payload);
  if (expected !== sig) return null;
  try {
    const raw = b64UrlToStr(payload);
    const parsed = JSON.parse(raw) as Session;
    if (typeof parsed?.userEmail !== "string") return null;
    if (typeof parsed?.expiresAt !== "number") return null;
    if (parsed.expiresAt < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function toPublic(user: ADUser): PublicUser {
  return {
    email: user.email,
    workspaceId: user.workspaceId,
    name: user.name,
    team: user.team,
    title: user.title,
    isITStaff: user.isITStaff,
  };
}

export async function setSessionCookie(userEmail: string, workspaceId: string): Promise<void> {
  const now = Date.now();
  const session: Session = {
    userEmail,
    workspaceId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
  const token = await encodeSession(session);
  const jar = await cookies();
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_NAME);
}

export async function getCurrentSession(): Promise<Session | null> {
  const jar = await cookies();
  const cookie = jar.get(COOKIE_NAME);
  if (!cookie?.value) return null;
  return decodeSession(cookie.value);
}

export async function getCurrentUser(): Promise<PublicUser | null> {
  const session = await getCurrentSession();
  if (!session) return null;
  const user = await getADUser(session.userEmail, session.workspaceId);
  return user ? toPublic(user) : null;
}

export async function requireITStaff(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("not_authenticated");
  if (!user.isITStaff) throw new Error("not_authorized");
  return user;
}

export type LoginFailure =
  | "bad_credentials"
  | "account_locked"
  | "account_disabled"
  | "password_expired"
  | "stale_kerberos";

export interface LoginAttemptResult {
  ok: boolean;
  user?: PublicUser;
  failure?: LoginFailure;
  account?: ADAccount;
}

export async function attemptLogin(email: string, password: string): Promise<LoginAttemptResult> {
  const user = await getADUser(email.toLowerCase().trim());
  const account = user ? await getADAccount(user.email) : undefined;
  if (!user || !account) return { ok: false, failure: "bad_credentials" };

  if (account.status === "disabled") return { ok: false, failure: "account_disabled", account };
  if (account.status === "locked") return { ok: false, failure: "account_locked", account };
  if (account.status === "password_expired") {
    return { ok: false, failure: "password_expired", account };
  }
  if (account.status === "stale_kerberos") {
    return { ok: false, failure: "stale_kerberos", account };
  }

  const passwordOk = await verifyPassword(password, user.passwordHash);
  if (!passwordOk) {
    const next = account.failedLoginCount + 1;
    if (next >= 5) {
      await updateADAccount(user.email, {
        failedLoginCount: next,
        status: "locked",
        lockedAt: Date.now(),
      });
      return { ok: false, failure: "account_locked", account: { ...account, status: "locked" } };
    }
    await updateADAccount(user.email, { failedLoginCount: next });
    return { ok: false, failure: "bad_credentials" };
  }

  await updateADAccount(user.email, {
    failedLoginCount: 0,
    lastLoginAt: Date.now(),
    lastLoginHost: account.lastLoginHost ?? "web",
  });
  return { ok: true, user: toPublic(user) };
}

export const sessionConstants = { COOKIE_NAME, SESSION_TTL_MS };
