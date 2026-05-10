import { NiaSourceStatus, NiaSourceType } from "../types";

const NIA_API_URL = process.env.NIA_API_URL || "https://apigcp.trynia.ai/v2";

interface NiaApiSource {
  id: string;
  type: NiaSourceType | string;
  display_name?: string;
  status?: string;
  identifier?: string;
  error_message?: string;
}

export interface NiaCreateInput {
  type: NiaSourceType;
  url: string;
  identifier?: string;
}

function authHeaders(): Record<string, string> | null {
  const key = process.env.NIA_API_KEY;
  if (!key) return null;
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

function normalizeStatus(s: string | undefined): NiaSourceStatus {
  if (!s) return "indexing";
  const lower = s.toLowerCase();
  if (lower === "ready" || lower === "indexed" || lower === "completed") return "ready";
  if (lower === "failed" || lower === "error") return "failed";
  return "indexing";
}

export function detectSourceType(url: string): { type: NiaSourceType; identifier: string } {
  const trimmed = url.trim();
  const ghMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (ghMatch) {
    const repo = ghMatch[2].replace(/\.git$/i, "");
    return { type: "repository", identifier: `${ghMatch[1]}/${repo}` };
  }
  const shorthandMatch = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthandMatch && !trimmed.includes(" ")) {
    return { type: "repository", identifier: trimmed };
  }
  return { type: "documentation", identifier: trimmed };
}

export async function niaCreateSource(input: NiaCreateInput): Promise<NiaApiSource | null> {
  const headers = authHeaders();
  if (!headers) {
    console.warn("[NiaSources] NIA_API_KEY not set — cannot create source");
    return null;
  }

  const body =
    input.type === "repository"
      ? { type: "repository", repository: input.identifier ?? input.url }
      : { type: "documentation", url: input.url };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${NIA_API_URL}/sources`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[NiaSources] create failed ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    return (await res.json()) as NiaApiSource;
  } catch (err) {
    console.warn("[NiaSources] create threw:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function niaGetSource(id: string): Promise<NiaApiSource | null> {
  const headers = authHeaders();
  if (!headers) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${NIA_API_URL}/sources/${encodeURIComponent(id)}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[NiaSources] get ${id} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as NiaApiSource;
  } catch (err) {
    console.warn("[NiaSources] get threw:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function niaDeleteSource(id: string): Promise<boolean> {
  const headers = authHeaders();
  if (!headers) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${NIA_API_URL}/sources/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
      signal: controller.signal,
    });
    if (!res.ok && res.status !== 404) {
      console.warn(`[NiaSources] delete ${id} returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[NiaSources] delete threw:", (err as Error).message);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function niaApiSourceToStatus(api: NiaApiSource): NiaSourceStatus {
  return normalizeStatus(api.status);
}
