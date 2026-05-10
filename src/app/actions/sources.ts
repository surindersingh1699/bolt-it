"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspace, updateWorkspace } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { ACME_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace";
import {
  detectSourceType,
  niaApiSourceToStatus,
  niaCreateSource,
  niaDeleteSource,
  niaGetSource,
} from "@/lib/integrations/nia-sources";
import { NiaSource } from "@/lib/types";

const ConnectInputSchema = z.object({
  url: z.string().min(3).max(500).trim(),
});

function safeRevalidate(path: string): void {
  try {
    revalidatePath(path);
  } catch {
    // ignore — client polls /api/state
  }
}

async function loadWorkspaceOrThrow(): Promise<{ id: string; sources: NiaSource[] }> {
  const requestingUser = await getCurrentUser();
  if (!requestingUser?.isITStaff) {
    throw new Error("Only IT staff can manage Nia sources.");
  }
  const workspaceId = (await getCurrentWorkspaceId()) ?? ACME_WORKSPACE_ID;
  const ws = await getWorkspace(workspaceId);
  if (!ws) throw new Error("Workspace not found");
  return { id: workspaceId, sources: ws.niaSources ?? [] };
}

export async function connectNiaSource(input: { url: string }): Promise<{
  ok: boolean;
  error?: string;
  source?: NiaSource;
}> {
  const parsed = ConnectInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid URL" };
  }

  const { id: workspaceId, sources } = await loadWorkspaceOrThrow();
  const { type, identifier } = detectSourceType(parsed.data.url);

  if (sources.some((s) => s.identifier === identifier)) {
    return { ok: false, error: "That source is already connected" };
  }

  const api = await niaCreateSource({ type, url: parsed.data.url, identifier });
  if (!api) {
    return { ok: false, error: "Nia rejected the source — check the URL and your NIA_API_KEY" };
  }

  const now = Date.now();
  const source: NiaSource = {
    id: api.id,
    identifier: api.identifier ?? identifier,
    displayName: api.display_name ?? identifier,
    type,
    status: niaApiSourceToStatus(api),
    url: parsed.data.url,
    addedAt: now,
    updatedAt: now,
  };

  await updateWorkspace(workspaceId, { niaSources: [...sources, source] });
  safeRevalidate("/");
  return { ok: true, source };
}

export async function refreshNiaSourceStatuses(): Promise<{ updated: number }> {
  const { id: workspaceId, sources } = await loadWorkspaceOrThrow();
  if (sources.length === 0) return { updated: 0 };

  const now = Date.now();
  let changed = 0;
  const updated: NiaSource[] = [];
  for (const s of sources) {
    if (s.status !== "indexing") {
      updated.push(s);
      continue;
    }
    const api = await niaGetSource(s.id);
    if (!api) {
      updated.push(s);
      continue;
    }
    const newStatus = niaApiSourceToStatus(api);
    if (newStatus !== s.status) changed++;
    updated.push({
      ...s,
      status: newStatus,
      displayName: api.display_name ?? s.displayName,
      errorMessage: api.error_message ?? s.errorMessage,
      updatedAt: now,
    });
  }

  if (changed > 0) {
    await updateWorkspace(workspaceId, { niaSources: updated });
    safeRevalidate("/");
  }
  return { updated: changed };
}

export async function disconnectNiaSource(sourceId: string): Promise<{ ok: boolean }> {
  const { id: workspaceId, sources } = await loadWorkspaceOrThrow();
  const target = sources.find((s) => s.id === sourceId);
  if (!target) return { ok: true };

  await niaDeleteSource(sourceId).catch(() => false);
  const next = sources.filter((s) => s.id !== sourceId);
  await updateWorkspace(workspaceId, { niaSources: next });
  safeRevalidate("/");
  return { ok: true };
}
