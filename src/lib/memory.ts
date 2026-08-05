/**
 * Per-user memory: the durable facts an experienced helpdesk person would just
 * know about someone ("goes by Frankie", "London office", "uses Outlook, not
 * Mail"), plus a short history of what we last helped them with.
 *
 * Two kinds, deliberately:
 *  - facts    — small, keyed, overwritten in place. "What is true about them."
 *  - episodes — one line per ticket, append-only, last N read back. "What happened."
 *
 * Stored in the same database as everything else. No vector index, no second
 * memory system: the fact set per user is tiny, so we hand all of it to the
 * model and let it decide what matters.
 */

export type MemoryKind = "fact" | "episode";

export interface UserFact {
  key: string;
  value: string;
  updatedAt: number;
}

export interface UserEpisode {
  ticketId: string;
  summary: string;
  at: number;
}

export interface UserMemory {
  facts: UserFact[];
  episodes: UserEpisode[];
}

export const EMPTY_MEMORY: UserMemory = { facts: [], episodes: [] };

/** How many past tickets the planner sees. Recent beats exhaustive. */
export const EPISODE_WINDOW = 5;

/**
 * Keys we let the extractor write. A closed set keeps memory from turning into
 * a junk drawer of one-off strings that never match anything later.
 */
export const FACT_KEYS = [
  "nickname",
  "office",
  "timezone",
  "role",
  "device",
  "primary_apps",
  "preference",
  "constraint",
] as const;

export type FactKey = (typeof FACT_KEYS)[number];

export function isFactKey(k: string): k is FactKey {
  return (FACT_KEYS as readonly string[]).includes(k);
}

/** Renders memory for an LLM prompt. Empty memory renders as nothing at all. */
export function memoryAsContext(memory: UserMemory | null): string {
  if (!memory) return "";
  const parts: string[] = [];
  if (memory.facts.length > 0) {
    parts.push(
      `What we know about this person:\n${memory.facts.map((f) => `- ${f.key}: ${f.value}`).join("\n")}`,
    );
  }
  if (memory.episodes.length > 0) {
    parts.push(
      `Recent history with them (newest first):\n${memory.episodes
        .map((e) => `- ${new Date(e.at).toISOString().slice(0, 10)} (${e.ticketId}): ${e.summary}`)
        .join("\n")}`,
    );
  }
  return parts.length > 0 ? `\n\n## Memory\n${parts.join("\n\n")}\n` : "";
}

/** Address them the way they asked to be addressed, if we know. */
export function preferredName(memory: UserMemory | null, fallbackFirstName: string): string {
  return memory?.facts.find((f) => f.key === "nickname")?.value || fallbackFirstName;
}
