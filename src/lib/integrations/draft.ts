// The drafting contract: what the planner is given, and what it must return.
// Kept separate from any one provider so the retrieval/LLM backend can change
// without touching the graph.

import { Citation, PlanStep } from "../types";
import { UserMemory } from "../memory";

export interface DraftInput {
  subject: string;
  body: string;
  reporter: string;
  reporterEmail: string;
  customerOrg: string;
  workspaceId?: string;
  memory?: UserMemory;
}

export interface DraftResult {
  citations: Citation[];
  confidence: number;
  reasoning: string;
  response: string;
  plan: PlanStep[];
  source: "ai-gateway" | "fallback";
}

// The LLM proposes a step kind as a bare string; anything we don't recognise
// degrades to a user-visible message rather than an unknown action.
export function normalizeKind(k: string | undefined): PlanStep["kind"] {
  if (k === "device" || k === "backend" || k === "reply") return k;
  return "reply";
}
