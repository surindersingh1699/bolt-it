import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { getCurrentUser } from "./auth";
import { ensureSeeded } from "./seed";
import { getWorkspace, insertWorkspace, touchWorkspace } from "./data";
import { Workspace } from "./types";

export const ACME_WORKSPACE_ID = "acme.test";
export const DEMO_COOKIE = "it_demo_workspace";
const DEMO_COOKIE_TTL_S = 60 * 60 * 24;

export function domainFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email.toLowerCase();
  return email.slice(at + 1).toLowerCase();
}

export function workspaceDisplayNameForDomain(domain: string): string {
  const root = domain.split(".")[0] ?? domain;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

export function mintDemoWorkspaceId(): string {
  return `demo-${randomBytes(8).toString("hex")}`;
}

export async function ensureWorkspace(
  id: string,
  displayName: string,
  isDemo: boolean,
): Promise<Workspace> {
  const existing = await getWorkspace(id);
  if (existing) return existing;
  const now = Date.now();
  const ws: Workspace = { id, displayName, isDemo, createdAt: now, updatedAt: now };
  await insertWorkspace(ws);
  return ws;
}

/**
 * Resolve the active workspace for the current request:
 *   1. If user is logged in → session.workspaceId.
 *   2. Else if `it_demo_workspace` cookie present → that demo workspace.
 *   3. Else → null.
 */
export async function getCurrentWorkspaceId(): Promise<string | null> {
  const user = await getCurrentUser();
  if (user) return user.workspaceId;
  const c = await cookies();
  const demo = c.get(DEMO_COOKIE);
  return demo?.value ?? null;
}

export async function getOrMintDemoWorkspaceId(): Promise<string> {
  const c = await cookies();
  const existing = c.get(DEMO_COOKIE);
  if (existing?.value) {
    // Refresh last_used_at so the cleanup cron skips active demos.
    await touchWorkspace(existing.value).catch(() => undefined);
    return existing.value;
  }
  const id = mintDemoWorkspaceId();
  c.set(DEMO_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: DEMO_COOKIE_TTL_S,
  });
  await ensureSeeded();
  await ensureWorkspace(id, "Demo workspace", true);
  return id;
}

export async function clearDemoCookie(): Promise<void> {
  const c = await cookies();
  c.delete(DEMO_COOKIE);
}
