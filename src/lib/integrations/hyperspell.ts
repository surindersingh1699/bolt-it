import { UserContext } from "../types";

const MOCK_USERS: Record<string, UserContext> = {
  "alex@acme.test": {
    email: "alex@acme.test",
    name: "Alex Reyes",
    team: "design",
    recentApps: ["figma", "notion", "slack"],
  },
  "priya@acme.test": {
    email: "priya@acme.test",
    name: "Priya Shah",
    team: "engineering",
    recentApps: ["github", "linear", "datadog", "vpn"],
  },
  "jordan@acme.test": {
    email: "jordan@acme.test",
    name: "Jordan Lee",
    team: "sales",
    recentApps: ["salesforce", "outreach", "slack"],
  },
  "frank@acme.test": {
    email: "frank@acme.test",
    name: "Frank Adebayo",
    team: "finance",
    recentApps: ["netsuite", "excel", "vpn", "slack"],
    calendarBusyUntil: Date.now() + 20 * 60 * 1000,
  },
};

export async function getUserContext(email: string): Promise<UserContext | null> {
  return MOCK_USERS[email.toLowerCase()] ?? null;
}

export interface MemoryHit {
  title: string;
  summary: string;
  source: string;
  score: number;
  resourceId: string;
}

const HYPERSPELL_BASE = "https://api.hyperspell.com";

export async function queryMemories(query: string, userId?: string): Promise<MemoryHit[]> {
  const apiKey = process.env.HYPERSPELL_API_KEY;
  if (!apiKey) return [];
  const asUser = userId ?? process.env.HYPERSPELL_DEMO_USER_ID ?? "demo";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${HYPERSPELL_BASE}/memories/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-As-User": asUser,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[Hyperspell] query returned ${res.status}`);
      return [];
    }
    const data = (await res.json()) as {
      documents?: Array<{
        title?: string;
        summary?: string;
        source?: string;
        score?: number;
        resource_id?: string;
      }>;
    };
    const docs = data.documents ?? [];
    return docs
      .filter((d) => (d.score ?? 0) >= 0.15)
      .slice(0, 3)
      .map((d) => ({
        title: d.title ?? "(untitled)",
        summary: d.summary ?? "",
        source: d.source ?? "vault",
        score: d.score ?? 0,
        resourceId: d.resource_id ?? "",
      }));
  } catch (err) {
    console.warn("[Hyperspell] query threw:", (err as Error).message);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function addMemory(
  text: string,
  title: string,
  source: string,
  userId?: string,
): Promise<string | null> {
  const apiKey = process.env.HYPERSPELL_API_KEY;
  if (!apiKey) return null;
  const asUser = userId ?? process.env.HYPERSPELL_DEMO_USER_ID ?? "demo";
  try {
    const res = await fetch(`${HYPERSPELL_BASE}/memories/add`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-As-User": asUser,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, title, source }),
    });
    if (!res.ok) {
      console.warn(`[Hyperspell] add returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { resource_id?: string };
    return data.resource_id ?? null;
  } catch (err) {
    console.warn("[Hyperspell] add threw:", (err as Error).message);
    return null;
  }
}
