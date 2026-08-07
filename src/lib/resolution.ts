/**
 * The honesty check that survives merging diagnosis and verification.
 *
 * There used to be a separate verifier on a deliberately different model from
 * the planner, for one reason: a model that grades its own work declares
 * resolved=true on nothing, and resolved=true is what tells an employee their
 * problem is fixed. The strategist now does both jobs, so that guarantee had to
 * come from somewhere else.
 *
 * It comes from here, and this is strictly stronger than a second model. A
 * prompt can be argued out of its position — by a confident-sounding log line,
 * by the ticket body, by the model's own momentum. An `if` cannot. The
 * strategist's `resolved` is DATA; whether the ticket actually finishes is the
 * graph's decision, made against what the machine reported.
 *
 * Deliberately NOT "there must be a VERIFIED CHANGE". A question ticket — "what
 * is my hostname?" — is resolved by a read that changes nothing, and demanding
 * a mutation would make every such ticket permanently unresolvable. The bar is
 * that something ran and something worked.
 */

import type { ReplyEvidence } from "./integrations/ai-gateway";

export interface ResolutionCheck {
  ok: boolean;
  /** Why it was refused, phrased to drop straight into the findings. */
  why?: string;
}

export function resolutionSupported(evidence: ReplyEvidence[]): ResolutionCheck {
  if (evidence.length === 0) {
    return { ok: false, why: "nothing has been executed on this ticket yet" };
  }

  const succeeded = evidence.filter((e) => e.status === "succeeded");
  if (succeeded.length === 0) {
    return {
      ok: false,
      why: "every step on this ticket failed or left the machine unchanged",
    };
  }

  return { ok: true };
}
