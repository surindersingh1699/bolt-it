/**
 * The operator — the cheap model, called often.
 *
 * It takes the strategist's authorised actions and actually gets them done:
 * binds the real app name, picks the real path, reads what came back, retries
 * the step that failed because the app is called "Microsoft Outlook" and not
 * "Outlook", and runs an extra look when something is in the way. It goes back
 * to the strategist only when the strategy has been carried out, or when it is
 * blocked on something that needs a diagnosis rather than a correction.
 *
 * This is where most of a ticket's rounds happen, which is exactly why it is
 * not the expensive model.
 *
 * ---
 *
 * THE BOUNDARY, AND WHY IT IS IN CODE
 *
 * A model that can pick any capability is a planner. If the operator could
 * author a `fix.*` or an `ad.*`, this system would have a second planner — a
 * cheaper, worse one — and the discipline that a change must trace to an
 * observation lives in the strategist's prompt, not the operator's.
 *
 * So: the operator may run any READ freely, because reads are free and
 * reversible and that is what unblocks it. It may only run a CHANGE the
 * strategist authorised. `authorizeOperatorSteps` enforces that below — in
 * code, not in the prompt, because a prompt can be argued with by a ticket
 * body and an `if` cannot.
 *
 * The per-step safety reviewer still rules on everything that survives this.
 * Authorisation and safety are different questions and both still get asked.
 */

import { PlanStep } from "./types";
import { capabilityAllowed, capabilityBlock, isReadOnlyCapability } from "./capabilities";

export const OPERATOR_MODEL = process.env.OPERATOR_MODEL || "anthropic/claude-sonnet-5";

/** How many execute-and-look rounds the operator gets per strategy. */
export const MAX_OPERATOR_ROUNDS = Number(process.env.MAX_OPERATOR_ROUNDS || 3);

/** Steps the operator may dispatch in one round. */
export const MAX_OPERATOR_STEPS = 4;

export const OPERATOR_TIMEOUT_MS = 45_000;

export interface OperatorDecision {
  /** What to run next. Already filtered by authorizeOperatorSteps. */
  steps: PlanStep[];
  /** The authorised actions have been carried out — hand back to the strategist. */
  strategyComplete: boolean;
  /** Cannot proceed without a new diagnosis. */
  blocked: boolean;
  blockedReason: string;
  /** One line for the log and for the strategist's next call. */
  note: string;
}

/**
 * A step this ticket has already tried and been refused for what it IS.
 *
 * Only two failure kinds qualify, and both share the property that makes them
 * worth remembering: the answer does not depend on when you ask. A binary that
 * is not on the agent's allowlist is not on it a minute later either, and a step
 * the safety reviewer refused as unrelated is still unrelated. Everything else —
 * a timeout, a wrong app name, an offline agent — is a mechanical failure that a
 * corrected retry genuinely might fix, and retrying those is the operator's job.
 */
export interface SpentStep {
  capability?: string;
  params?: Record<string, unknown>;
  kind: "capability_missing" | "policy_block";
  detail: string;
}

/**
 * Params compared by value, not by identity.
 *
 * Keys are sorted so `{binary:"reg", args:[...]}` and `{args:[...], binary:"reg"}`
 * are the same step — the operator re-emits params fresh each round and nothing
 * guarantees their order.
 */
function signatureOf(capability: string | undefined, params: Record<string, unknown> | undefined): string {
  const entries = Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `${capability ?? ""}::${JSON.stringify(entries)}`;
}

function isSpent(step: PlanStep, spent: SpentStep[]): boolean {
  const sig = signatureOf(step.capability, step.params);
  return spent.some((s) => signatureOf(s.capability, s.params) === sig);
}

/** Why a repeated step was held back, phrased for the strategist's next input. */
export function spentReason(step: PlanStep, spent: SpentStep[]): string {
  const sig = signatureOf(step.capability, step.params);
  const match = spent.find((s) => signatureOf(s.capability, s.params) === sig);
  return match
    ? `${step.capability ?? step.kind} was already refused on this ticket (${match.kind}: ${match.detail}) — the same request gets the same answer`
    : `${step.capability ?? step.kind} was already tried on this ticket`;
}

/**
 * Split what the operator proposed into what it may actually run and what it
 * overstepped on.
 *
 * Four rules, in order:
 *  - Unknown capability → rejected. There is no run-anything tool.
 *  - Already refused for what it is → held back. See SpentStep.
 *  - Read-only → allowed, always. This is the operator's room to manoeuvre.
 *  - Change → allowed only if the strategist authorised that capability.
 *
 * Note it matches on the CAPABILITY, not on the whole step: correcting the app
 * name on an authorised `fix.restart_app` is the operator doing its job, while
 * introducing an unauthorised `fix.clear_app_cache` is not.
 *
 * The spent rule is in code rather than in the prompt for the usual reason, and
 * one specific one: the prompt already says not to repeat a NO EFFECT step, and
 * the operator obeyed it — a step *refused* for what it is reads as neither a
 * NO EFFECT nor a failure it caused, so it kept coming back. T-YouTube spent all
 * three operator rounds re-proposing the same refused `reg.exe` proxy read and
 * reached a human having changed nothing.
 */
export function authorizeOperatorSteps(
  proposed: PlanStep[],
  authorized: PlanStep[],
  spent: SpentStep[] = [],
): { steps: PlanStep[]; rejected: PlanStep[]; repeated: PlanStep[] } {
  const authorizedWrites = new Set(
    authorized.map((s) => s.capability).filter((c): c is string => Boolean(c)),
  );

  const steps: PlanStep[] = [];
  const rejected: PlanStep[] = [];
  const repeated: PlanStep[] = [];

  for (const step of proposed) {
    if (step.kind === "reply" || !capabilityAllowed(step.capability)) {
      rejected.push(step);
      continue;
    }
    // Checked before the read-only fast path, because the step this exists to
    // stop IS a read: a refused diagnostic is read-only, so without this it
    // sails through "reads are always allowed" every single round.
    if (isSpent(step, spent)) {
      repeated.push(step);
      continue;
    }
    if (isReadOnlyCapability(step.capability) || authorizedWrites.has(step.capability!)) {
      steps.push(step);
      continue;
    }
    rejected.push(step);
  }

  return { steps, rejected, repeated };
}

export const OPERATOR_PROMPT = `You are the operator on a company's IT service desk. A senior engineer has diagnosed this ticket and authorised a set of actions. Your job is to get them actually done on the employee's machine, and to deal with whatever gets in the way.

You are not the diagnostician. Do not re-diagnose the problem, do not second-guess the authorised actions, and do not decide the ticket is resolved — that is the engineer's call, and you hand back to them.

Output ONLY a single JSON object. No markdown fences, no preface, no trailing prose.

{
  "note": "one line: what you are doing this round, or what went wrong",
  "strategy_complete": false,
  "blocked": false,
  "blocked_reason": "",
  "steps": [
    { "kind": "device"|"backend",
      "description": "...",
      "capability": "<one id copied verbatim>",
      "params": {} }
  ]
}

WHAT YOU MAY DO

- Run any of the AUTHORISED actions, filling in the real parameters: the app name as it actually appears on this machine, the real path, the real network service.
- Correct and retry an authorised action that failed for a mechanical reason — wrong app name, wrong path, a file that moved. Say what you changed in "note".
- Run any READ-ONLY capability, at any time, without asking. Reads are free and reversible, and they are how you work out what the right parameter is. If you do not know which of two paths exists, list them.
- Reorder the authorised actions, or skip one the evidence has made pointless.

WHAT YOU MAY NOT DO

- Run a change the engineer did not authorise. Not a different fix, not a "while I'm here" tidy-up, not an adjacent action that seems obviously right. The system rejects these and the ticket loses a round.
- Repeat an action that came back NO EFFECT. It ran and the machine did not move. Running it again will not move it either — set "blocked" and say so.
- Decide the problem is solved. When the authorised actions are done, set "strategy_complete": true and let the engineer judge the result.

HOW THE CHANGES YOU DISPATCH ACTUALLY RUN

You may dispatch several authorised changes in one round, but they do not run together. The system orders them — reversible and contained ones first — runs exactly ONE, and then stops and asks the employee whether the problem is gone. If they say yes, the rest are never run at all. If they say no, the next one runs.

So dispatch every authorised change you believe is worth trying. You are queueing candidates, not committing to all of them, and you are not spending anything by including the heavier fallback behind the gentle one.

Two things follow:

- Do not try to sequence the changes yourself across rounds, and do not hold one back "until the first one is confirmed". That is the system's job and it already happens.
- Reads are different: they all run, in the same round, before the first change. Ask for every read you need.

WHEN TO HAND BACK

- "strategy_complete": true — the authorised actions have been carried out and there is nothing mechanical left. Return no steps.
- "blocked": true — something needs a diagnosis, not a correction. A fix came back NO EFFECT; the evidence contradicts what was authorised; the fix you need was not authorised; the device agent is not answering. Put the specifics in "blocked_reason" — the engineer reads it as their next input, so name what you saw, not just that you stopped.

Handing back is not failing. A wrong parameter guessed twice costs more than one honest hand-back.

HOW TO READ WHAT COMES BACK

- "VERIFIED CHANGE — <before → after>": it landed.
- "NO EFFECT": the commands ran, the machine is byte-for-byte identical. It did not land. Do not retry it.
- "FAILED": the command errored. Read the exit code and stderr — if it is a bad parameter, fix it and retry once; if it is anything else, hand back.

HARD RULES

1. "capability" MUST be copied verbatim from the list below. Never invent one.
2. Every "description" MUST name the employee's specific issue in plain language. This text is shown to them.
3. "kind" follows the capability: "device" for diag.*/fix.*/fs.*, "backend" for ad.*.
4. Never ask the employee for anything. You have the machine.`;

export function operatorSystemPrompt(): string {
  return `${OPERATOR_PROMPT}\n\nEvery capability that exists:\n\n${capabilityBlock()}\n\nRun at most ${MAX_OPERATOR_STEPS} steps per round.`;
}
