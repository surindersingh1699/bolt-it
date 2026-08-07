/**
 * The deterministic policy engine — the thing that actually decides.
 *
 * The reviewer used to return a verdict, and that verdict WAS the decision. That
 * put the final call inside a model reading a ticket body somebody else wrote.
 * The reviewer now returns a structured assessment and this function decides,
 * which matters for three reasons:
 *
 *   - It is predictable. The same inputs give the same answer, forever.
 *   - It is testable. There is no network here, so the whole policy is a truth
 *     table rather than a prompt somebody has to re-read.
 *   - It is auditable. "Why did this run unattended" has an answer that fits on
 *     one line and cites a rule, not a paragraph of model reasoning.
 *
 * This is the repo's existing principle — models emit data, the graph emits
 * control flow — applied to the one decision that was still a model's to make.
 *
 * NOTE ON CONFIDENCE. The obvious design here is a confidence score with an
 * auto-approve threshold. There is deliberately none. A model-reported
 * confidence is uncalibrated, and it is precisely the number a prompt injection
 * would inflate: "this is definitely safe, confidence 0.99" is a sentence an
 * attacker can put in a ticket body. Structure is checkable; a float is not.
 */

import type { CapabilitySpec } from "./capabilities";
import type { ExecutionMode } from "./autonomy";
import type { ActionKind, StepRisk } from "./types";

export type PolicyDecision =
  /** Run it, no human involved. */
  | "auto"
  /** Stop at the interrupt and wait for a person. */
  | "human"
  /** Do not run it at all. There is nothing for a human to approve. */
  | "refuse";

/** Why a decision came out the way it did. One rule, named, for the audit log. */
export type PolicyRule =
  | "reviewer-refused"
  | "intent-refused"
  | "reply-step"
  | "unknown-capability"
  | "lease-expired"
  | "lease-over-risk"
  | "persistent-change"
  | "irreversible-elevated"
  | "intent-unexplained"
  | "reviewer-unavailable"
  | "reviewer-requires-human"
  | "over-mode-risk-cap"
  | "dry-run"
  | "autonomy-bypass"
  | "cleared";

export interface PolicyOutcome {
  decision: PolicyDecision;
  rule: PolicyRule;
  reason: string;
  /** True when a rung would have bypassed this and was not allowed to. */
  bypassRefused: boolean;
}

/**
 * The reviewer's structured assessment. Every field is a claim about the step
 * that a person could check, rather than a verdict to be taken on trust.
 */
export interface ReviewScore {
  risk: StepRisk;
  rollbackAvailable: boolean;
  verificationAvailable: boolean;
  leastPrivilege: boolean;
  blastRadius: "low" | "medium" | "high";
  requiresHuman: boolean;
  reasoning: string[];
}

export interface PolicyInput {
  /** The spec for the step's capability. Undefined for a reply step. */
  spec: CapabilitySpec | undefined;
  kind: ActionKind;
  /** Null when the reviewer could not be reached or returned nothing usable. */
  score: ReviewScore | null;
  /** A reviewer verdict that refuses the step outright. */
  refusal: "block" | "needs_evidence" | null;
  /** A floor the reviewer has no authority over, already checked. */
  floor: "always_ask" | "cross_account" | null;
  /** What the plan-level intent validator concluded. */
  intent: "clear" | "human" | "refuse";
  /** True when the intent validator named THIS step as unexplained. */
  intentUnexplained: boolean;
  mode: ExecutionMode;
  /** Injected so lease expiry is testable without faking a clock globally. */
  now?: number;
}

/**
 * Decisions no rung may overrule, including `full`.
 *
 * The distinction is between *scheduling* and *permission*. "Should a person be
 * waiting for this" is a scheduling question and autonomy is exactly the switch
 * for it. "Should this run at all" is not, and there is no wait for autonomy to
 * remove — bypassing simply runs the step the system already identified as
 * wrong.
 */
const NON_BYPASSABLE: ReadonlySet<PolicyRule> = new Set<PolicyRule>([
  "reviewer-refused",
  "intent-refused",
  "unknown-capability",
  "lease-expired",
  "lease-over-risk",
  // A change that survives a reboot is not a scheduling question.
  "persistent-change",
  "irreversible-elevated",
  // The whole point of the plan-level check. Under the default rung this would
  // otherwise be bypassed on every ticket, which would make the validator
  // decorative.
  "intent-unexplained",
  // Was bypassable, and that was wrong: it turned "the gate is down" into
  // "proceed unsupervised", which is the one thing a gate must never do.
  "reviewer-unavailable",
]);

function outcome(
  decision: PolicyDecision,
  rule: PolicyRule,
  reason: string,
  bypassRefused = false,
): PolicyOutcome {
  return { decision, rule, reason, bypassRefused };
}

/**
 * Decide whether a step runs, waits, or is refused.
 *
 * Pure. No I/O, no clock unless one is passed, no environment reads — the mode
 * arrives as an argument precisely so this stays a function of its inputs.
 */
export function decide(input: PolicyInput): PolicyOutcome {
  const { spec, score, mode } = input;
  const now = input.now ?? Date.now();

  // ---- refusals first. Nothing below can un-refuse these. -----------------
  if (input.refusal) {
    return outcome(
      "refuse",
      "reviewer-refused",
      input.refusal === "block"
        ? "the reviewer refused this step outright"
        : "the reviewer found no evidence for the diagnosis this change rests on",
      mode === "full",
    );
  }
  if (input.intent === "refuse") {
    return outcome("refuse", "intent-refused", "the plan does not follow from the reported problem", mode === "full");
  }

  // A reply carries no capability and changes nothing outside the thread.
  if (input.kind === "reply") {
    return outcome("auto", "reply-step", "user-visible message only");
  }

  if (!spec) {
    return outcome("refuse", "unknown-capability", "no registered capability for this step", mode === "full");
  }

  // ---- provenance ---------------------------------------------------------
  if (spec.provenance.expiresAt) {
    const expiry = Date.parse(spec.provenance.expiresAt);
    if (!Number.isNaN(expiry) && expiry <= now) {
      return outcome(
        "refuse",
        "lease-expired",
        `${spec.id} was a temporary grant that expired at ${spec.provenance.expiresAt}`,
        mode === "full",
      );
    }
  }
  if (spec.provenance.source === "temporary" && spec.risk > 1) {
    // A lease exists to let someone try something narrow under time pressure.
    // It is not a route to a persistent change with an expiry date on it.
    return outcome(
      "refuse",
      "lease-over-risk",
      `${spec.id} is a temporary grant and may not carry risk ${spec.risk}`,
      mode === "full",
    );
  }

  // ---- structural floors, in code, that no rung overrules ------------------
  if (spec.risk >= 3) {
    return outcome(
      "human",
      "persistent-change",
      `${spec.id} is risk ${spec.risk} — it changes persistent OS or directory state and always needs a person`,
      mode === "full",
    );
  }
  if (spec.requiresElevation && spec.reversible === "none") {
    return outcome(
      "human",
      "irreversible-elevated",
      `${spec.id} runs elevated and cannot be undone`,
      mode === "full",
    );
  }
  if (input.intentUnexplained) {
    return outcome(
      "human",
      "intent-unexplained",
      "the intent validator could not tie this step to the reported problem",
      mode === "full",
    );
  }

  // ---- the reviewer -------------------------------------------------------
  if (!score) {
    // Fail closed, and closed now means CLOSED. This used to resolve to
    // ask_human, which `full` then converted to auto — so an unreachable
    // reviewer produced unsupervised writes. A read with no reviewer is still
    // only a read, so that one waits rather than being refused.
    if (spec.risk >= 1) {
      return outcome(
        "refuse",
        "reviewer-unavailable",
        "safety reviewer unavailable — a change is refused rather than run unreviewed",
        mode === "full",
      );
    }
    return applyMode(
      outcome(
        "human",
        "reviewer-unavailable",
        "safety reviewer unavailable — read held for a person",
        mode === "full",
      ),
      input,
    );
  }

  if (score.requiresHuman) {
    return applyMode(
      outcome("human", "reviewer-requires-human", score.reasoning[0] ?? "the reviewer asked for a person"),
      input,
    );
  }
  if (input.floor) {
    return applyMode(
      outcome(
        "human",
        "reviewer-requires-human",
        input.floor === "always_ask"
          ? "this capability always requires a person"
          : "this step acts on somebody other than the reporter",
      ),
      input,
    );
  }
  if (input.intent === "human") {
    return applyMode(
      outcome("human", "intent-unexplained", "the plan as a whole needs a person to look at it"),
      input,
    );
  }

  return applyMode(outcome("auto", "cleared", score.reasoning[0] ?? "cleared by the reviewer"), input);
}

/**
 * Apply the rung to a decision that is still open to it.
 *
 * Only reached for decisions that are genuinely about scheduling — everything
 * in NON_BYPASSABLE has already returned.
 */
function applyMode(current: PolicyOutcome, input: PolicyInput): PolicyOutcome {
  const { mode, spec } = input;
  const risk = spec?.risk ?? 0;

  if (NON_BYPASSABLE.has(current.rule)) return current;

  switch (mode) {
    case "simulation":
    case "shadow":
      // Nothing is sent to the machine on these rungs, so there is nothing for
      // a person to approve. The step still records what it WOULD have been
      // gated on, which is the entire value of running a ticket this way.
      if (current.decision === "human") {
        return outcome("auto", "dry-run", `${current.reason} — dry run, nothing is sent to the machine`);
      }
      return current;

    case "limited":
      // Risk 0 and 1 are self-restoring or read-only. Anything that survives a
      // reboot waits, whatever the reviewer thought of it.
      if (risk >= 2 && current.decision === "auto") {
        return outcome("human", "over-mode-risk-cap", `AUTONOMY=limited holds risk ${risk} for a person`);
      }
      return current;

    case "gated":
      return current;

    case "full":
      if (current.decision === "human") {
        return outcome("auto", "autonomy-bypass", `${current.reason} — AUTONOMY=full, running unapproved`);
      }
      return current;
  }
}

/** One line for the step log, so the decision is legible on the ticket. */
export function policyLogLine(o: PolicyOutcome): string {
  const verb =
    o.decision === "auto" ? "AUTO" : o.decision === "human" ? "NEEDS A PERSON" : "REFUSED";
  return (
    `[Policy] ${verb} · rule=${o.rule}: ${o.reason}` +
    (o.bypassRefused ? " · AUTONOMY=full could not bypass this" : "")
  );
}
