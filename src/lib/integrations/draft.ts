// The drafting contract: what the planner is given, and what it must return.
// Kept separate from any one provider so the retrieval/LLM backend can change
// without touching the graph.

import { Citation, PlanStep } from "../types";
import { UserMemory } from "../memory";
import { Tier } from "../tiers";
import { IncidentStats } from "../incidents";

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
  /**
   * Track record for this class of problem across everyone, computed from
   * before/after device evidence. This is what a planner should reach for
   * first — it is the only signal in the prompt grounded in outcomes rather
   * than in anyone's estimate.
   */
  incidents?: IncidentStats;
  /** Which ticket to bill this call to, for the cost breakdown. */
  ticketId?: string;
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
  /**
   * Competing explanations this tier formed and discarded, each with what ruled
   * it out. Not chain of thought — a decision record. The next tier reads it to
   * avoid re-testing dead ends, and it is the most useful thing in the handoff
   * artifact, because it tells a technician where NOT to start.
   */
  rejectedHypotheses: RejectedHypothesis[];
  /** Capability ids the tier weighed, including ones it decided against. */
  capabilitiesConsidered: string[];
  /**
   * A fix the tier needed and did not have. Recorded and surfaced for review — a
   * write capability cannot be registered at runtime, because a handler with no
   * probe produces no before/after facts and so can never be verified. See
   * docs/TIERS.md.
   */
  capabilityRequest: CapabilityRequest | null;
}

export interface RejectedHypothesis {
  hypothesis: string;
  /** The observation that killed it, or "not tested" when it was reasoned away. */
  ruledOutBy: string;
}

export interface CapabilityRequest {
  name: string;
  kind: string;
  /** Which hypothesis this would resolve — the purpose, in the tier's words. */
  why: string;
  command: string;
  probeFields: string[];
  expectsChange: boolean;
  reversible: string;
  /** The tier's own read of the blast radius. Advisory: the reviewer still rules. */
  risk: "low" | "medium" | "high";
  /** What the machine should look like afterwards, if it works. */
  expectedEffect: string;
}

// The LLM proposes a step kind as a bare string; anything we don't recognise
// degrades to a user-visible message rather than an unknown action.
export function normalizeKind(k: string | undefined): PlanStep["kind"] {
  if (k === "device" || k === "backend" || k === "knowledge" || k === "reply") return k;
  return "reply";
}
