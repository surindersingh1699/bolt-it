/**
 * What happens when the machine refuses a read.
 *
 * A device agent can say no to a step for exactly two kinds of reason, and they
 * are not the same problem:
 *
 *   - "this binary is off by default" — a DECISION is missing. The agent would
 *     run it for a named ticket if somebody, or some policy, said so.
 *   - "this binary is not on the read-only list at all" — a CAPABILITY is
 *     missing. No decision changes that; it is a code change, and it surfaces as
 *     the strategist's `capability_request` so a human can decide to build it.
 *
 * Before this module the first case had one answer — park the ticket on a human
 * approval — and that answer was wrong at `AUTONOMY=full`, where nobody is
 * watching the queue. T-2384 sat on "approve `netsh winhttp show proxy`" for
 * thirteen hours; T-4935 gave up and went to a person. Both were read-only
 * diagnostics on the reporter's own machine.
 *
 * So the decision lives here, once, and both callers use it: the graph's
 * automatic path and the technician's click path. Adding a new grantable
 * diagnostic in future is a record on the agent's `GRANTABLE_BINARIES` table and
 * nothing else — no new branch in the graph, no second copy of this rule.
 *
 * What a grant is NOT, on any rung:
 *   - it does not widen WHAT may run, only WHICH already-read-only binary;
 *   - the binary must still be on the agent's curated grantable list — a grant
 *     naming anything else buys nothing, because the agent checks the list
 *     again with the grant in hand;
 *   - every subcommand and argument filter still applies (`dscacheutil
 *     -flushcache` stays refused with the grant held);
 *   - it is scoped to one ticket, and it travels on the job rather than in the
 *     command string, so nothing a model composes can forge one.
 */

import { isFullyAutonomous } from "./autonomy";
import type { PlanStep } from "./types";

/**
 * The binary a refused step was asking for, or null when this step is not a
 * grant question at all.
 *
 * Read from the step's own params rather than parsed back out of the failure
 * text: `executors.ts` already matched the agent's `GRANTABLE:<binary>:` marker
 * to produce `capability_missing`, and re-parsing prose is how a message change
 * silently turns a grant into a dead end.
 */
export function grantableBinaryOf(step: PlanStep): string | null {
  if (step.failure?.kind !== "capability_missing") return null;
  return step.failure.grantableBinary ?? null;
}

export type GrantDecision =
  | { kind: "auto"; binary: string; note: string }
  | { kind: "ask_human"; binary: string }
  /** Approved already, and refused anyway. Asking again cannot change it. */
  | { kind: "spent"; binary: string }
  | { kind: "not_a_grant" };

/**
 * Who decides, on this rung.
 *
 * `full` means nothing waits for a person except what policy marks
 * non-bypassable, and a read-only diagnostic is not on that list — it changes
 * nothing, it is reversible by definition, and its blast radius is one machine
 * the employee already asked us to look at. Every rung below `full` keeps the
 * human click, which is the point of having rungs at all.
 */
export function decideGrant(step: PlanStep, alreadyGranted: string[] = []): GrantDecision {
  const binary = grantableBinaryOf(step);
  if (!binary) return { kind: "not_a_grant" };

  // The gate is asked once per binary per ticket, and never again.
  //
  // T-4935 asked four times: the approval was recorded, the grant never reached
  // the device (the job's `granted_binaries` had no column to survive in), the
  // agent refused identically, and the graph parked on the same approval. From
  // the technician's side that is a button that does nothing, forever. Whatever
  // the underlying cause, a second ask cannot be the answer to a refusal that
  // came back WITH the approval already in hand.
  if (alreadyGranted.includes(binary)) return { kind: "spent", binary };

  if (!isFullyAutonomous()) return { kind: "ask_human", binary };
  return {
    kind: "auto",
    binary,
    note:
      `${binary} enabled for this ticket under AUTONOMY=full — read-only, on the agent's grantable ` +
      `list, every argument filter still applies`,
  };
}

/** Add a binary to a ticket's grants without duplicating one already there. */
export function withGrant(granted: string[] | undefined, binary: string): string[] {
  const already = granted ?? [];
  return already.includes(binary) ? already : [...already, binary];
}
