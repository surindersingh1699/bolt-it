import { getCurrentUser } from "./auth";
import { getWorkspace, insertWorkspace } from "./data";
import { Workspace } from "./types";

export const ACME_WORKSPACE_ID = "acme.test";

export function domainFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return email.toLowerCase();
  return email.slice(at + 1).toLowerCase();
}

export function workspaceDisplayNameForDomain(domain: string): string {
  const root = domain.split(".")[0] ?? domain;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

export async function ensureWorkspace(id: string, displayName: string): Promise<Workspace> {
  const existing = await getWorkspace(id);
  if (existing) return existing;
  const now = Date.now();
  const ws: Workspace = { id, displayName, createdAt: now, updatedAt: now };
  await insertWorkspace(ws);
  return ws;
}

/** The active workspace is the signed-in user's. There is no anonymous mode. */
export async function getCurrentWorkspaceId(): Promise<string | null> {
  const user = await getCurrentUser();
  return user?.workspaceId ?? null;
}
