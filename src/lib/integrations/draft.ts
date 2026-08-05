// The drafting contract: what the planner is given, and what it must return.
// Kept separate from any one provider so the retrieval/LLM backend can change
// without touching the graph.

import { Citation, PlanStep } from "../types";
import { MemoryHit } from "./hyperspell";

export interface DraftInput {
  subject: string;
  body: string;
  reporter: string;
  reporterEmail: string;
  customerOrg: string;
  workspaceId?: string;
  memories?: MemoryHit[];
}

export interface DraftResult {
  citations: Citation[];
  confidence: number;
  reasoning: string;
  response: string;
  plan: PlanStep[];
  source: "ai-gateway" | "fallback";
}

export function memoriesAsContext(memories: MemoryHit[] | undefined): string {
  if (!memories || memories.length === 0) return "";
  const lines = memories.map(
    (m, i) => `[${i + 1}] (${m.source}, score ${m.score.toFixed(2)}) ${m.title}: ${m.summary}`,
  );
  return `\n\nRelevant context from the user's connected sources (Hyperspell memory search):\n${lines.join("\n")}\n`;
}

// The LLM proposes a step kind as a bare string; anything we don't recognise
// degrades to a user-visible message rather than an unknown action.
export function normalizeKind(k: string | undefined): PlanStep["kind"] {
  if (k === "insforge" || k === "aside" || k === "tensorlake" || k === "slack_reply") return k;
  return "slack_reply";
}
