// The drafting contract: what the planner is given, and what it must return.
// Kept separate from any one provider so the retrieval/LLM backend can change
// without touching the graph.

import { Citation, PlanStep } from "../types";
import { UserMemory } from "../memory";
import { Tier } from "../tiers";

export interface DraftInput {
  subject: string;
  body: string;
  reporter: string;
  reporterEmail: string;
  customerOrg: string;
  workspaceId?: string;
  memory?: UserMemory;
  /** Which tier is drafting: picks the model, the prompt and the capability set. */
  tier: Tier;
  /** What shallower tiers already tried and concluded, so a tier never repeats them. */
  priorFindings?: string[];
}

export interface DraftResult {
  citations: Citation[];
  confidence: number;
  reasoning: string;
  /**
   * The tier's `customer_summary` — a plain statement of what it found, written
   * as fact rather than as a message. Tiers do not address the employee; the
   * service desk relays this.
   */
  response: string;
  plan: PlanStep[];
  source: "ai-gateway" | "fallback";
  tier: Tier;
  /** The tier declined the problem: hand it to the next one down. */
  escalate: boolean;
  escalateReason: string;
  /** One line: what this tier believes is actually wrong. */
  hypothesis: string;
}

// The LLM proposes a step kind as a bare string; anything we don't recognise
// degrades to a user-visible message rather than an unknown action.
export function normalizeKind(k: string | undefined): PlanStep["kind"] {
  if (k === "device" || k === "backend" || k === "knowledge" || k === "reply") return k;
  return "reply";
}
