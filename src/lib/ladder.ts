/**
 * The remediation ladder — what a real service desk does, in code.
 *
 * A technician handed five candidate fixes does not run five fixes. They start
 * with the cheapest reversible one, watch, and only climb if it did not help.
 * This system used to do the opposite: the strategist authorised up to six
 * steps, the operator dispatched four of them in one round, and `runNextStep`
 * drained the queue back to back. So a ticket that a `fix.restart_app` would
 * have settled also got its application cache cleared, which is not reversible
 * and takes the employee's local state with it — and afterwards nobody could
 * say which of the two had actually worked.
 *
 * Two separate things fix that, and both live outside any prompt:
 *
 *   1. ORDER — this file. A pure cost derived from the capability registry.
 *   2. ONE AT A TIME — `runNextStep` in ticket-graph.ts, which runs a single
 *      change per pass and then asks the employee.
 *
 * WHY THE COST IS DERIVED AND NOT ASKED FOR
 *
 * Every input is already a field on the `CapabilitySpec`: `risk`, `reversible`,
 * `blastRadius`, `requiresElevation`, `probe`. Asking a model to rank its own
 * fixes would put the ordering back in a prompt, where a confident ticket body
 * can argue with it — and the ordering is the whole safety property here. The
 * model contributes the one thing the registry cannot know: how likely THIS
 * fix is to be the answer for THIS ticket.
 *
 * So: cost decides the tier, likelihood breaks ties inside it. That is exactly
 * "start with the easy, reversible, common one" — cheap first, and among
 * equally cheap fixes, the one most likely to be the cause.
 */

import { PlanStep } from "./types";
import { capabilitySpec, isReadOnlyCapability } from "./capabilities";
import type { CapabilitySpec } from "./capabilities";

/** What a fix costs to try, if it turns out to be the wrong one. */
export const COST = {
  /** Undoing it is free and automatic. */
  reversible: { self: 0, recorded: 2, none: 5 },
  /** Who else notices if this was the wrong call. */
  blast: { device: 0, "user-session": 1, directory: 3 },
  /** Needs admin rights, so it is not a thing to try casually. */
  elevation: 1,
} as const;

/**
 * What it costs to be wrong about this capability. Higher sorts later.
 *
 * Reads are 0 and always run first: they are free, reversible, and they are the
 * evidence the fixes are chosen against.
 */
export function remediationCost(capability: string | undefined): number {
  if (isReadOnlyCapability(capability)) return 0;
  const spec = capabilitySpec(capability);
  // No spec means no idea what this costs. It never executes — `capabilityAllowed`
  // rejects it upstream — but if it ever reached a queue it must not be the thing
  // that goes first.
  if (!spec) return Number.MAX_SAFE_INTEGER;
  return costOf(spec);
}

function costOf(spec: CapabilitySpec): number {
  return (
    spec.risk * 2 +
    COST.reversible[spec.reversible] +
    COST.blast[spec.blastRadius] +
    (spec.requiresElevation ? COST.elevation : 0)
  );
}

/**
 * A change whose result cannot be proved, which is a reason to try it later
 * rather than a reason to think it dangerous.
 *
 * Kept OUT of the cost above and applied as a tiebreak instead, because a
 * missing probe is not always a defect: `fix.flush_dns` has none on purpose —
 * a flushed cache has no diffable before/after fact and repopulates
 * immediately. Charged as cost it would push the cheapest, most reversible,
 * most common network fix in the building behind rewriting the machine's
 * resolvers, which is precisely backwards. As a tiebreak it only ever separates
 * two changes that are already equally safe to be wrong about.
 */
function unverifiable(capability: string | undefined): number {
  const spec = capabilitySpec(capability);
  return spec && spec.risk > 0 && spec.probe === null ? 1 : 0;
}

/** The strategist's belief when it did not state one. Neutral, so cost decides. */
export const DEFAULT_LIKELIHOOD = 0.5;

/**
 * Put a round's steps into the order they should actually be attempted.
 *
 * Reads first, then changes cheapest-first, then most-likely-first within a
 * tier. `likelihoods` comes from the strategist's authorisation, keyed by
 * capability: the operator re-emits steps with real parameters bound and does
 * not carry the belief across, so it is looked up rather than read off the step.
 *
 * Stable: two steps that tie on every key keep the order they arrived in.
 */
export function rankRemediations(
  steps: PlanStep[],
  likelihoods: Map<string, number> = new Map(),
): PlanStep[] {
  return steps
    .map((step, index) => ({
      step,
      index,
      cost: remediationCost(step.capability),
      unprovable: unverifiable(step.capability),
      likelihood:
        step.likelihood ??
        (step.capability ? likelihoods.get(step.capability) : undefined) ??
        DEFAULT_LIKELIHOOD,
    }))
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        a.unprovable - b.unprovable ||
        b.likelihood - a.likelihood ||
        a.index - b.index,
    )
    .map((r) => r.step);
}

/** Belief per capability, as the strategist authorised it. */
export function likelihoodsFrom(authorized: PlanStep[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const step of authorized) {
    if (step.capability && typeof step.likelihood === "number") {
      out.set(step.capability, step.likelihood);
    }
  }
  return out;
}

/**
 * Is this step a change, i.e. a rung of the ladder rather than a look?
 *
 * `risk === 0` IS read-only in the registry — derived, never a second list — so
 * this asks the same question `authorizeOperatorSteps` asks, and the two can
 * never drift into disagreeing about what counts as a change.
 */
export function isRemediation(step: PlanStep): boolean {
  return step.kind !== "reply" && !isReadOnlyCapability(step.capability);
}

/** How many rungs are still untried on this ticket. */
export function rungsRemaining(plan: PlanStep[]): number {
  return plan.filter((s) => s.status === "pending" && isRemediation(s)).length;
}
