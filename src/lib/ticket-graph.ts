import { StateGraph, Annotation, START, END, MemorySaver, interrupt, Command } from "@langchain/langgraph";
import { getTicket, updateTicket, updateStep, listAgentJobs, listDevices, listTickets } from "@/lib/data";
import { PlanStep, StepFailure, StepFailureKind, Ticket } from "@/lib/types";
import { REVIEWER_MODEL, reviewPlan } from "@/lib/reviewer";
import {
  runStrategist,
  runOperator,
  communicate,
  type ReplyEvidence,
} from "@/lib/integrations/ai-gateway";
import { appendTrace } from "@/lib/trace";
import { getChat } from "@/lib/chat";
import { readHeartbeat, HEARTBEAT_CONNECTED_WINDOW_MS } from "@/lib/agent-heartbeat";
import { CommunicationMoment } from "@/lib/desk";
import { EXECUTORS } from "@/lib/executors";
import { DeviceFacts, NO_FACTS, observeDevice } from "@/lib/observe";
import { MAX_RESEARCH_ROUNDS, ResearchFinding, runResearch } from "@/lib/research";
import { attachmentsAsDataUris } from "@/lib/attachments";
import { resolutionSupported } from "@/lib/resolution";
import { IntentVerdict, validateIntent } from "@/lib/intent";
import { MAX_STRATEGY_ROUNDS, STRATEGIST_MODEL, Strategy } from "@/lib/strategist";
import { MAX_OPERATOR_ROUNDS, OPERATOR_MODEL } from "@/lib/operator";
import {
  buildReplyEvidence,
  firstNameOf,
  humanStepLabel,
  postUpdate,
  substituteParams,
  waitForAgentJobs,
} from "@/lib/ticket-helpers";

/**
 * ONE TICKET, TWO MODELS, ONE GATE.
 *
 *   strategist (opus)  — reads the problem, the screenshot and the machine's
 *                        readings; diagnoses; authorises actions. Called rarely.
 *   operator (sonnet)  — carries those actions out, binds real parameters,
 *                        works around mechanical obstacles. Called often.
 *
 * The inner loop is operator ⇄ execute and it is cheap. The outer loop is the
 * strategist and it is expensive, so it runs only at the start, when the
 * operator has finished, and when the operator hits something that needs a
 * diagnosis rather than a correction.
 *
 * THE RULE THAT HOLDS THE GATE UP: models emit data, the graph emits control
 * flow. Neither model ever returns a node name. `runNextStep` applies the
 * approval `interrupt()` before it dispatches anything, so a model that could
 * choose the next node could choose the one after the gate — which is why
 * neither can.
 */

export interface Approver {
  name: string;
  email: string;
}

/**
 * How many times the employee can send a ticket back before it goes to a person.
 *
 * One. A fix that did not work is worth a second look with the employee's own
 * account of what is still happening — that is new evidence, and often the only
 * evidence that contradicts a VERIFIED CHANGE. A second failure is not a third
 * round; it means this system has the wrong model of the problem.
 */
export const MAX_REOPENS = Number(process.env.MAX_REOPENS || 1);

// The whole plan-level review is a handful of reviewer calls in parallel, each
// already bounded at ~15s. This is the outer guard: if the review as a whole
// has not resolved well past that, something is wrong (a wedged gateway call, a
// pathological step) and the ticket must escalate rather than hang forever.
const REVIEW_STEPS_TIMEOUT_MS = Number(process.env.REVIEW_STEPS_TIMEOUT_MS || 60_000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const overwrite = <T,>(_current: T, update: T) => update;
const append = <T,>(cur: T[], upd: T[]) => cur.concat(upd);

const TicketGraphState = Annotation.Root({
  ticketId: Annotation<string>(),
  // What the machine said, read once before anyone planned against it.
  deviceFacts: Annotation<DeviceFacts>({ reducer: overwrite, default: () => NO_FACTS }),
  // Distilled, attributed claims. Raw page text never reaches state — research.ts.
  research: Annotation<ResearchFinding[]>({ reducer: append, default: () => [] }),
  researchQuestion: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  researchRounds: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  // The current authorisation. The operator may not run a change outside it.
  strategy: Annotation<Strategy | null>({ reducer: overwrite, default: () => null }),
  /** Which strategist call this is. Bounded by MAX_STRATEGY_ROUNDS. */
  strategyRound: Annotation<number>({ reducer: overwrite, default: () => 1 }),
  /** Which operator round within the CURRENT strategy. Resets on a new one. */
  operatorRound: Annotation<number>({ reducer: overwrite, default: () => 1 }),
  /** One line per strategist call — the trail a technician reads at handoff. */
  diagnoses: Annotation<string[]>({ reducer: append, default: () => [] }),
  /**
   * What the employee said after an attempt landed. The freshest evidence on
   * the ticket, and the only kind that can contradict a VERIFIED CHANGE: the
   * machine can change and the problem can still be there.
   */
  followUps: Annotation<string[]>({ reducer: append, default: () => [] }),
  /**
   * How many times the employee has sent it back. Bounded by MAX_REOPENS — the
   * second "still broken" is a person's problem, not another round.
   */
  reopens: Annotation<number>({ reducer: overwrite, default: () => 0 }),
  /** What the operator reported back, in its own words. */
  operatorNotes: Annotation<string[]>({ reducer: append, default: () => [] }),
  /**
   * What the operator wants run next, already filtered by
   * `authorizeOperatorSteps`. Handed to reviewSteps, which is the only node
   * that writes steps onto the ticket.
   */
  pendingSteps: Annotation<PlanStep[]>({ reducer: overwrite, default: () => [] }),
  /**
   * What the intent validator made of the pending plan AS A WHOLE. Carried into
   * reviewSteps because the per-step reviewer cannot see it: "these four
   * individually-harmless reads add up to a credential sweep" is not a fact
   * about any one of them.
   */
  intentVerdict: Annotation<IntentVerdict | null>({ reducer: overwrite, default: () => null }),
  findings: Annotation<string[]>({ reducer: append, default: () => [] }),
  pendingStepId: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  approver: Annotation<Approver | null>({ reducer: overwrite, default: () => null }),
});

type TState = typeof TicketGraphState.State;

// ---- the service desk ------------------------------------------------------
// One voice for the whole life of the ticket. Always posts something: if the
// desk model is unavailable the deterministic fallback goes out instead, because
// silence while a slow model thinks is the failure this exists to prevent.
async function say(
  ticket: Ticket,
  moment: CommunicationMoment,
  fallback: string,
  extras: {
    agentSummary?: string;
    plannedSteps?: string[];
    evidence?: ReplyEvidence[];
    findings?: string[];
  } = {},
): Promise<void> {
  const text = await communicate({
    ticketId: ticket.id,
    moment,
    reporterFirstName: firstNameOf(ticket.reporter),
    subject: ticket.subject,
    body: ticket.body,
    // Every moment gets the conversation so far, not just the chat turn. Without
    // it, `working` and `heartbeat` could not see what they had already said, so
    // four rounds of "here's what I'm going to check / nothing you need to do"
    // went out reading like the first one each time. communicate() already
    // carries a "do not repeat yourself" rule — it just had nothing to compare
    // against on these moments.
    history: getChat(ticket.id),
    ...extras,
  }).catch(() => null);
  await postUpdate(ticket, text ?? fallback);
}

// A fix the strategist needed and did not have. It cannot be registered at
// runtime — a handler with no probe produces no before/after facts, so it could
// never be verified — but it is exactly the spec a human needs to add one, so it
// rides along in the findings and lands in the handoff artifact.
function noteCapabilityRequest(ticketId: string, strategy: Strategy): string | null {
  const req = strategy.capabilityRequest;
  if (!req) return null;
  appendTrace(
    ticketId,
    "capabilityRequest",
    "completed",
    `asked for a new capability "${req.name}": ${req.why || "(no reason given)"}`,
  );
  return (
    `the engineer requested a capability this system does not have — ${req.name} (${req.risk} risk): ${req.why}. ` +
    `Proposed command: ${req.command}. Expected effect: ${req.expectedEffect || "(not stated)"}. ` +
    `Verify via: ${req.probeFields.join(", ") || "(no probe proposed)"}. ` +
    `Reversible by: ${req.reversible || "(not stated)"}.`
  );
}

/** Screenshots for the strategist. Round 1 only — see StrategistInput.images. */
async function imagesFor(ticket: Ticket, round: number): Promise<string[]> {
  if (round !== 1) return [];
  return attachmentsAsDataUris(ticket.attachments ?? []).catch(() => []);
}

/** Everything run so far, with the device's own verdict on each. */
async function evidenceFor(ticketId: string, workspaceId: string): Promise<ReplyEvidence[]> {
  await waitForAgentJobs(ticketId, 20_000);
  const fresh = await getTicket(ticketId);
  const jobs = (await listAgentJobs(workspaceId)).filter((j) => j.ticketId === ticketId);
  return buildReplyEvidence(fresh?.plan ?? [], jobs);
}


/**
 * Read the machine before anyone plans against it.
 *
 * This is the branch that changes what the planner is: it drafts against
 * observed facts rather than proposing read-only steps to go and get them. It
 * sits on the same unconditional fan-out as the other context branches, so the
 * probes are already in flight while the directory and memory reads complete.
 *
 * Runs on every ticket, including ones where there is no agent to talk to —
 * `observeDevice` returns `collected: false` immediately in that case, and that
 * answer is itself worth putting in front of the planner.
 */
async function observe(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};

  const deviceFacts: DeviceFacts = await observeDevice(ticket).catch((err) => ({
    collected: false,
    reason: `observation failed: ${(err as Error).message}`,
    facts: [],
  }));

  appendTrace(
    state.ticketId,
    "observe",
    "completed",
    deviceFacts.collected
      ? `read ${deviceFacts.facts.filter((f) => f.outcome === "succeeded").length}/${deviceFacts.facts.length} probe(s) from ${deviceFacts.host} before planning`
      : `no device evidence — ${deviceFacts.reason}`,
    Date.now() - t0,
  );
  return { deviceFacts };
}

/**
 * The researcher. Answers one question from outside sources and hands back short
 * attributed claims, then returns to the strategist — a research round is by
 * definition a round the strategist asked for.
 *
 * Anything the distiller flagged as trying to instruct it lands in `findings`,
 * so an injection attempt reaches the handoff artifact instead of being
 * silently discarded.
 */
async function researcher(state: TState) {
  const t0 = Date.now();
  const question = state.researchQuestion;
  if (!question) return new Command({ goto: "strategist", update: { researchQuestion: null } });

  appendTrace(state.ticketId, "research", "started", `looking up: ${question}`);
  const result = await runResearch({ question, ticketId: state.ticketId }).catch(() => null);
  const findings = result?.findings ?? [];
  const flags = result?.flags ?? [];

  appendTrace(
    state.ticketId,
    "research",
    "completed",
    findings.length > 0
      ? `${findings.length} attributed claim(s) from ${new Set(findings.map((f) => f.sourceUrl)).size} source(s)`
      : `nothing usable — ${result?.note ?? "researcher unavailable"}`,
    Date.now() - t0,
  );

  const note =
    findings.length > 0
      ? `researched "${question}": ${findings.map((f) => f.claim).join(" · ")}`
      : `researched "${question}": no usable answer (${result?.note ?? "researcher unavailable"})`;

  return new Command({
    goto: "strategist",
    update: {
      research: findings,
      researchQuestion: null,
      researchRounds: state.researchRounds + 1,
      strategyRound: state.strategyRound + 1,
      findings: [
        note,
        ...flags.map(
          (f) =>
            `a web source retrieved for this ticket contained text addressed to the agent, which was not acted on: ${f}`,
        ),
      ],
    },
  });
}


/**
 * The expensive look. Diagnoses and authorises; never runs anything.
 *
 * Every exit from here is decided in code from the data the model returned —
 * including the resolution, which is a CLAIM the model makes and this node
 * checks against what the machine actually did.
 */
async function strategist(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  // The reopen bound, checked before the expensive call rather than after it.
  // One second look is worth paying for; a third round of the same conversation
  // is a person's job, and without this the employee could reopen forever.
  if (state.reopens > MAX_REOPENS) {
    appendTrace(
      state.ticketId,
      "strategist",
      "completed",
      `employee reported it still broken after ${state.reopens} attempt(s) — handing to a person`,
    );
    return new Command({
      goto: "humanHandoff",
      update: {
        findings: [
          `the employee reported the problem still happening after ${state.reopens} attempt(s): ` +
            `${state.followUps[state.followUps.length - 1] ?? "(no detail given)"}`,
        ],
      },
    });
  }

  const evidence = await evidenceFor(state.ticketId, ticket.workspaceId);
  appendTrace(
    state.ticketId,
    "strategist",
    "started",
    `look ${state.strategyRound}/${MAX_STRATEGY_ROUNDS} (${STRATEGIST_MODEL})`,
  );

  const strategy = await runStrategist({
    ticketId: state.ticketId,
    subject: ticket.subject,
    body: ticket.body,
    reporter: ticket.reporter,
    reporterEmail: ticket.reporterEmail,
    round: state.strategyRound,
    maxRounds: MAX_STRATEGY_ROUNDS,
    deviceFacts: state.deviceFacts,
    research: state.research,
    evidence,
    priorDiagnoses: state.diagnoses,
    operatorNotes: state.operatorNotes,
    followUps: state.followUps,
    images: await imagesFor(ticket, state.strategyRound),
  }).catch(() => null);

  // No usable answer. Fail closed to a person rather than inventing a plan.
  if (!strategy) {
    appendTrace(state.ticketId, "strategist", "failed", "no usable answer from the model", Date.now() - t0);
    return new Command({
      goto: "humanHandoff",
      update: { findings: [`the engineer could not produce a diagnosis on look ${state.strategyRound}`] },
    });
  }

  const note = noteCapabilityRequest(state.ticketId, strategy);
  const base = {
    strategy,
    diagnoses: [strategy.diagnosis || strategy.reasoning],
    ...(note ? { findings: [note] } : {}),
  };
  const outOfLooks = state.strategyRound >= MAX_STRATEGY_ROUNDS;

  appendTrace(
    state.ticketId,
    "strategist",
    "completed",
    strategy.resolved
      ? `believes resolved: ${strategy.diagnosis}`
      : `${strategy.diagnosis} · authorised ${strategy.steps.length} step(s) · confidence ${Math.round(strategy.confidence * 100)}%`,
    Date.now() - t0,
  );

  // The resolution guard. `resolved` is the model's claim; this is the check.
  // See resolution.ts for why it replaced running a second model.
  if (strategy.resolved) {
    const support = resolutionSupported(evidence);
    if (support.ok) return new Command({ goto: "finalize", update: base });

    appendTrace(
      state.ticketId,
      "resolutionRefused",
      "completed",
      `claimed resolved, refused: ${support.why}`,
    );
    return new Command({
      goto: outOfLooks ? "humanHandoff" : "strategist",
      update: {
        ...base,
        strategyRound: state.strategyRound + 1,
        findings: [`claimed resolved on look ${state.strategyRound}; refused because ${support.why}`],
      },
    });
  }

  if (strategy.stuck) {
    return new Command({
      goto: "humanHandoff",
      update: { ...base, findings: [`the engineer stopped: ${strategy.stuckReason}`] },
    });
  }

  if (strategy.researchQuestion && state.researchRounds < MAX_RESEARCH_ROUNDS) {
    return new Command({ goto: "researcher", update: { ...base, researchQuestion: strategy.researchQuestion } });
  }

  if (strategy.steps.length === 0) {
    return new Command({
      goto: "humanHandoff",
      update: { ...base, findings: [`look ${state.strategyRound} authorised no runnable actions`] },
    });
  }

  // Hand to the operator with a fresh inner-loop budget.
  return new Command({ goto: "operator", update: { ...base, operatorRound: 1 } });
}

/**
 * The cheap loop. Turns the authorisation into steps that will actually run on
 * this machine, and reads what came back.
 *
 * It cannot widen the authorisation — `authorizeOperatorSteps` filters its
 * output before it ever reaches here (see operator.ts). What it can do is bind
 * real parameters, retry a mechanical failure, and look at things.
 */
async function operator(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket || !state.strategy) return new Command({ goto: END });

  const outOfLooks = state.strategyRound >= MAX_STRATEGY_ROUNDS;
  const backToStrategist = (reason: string, extra: Record<string, unknown> = {}) =>
    new Command({
      goto: outOfLooks ? "humanHandoff" : "strategist",
      update: {
        strategyRound: state.strategyRound + 1,
        operatorNotes: [reason],
        ...extra,
      },
    });

  if (state.operatorRound > MAX_OPERATOR_ROUNDS) {
    appendTrace(state.ticketId, "operator", "completed", `used its ${MAX_OPERATOR_ROUNDS} rounds on this strategy`);
    return backToStrategist(`ran ${MAX_OPERATOR_ROUNDS} rounds without finishing the authorised actions`);
  }

  const evidence = await evidenceFor(state.ticketId, ticket.workspaceId);
  appendTrace(
    state.ticketId,
    "operator",
    "started",
    `round ${state.operatorRound}/${MAX_OPERATOR_ROUNDS} (${OPERATOR_MODEL})`,
  );

  const decision = await runOperator({
    ticketId: state.ticketId,
    subject: ticket.subject,
    body: ticket.body,
    diagnosis: state.strategy.diagnosis,
    authorized: state.strategy.steps,
    evidence,
    round: state.operatorRound,
    maxRounds: MAX_OPERATOR_ROUNDS,
    deviceFacts: state.deviceFacts,
  }).catch(() => null);

  // No usable answer from the cheap model. Escalate to the expensive one rather
  // than guessing at parameters on someone's machine.
  if (!decision) {
    appendTrace(state.ticketId, "operator", "failed", "no usable answer", Date.now() - t0);
    return backToStrategist("the operator could not decide what to run and handed back");
  }

  appendTrace(
    state.ticketId,
    "operator",
    "completed",
    decision.blocked
      ? `blocked: ${decision.blockedReason}`
      : decision.strategyComplete
        ? `strategy carried out: ${decision.note}`
        : `${decision.steps.length} step(s): ${decision.note}`,
    Date.now() - t0,
  );

  if (decision.blocked) {
    return backToStrategist(`blocked — ${decision.blockedReason}`, {
      findings: [`the operator was blocked: ${decision.blockedReason}`],
    });
  }

  // "Nothing left to run" and "I am finished" are the same state, and the
  // operator is not allowed to decide the ticket is resolved either way.
  if (decision.strategyComplete || decision.steps.length === 0) {
    return backToStrategist(decision.note || "carried out the authorised actions");
  }

  return new Command({
    goto: "intentValidator",
    update: { operatorNotes: [decision.note], pendingSteps: decision.steps },
  });
}

/**
 * Does this plan follow from what the employee actually reported?
 *
 * Every other gate rules on one step at a time — `reviewPlan` literally maps
 * `reviewStep` across the plan in parallel. That leaves a class of attack no
 * per-step check can see: four risk-0, read-only steps on the reporter's own
 * machine, each of which passes the reviewer, ALWAYS_ASK and target binding,
 * which together sweep their disk for credentials under cover of "my computer
 * is slow".
 *
 * The reviewer asks *is this step safe*. This asks *does this plan follow*. Two
 * questions, so two stages — see intent.ts.
 *
 * A refusal routes to `humanHandoff` rather than back to the strategist. That is
 * deliberate: a plan reaching for credential material is not a planning mistake
 * to be retried with better wording, it is the thing a person needs to see.
 */
async function intentValidator(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket || state.pendingSteps.length === 0) {
    return new Command({ goto: "reviewSteps" });
  }

  const verdict = await validateIntent(ticket, state.pendingSteps).catch(
    (): IntentVerdict => ({
      outcome: "human",
      reason: "intent validator threw — failing closed to human approval",
      unexplained: [],
      harvestHits: [],
      nearMisses: [],
      source: "unavailable",
    }),
  );

  // Logged even when they pass: a query that only matched after normalization is
  // the interesting traffic, and the thing to tune the term list against.
  for (const miss of verdict.nearMisses) {
    appendTrace(
      state.ticketId,
      "intentValidator",
      "completed",
      `near-miss: "${miss.query}" matched ${miss.term} only after normalization`,
    );
  }

  if (verdict.outcome === "refuse") {
    appendTrace(state.ticketId, "intentValidator", "failed", verdict.reason, Date.now() - t0);
    const terms = [...new Set(verdict.harvestHits.map((h) => h.term))].join(", ");
    const queries = [...new Set(verdict.harvestHits.map((h) => h.query))].map((q) => `"${q}"`).join(", ");
    return new Command({
      goto: "humanHandoff",
      update: {
        intentVerdict: verdict,
        pendingSteps: [],
        findings: [
          `intent validator refused the plan: ${verdict.reason}`,
          `searched-for terms: ${terms} · queries: ${queries}`,
          `nothing was run on ${ticket.reporterEmail}'s machine`,
        ],
      },
    });
  }

  appendTrace(
    state.ticketId,
    "intentValidator",
    "completed",
    verdict.outcome === "human"
      ? `plan needs a person (${verdict.source}): ${verdict.reason}`
      : `plan follows from the report: ${verdict.reason}`,
    Date.now() - t0,
  );

  return new Command({ goto: "reviewSteps", update: { intentVerdict: verdict } });
}

/**
 * Safety review, persist, tell the employee.
 *
 * Unchanged in substance from the two nodes it replaces. The reviewer rules on
 * every step whichever model proposed it — authorisation and safety are
 * different questions and both still get asked. Steps are appended so a later
 * round never erases what an earlier one ran.
 */
async function reviewSteps(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket || state.pendingSteps.length === 0) return {};

  const withParams = state.pendingSteps.map((s) => ({
    ...s,
    params: substituteParams(s.params, ticket.reporterEmail),
  }));

  // The plan-level verdict rides in so the policy engine sees both halves at
  // once: what this step is, and whether the plan it belongs to follows from the
  // report. Neither question can be answered from the other.
  //
  // Bounded and guarded, because a node that hangs or throws here vanishes: the
  // ticket sits at "new" with no trace and no artifact, which is exactly how a
  // stalled review looked in the wild — no error, no escalation, just silence.
  // A review that cannot complete must fail the plan loudly, not disappear.
  let reviewed: PlanStep[];
  try {
    reviewed = await withTimeout(
      reviewPlan(withParams, ticket, state.intentVerdict),
      REVIEW_STEPS_TIMEOUT_MS,
      "reviewPlan",
    );
  } catch (err) {
    const detail = (err as Error).message || "the safety review did not complete";
    appendTrace(state.ticketId, "reviewSteps", "failed", `review did not complete: ${detail}`, Date.now() - t0);
    // Persist the steps as failed so the graph escalates through its normal
    // failure path instead of stalling. A failed review is a dependency problem,
    // not a policy decision — the reviewer or the gateway, not the step.
    const failedSteps = withParams.map((s) => ({
      ...s,
      status: "failed" as const,
      failure: { kind: "dependency_unavailable" as const, detail: `safety review failed: ${detail}` },
      log: [...(s.log ?? []), `[reviewSteps] review did not complete: ${detail}`],
    }));
    const carriedFail = ticket.plan.filter((s) => !failedSteps.some((n) => n.id === s.id));
    await updateTicket(state.ticketId, {
      status: "executing",
      plan: [...carriedFail, ...failedSteps],
    }).catch(() => {});
    return {};
  }

  const carried = ticket.plan.filter((s) => !reviewed.some((n) => n.id === s.id));
  await updateTicket(state.ticketId, {
    status: "executing",
    confidence: state.strategy?.confidence ?? 0,
    draftResponse: state.strategy?.customerSummary,
    plan: [...carried, ...reviewed],
  });

  const gated = reviewed.filter((s) => s.approvalMode === "human").length;
  const blocked = reviewed.filter((s) => s.status === "failed").length;
  appendTrace(
    state.ticketId,
    "reviewSteps",
    "completed",
    `${reviewed.length} step(s) reviewed by ${REVIEWER_MODEL}: ${reviewed.length - gated} auto, ${gated} need a person` +
      (blocked ? `, ${blocked} refused outright` : ""),
    Date.now() - t0,
  );

  const updated = await getTicket(state.ticketId);
  if (updated) {
    const labels = reviewed.map((s) => humanStepLabel(s));
    const firstName = firstNameOf(ticket.reporter);
    const first = state.strategyRound === 1 && state.operatorRound === 1;
    await say(
      updated,
      first ? "intake" : "working",
      first
        ? `Hi ${firstName} — here's what I'm going to check:\n${labels
            .map((l, i) => `   ${i + 1}. ${l}`)
            .join("\n")}\n\n_Ticket ${state.ticketId}_`
        : `Hi ${firstName} — still on it. Next: ${labels.join(", ")}.`,
      { agentSummary: state.strategy?.customerSummary || undefined, plannedSteps: labels },
    );
  }
  return {};
}


/**
 * Run one step and persist its outcome.
 *
 * The graph's only job here is lifecycle: mark running, dispatch, record. HOW a
 * step runs lives in the executor registry, so a new execution surface never
 * touches this function and never gets a chance to slip past the approval gate
 * that runNextStep applies before calling it.
 */
async function executeStepAndPersist(
  ticket: Ticket,
  step: PlanStep,
): Promise<{ ok: boolean; failure?: StepFailure }> {
  await updateStep(ticket.id, step.id, { status: "running", startedAt: Date.now() });
  if (step.kind !== "reply") {
    await postUpdate(ticket, `\u{1F527} ${humanStepLabel(step)}\u2026`);
  }

  let ok: boolean;
  let log: string[];
  // Why it failed, not just that it did. Set on every path that clears `ok`.
  let failure: StepFailure | undefined;
  let simulated = false;

  try {
    const result = await EXECUTORS[step.kind](ticket, step);
    ok = result.ok;
    log = result.log;
    failure = result.failure;
    simulated = result.simulated === true;
  } catch (err) {
    // Executors are contracted not to throw. This is the backstop for the one
    // that does anyway — an escalated ticket, never a crashed graph.
    ok = false;
    failure = { kind: "execution", detail: (err as Error).message };
    log = [`[Error] ${(err as Error).message}`];
  }

  if (!ok) {
    // Belt and braces: a `failed` step with no taxonomy entry is exactly the
    // uninformative record this exists to prevent.
    failure ??= { kind: "execution", detail: "step did not complete; no adapter detail was returned" };
    log.push(`[Failure] ${failure.kind}: ${failure.detail}`);
  }

  await updateStep(ticket.id, step.id, {
    // A simulated step is not a succeeded one. `resolutionSupported` counts
    // succeeded steps, so recording it as such would let a dry run close a
    // ticket on work that never reached the machine.
    status: ok ? (simulated ? "simulated" : "succeeded") : "failed",
    log,
    finishedAt: Date.now(),
    ...(failure ? { failure } : {}),
  });
  return { ok, failure };
}

/**
 * Whether a mechanically-failed step should let the round finish before the
 * operator is asked to plan again.
 *
 * Yes when work is still queued, because the operator cannot see a pending step
 * and will re-propose it. No when the failure took the execution surface with it
 * — the rest of the round would only collect the same failure more slowly.
 */
export function shouldDrainRound(kind: StepFailureKind, moreQueued: boolean): boolean {
  if (!moreQueued) return false;
  return kind !== "timeout" && kind !== "dependency_unavailable";
}

/**
 * Self-looping execute node. Cleared steps run immediately; only a step the
 * reviewer left at "human" routes to the approval interrupt.
 *
 * A failed step goes back to the OPERATOR rather than straight to a person —
 * working around a wrong app name or a moved path is the operator's whole job.
 * Two failures are exempt, because neither is mechanical: a step the reviewer
 * refused is a diagnosis problem, and it goes to the strategist.
 */
async function runNextStep(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  const step = ticket.plan.find((s) => s.status === "pending");
  // The round is over. Results go back to the operator that asked for them.
  if (!step) {
    return new Command({ goto: "operator", update: { operatorRound: state.operatorRound + 1 } });
  }

  if (step.approvalMode === "human") {
    return new Command({ goto: "markAwaitingApproval", update: { pendingStepId: step.id } });
  }

  const t0 = Date.now();
  const { ok, failure } = await executeStepAndPersist(ticket, step);
  appendTrace(
    state.ticketId,
    `execute:${step.capability ?? step.kind}`,
    ok ? "completed" : "failed",
    ok
      ? `${humanStepLabel(step)} · reviewer cleared this step to run unattended`
      : `${humanStepLabel(step)} · ${failure?.kind ?? "execution"}: ${failure?.detail ?? "no detail"}`,
    Date.now() - t0,
  );

  if (!ok) {
    const kind = failure?.kind ?? "execution";
    const detail = failure?.detail ?? "no detail";

    // The reviewer refused it. That is a judgement about the plan, and no amount
    // of parameter-fixing by the operator answers it.
    if (kind === "policy_block" || kind === "unsupported_assumption") {
      return new Command({
        goto: state.strategyRound >= MAX_STRATEGY_ROUNDS ? "humanHandoff" : "strategist",
        update: {
          strategyRound: state.strategyRound + 1,
          findings: [`${humanStepLabel(step)} was refused — ${kind}: ${detail}`],
          operatorNotes: [`the safety reviewer refused ${step.capability ?? step.kind}: ${detail}`],
        },
      });
    }

    // A read the agent would perform if a person approved it. Neither the
    // operator nor the strategist can answer this — no rephrasing makes a
    // binary allowlisted — so it goes to the same structural gate a high-risk
    // step goes to, and the technician decides. Refusing it silently is what
    // sent T-8805 to a human having tested nothing.
    if (kind === "capability_missing") {
      return new Command({
        goto: "markAwaitingApproval",
        update: {
          pendingStepId: step.id,
          findings: [`${humanStepLabel(step)} needs a technician to approve a diagnostic — ${detail}`],
        },
      });
    }

    // Mechanical, and the round is not over. Finish the steps already queued
    // before re-planning.
    //
    // `buildReplyEvidence` shows the operator only steps that reached a terminal
    // state, so a step still sitting pending is invisible to it. Handing back
    // mid-round therefore asks it to plan against a round it cannot fully see,
    // and it proposes the outstanding checks a second time — which is how one
    // ticket ended up listing the same proxy check and the same HTTPS test
    // twice, with the employee reading both.
    //
    // Draining first is also just cheaper: the remaining steps are reads that
    // were already authorised and reviewed, and their results are what make the
    // operator's next round worth spending.
    const moreQueued = ticket.plan.some((s) => s.id !== step.id && s.status === "pending");
    if (shouldDrainRound(kind, moreQueued)) {
      return new Command({
        goto: "runNextStep",
        update: { findings: [`${humanStepLabel(step)} failed — ${kind}: ${detail}`] },
      });
    }

    // Nothing left to run, or the surface itself is gone and the rest of the
    // round would only collect the same failure. Let the operator read it and
    // decide whether a corrected retry is worth a round — bounded by
    // MAX_OPERATOR_ROUNDS.
    return new Command({
      goto: "operator",
      update: {
        operatorRound: state.operatorRound + 1,
        findings: [`${humanStepLabel(step)} failed — ${kind}: ${detail}`],
      },
    });
  }

  return new Command({ goto: "runNextStep" });
}


// One-time side effects for entering the pause: status flip + Slack ping. Kept
// separate from awaitApproval because on resume, LangGraph re-runs the whole node
// function from the top — anything before interrupt() would re-fire a second time.
async function markAwaitingApproval(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket || !state.pendingStepId) return {};
  const step = ticket.plan.find((s) => s.id === state.pendingStepId);
  await updateTicket(state.ticketId, { status: "awaiting_approval" });
  // The step the graph is parked on must *say* it is waiting on a person, or the
  // portal has nothing to render an approve button against and the ticket sits at
  // awaiting_approval with no way out. A capability_missing step arrives here
  // already marked failed/auto — the reviewer cleared it, the agent refused it.
  // `failure` is left in place: awaitApproval reads it to decide grant-vs-release.
  if (step && step.failure?.kind === "capability_missing") {
    await updateStep(state.ticketId, step.id, { status: "pending", approvalMode: "human" });
  }
  appendTrace(
    state.ticketId,
    "interrupt",
    "interrupted",
    step
      ? `graph paused at ${step.capability ?? step.kind} (${step.risk} risk) — waiting for human decision`
      : "graph paused — waiting for human decision",
  );
  if (step) {
    // The employee is told what is being waited on, not which internal gate is
    // holding it: "a check I need signed off" is the true and useful version of
    // "capability_missing".
    await postUpdate(
      ticket,
      step.failure?.kind === "capability_missing"
        ? `⏸ One of the checks I want to run needs a technician to sign it off first — waiting on that now.`
        : `⏸ Waiting on IT approval for: ${humanStepLabel(step)}`,
    );
  }
  return {};
}

async function awaitApproval(state: TState) {
  const pending = (await getTicket(state.ticketId))?.plan.find((s) => s.id === state.pendingStepId);
  const wantsGrant = pending?.failure?.kind === "capability_missing";
  const decision = interrupt({
    ticketId: state.ticketId,
    stepId: state.pendingStepId,
    question: wantsGrant
      ? `Allow the read-only diagnostic "${String(pending?.params?.binary ?? "")}" to run on this ticket?`
      : "Approve this high-risk step?",
  }) as { approved: true; approver: Approver };

  const ticket = await getTicket(state.ticketId);
  const step = ticket?.plan.find((s) => s.id === state.pendingStepId);
  appendTrace(
    state.ticketId,
    "interrupt",
    "resumed",
    `approved by ${decision.approver.name} — resuming from paused step, not restarting`,
  );
  if (ticket && step) {
    // Two different things reach this gate. A high-risk step was never run and
    // just needs releasing. A step refused for a diagnostic the agent will not
    // run by default has already failed once, so the approval has to record the
    // grant and put the step back to pending — otherwise the technician clicks
    // approve and nothing happens, which is the worst outcome of the three.
    const binary =
      step.failure?.kind === "capability_missing" && typeof step.params?.binary === "string"
        ? step.params.binary
        : null;
    if (binary) {
      const already = ticket.grantedBinaries ?? [];
      await updateTicket(state.ticketId, {
        grantedBinaries: already.includes(binary) ? already : [...already, binary],
      });
      await updateStep(state.ticketId, step.id, {
        status: "pending",
        // Back to auto, or runNextStep sees a pending human-gated step and routes
        // it straight back to markAwaitingApproval — approve, re-ask, forever. The
        // grant widened which binary may run; it did not add a standing gate.
        approvalMode: "auto",
        failure: undefined,
        log: [
          ...(step.log ?? []),
          `[Policy] ${binary} approved for this ticket by ${decision.approver.name} (${decision.approver.email}) — retrying the step`,
        ],
      });
    } else {
      await updateStep(state.ticketId, step.id, {
        approvalMode: "auto",
        log: [
          ...(step.log ?? []),
          `[Policy] High-risk step approved by ${decision.approver.name} (${decision.approver.email}) — proceeding`,
        ],
      });
    }
  }

  return new Command({
    goto: "runNextStep",
    update: {
      pendingStepId: null,
      approver: decision.approver,
    },
  });
}

/** The employee confirms the fix; the ticket is not closed on our say-so. */
async function finalize(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};

  const summary =
    state.diagnoses.length > 0
      ? state.diagnoses.map((d, i) => `Look ${i + 1}: ${d}`).join("\n")
      : "Single-pass resolution — no follow-up needed.";

  await updateTicket(state.ticketId, {
    status: "awaiting_confirmation",
    troubleshootingSummary: summary,
    attempts: state.strategyRound,
  });
  appendTrace(
    state.ticketId,
    "finalize",
    "completed",
    `${state.strategyRound} look(s) · asking the employee to confirm the fix worked`,
  );

  const evidence = await evidenceFor(state.ticketId, ticket.workspaceId);
  const hadReplyStep = ticket.plan.some((s) => s.kind === "reply");
  if (!hadReplyStep) {
    const firstName = firstNameOf(ticket.reporter);
    await say(
      ticket,
      "resolution",
      `Hi ${firstName} — I've finished working on this one. Give it another try and let me know how it goes.`,
      {
        agentSummary: state.strategy?.customerSummary || undefined,
        evidence,
        findings: state.findings,
      },
    );
  }

  // No "Is the issue resolved? Reply yes or no" line here any more. It used to
  // go out as its own message directly under the resolution text, which is what
  // made every ticket end on a half-answer followed by a form question — and
  // EmployeePortal already renders Yes/No buttons for exactly this decision. The
  // desk's `resolution` moment asks for the one specific observation instead.
  return {};
}


/**
 * Tier 4. Not a model and not an `interrupt()` — interrupt is pause-and-resume
 * on this thread for a decision the graph needs in order to continue. A handoff
 * is asynchronous and terminal: a technician may pick it up hours later and act
 * entirely outside this system. So it writes the artifact and ends.
 */
async function humanHandoff(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  const evidence = await evidenceFor(state.ticketId, ticket.workspaceId);
  const fresh = await getTicket(state.ticketId);
  const artifact = buildHandoffArtifact(state, fresh ?? ticket, evidence);

  await updateTicket(state.ticketId, {
    status: "escalated",
    troubleshootingSummary: artifact,
    attempts: state.strategyRound,
  });
  appendTrace(
    state.ticketId,
    "humanHandoff",
    "completed",
    `handed to a human after ${state.strategyRound} look(s), with ${state.findings.length} finding(s)`,
  );

  const firstName = firstNameOf(ticket.reporter);
  await say(
    ticket,
    "handoff",
    `Hi ${firstName} — I wasn't able to get to the bottom of this one. I'm handing it to the IT team ` +
      `with everything I checked so they don't have to start over. Ticket ${state.ticketId}.`,
    { findings: state.findings, evidence },
  );

  return new Command({ goto: END });
}

/** The note a technician actually reads. state.findings carries most of it. */
function buildHandoffArtifact(state: TState, ticket: Ticket, evidence: ReplyEvidence[]): string {
  const lines: string[] = [
    `Ticket ${ticket.id} — escalated to a human after ${state.strategyRound} diagnostic look(s).`,
    "",
    `Problem as reported: ${ticket.subject}`,
    `Employee: ${ticket.reporter} <${ticket.reporterEmail}>`,
  ];

  if ((ticket.attachments ?? []).length > 0) {
    lines.push(`They attached ${ticket.attachments!.length} screenshot(s), which the engineer looked at.`);
  }

  // What the machine looked like before anything was planned. A technician
  // starting here needs the baseline as much as the changes — and when it says
  // nothing was collected, that is the first thing they should know.
  if (state.deviceFacts.collected) {
    lines.push("", `Baseline readings taken before planning (${state.deviceFacts.host}):`);
    for (const f of state.deviceFacts.facts) {
      const readings = Object.entries(f.readings)
        .map(([k, v]) => `${k}=${v ?? "null"}`)
        .join(" · ");
      lines.push(`  - ${f.label} [${f.capability}] → ${f.outcome}${readings ? `: ${readings}` : ""}`);
    }
  } else {
    lines.push("", `No baseline readings: ${state.deviceFacts.reason ?? "observation was not attempted"}.`);
  }

  // The trail a technician actually reads first: what was believed, in order,
  // and what the operator hit while carrying each one out. This is the part
  // that tells them where NOT to start.
  if (state.diagnoses.length > 0) {
    lines.push("", "How the diagnosis developed:");
    state.diagnoses.forEach((d, i) => lines.push(`  look ${i + 1}: ${d}`));
  }

  const rejected = state.strategy?.rejectedHypotheses ?? [];
  if (rejected.length > 0) {
    lines.push("", "Ruled out — do not start here:");
    for (const r of rejected) lines.push(`  - ${r.hypothesis} — ${r.ruledOutBy}`);
  }

  if (state.operatorNotes.length > 0) {
    lines.push("", "What the operator reported while carrying it out:");
    for (const n of state.operatorNotes) lines.push(`  - ${n}`);
  }

  if (state.research.length > 0) {
    lines.push("", "What outside sources established, with citations:");
    for (const r of state.research) {
      lines.push(`  - ${r.claim} — ${r.sourceUrl}`);
    }
  }

  if (state.findings.length > 0) {
    lines.push("", "Findings in full:");
    state.findings.forEach((f, i) => lines.push(`  ${i + 1}. ${f}`));
  }

  if (evidence.length > 0) {
    lines.push("", "What ran, with the device's own verdict:");
    for (const e of evidence) {
      lines.push(
        `  - ${e.capability ?? e.stepDescription} → ${e.status.toUpperCase()}` +
          (e.deviceEffect ? `: ${e.deviceEffect}` : ""),
      );
    }
  } else {
    lines.push("", "Nothing was executed on the employee's machine.");
  }

  // Failure kinds, not just failure counts. "2 steps failed" sends a technician
  // to the wrong place; "1 timeout, 1 no_effect" tells them the agent was
  // offline for one and the fix silently did nothing for the other.
  const failures = ticket.plan.filter((s) => s.failure);
  if (failures.length > 0) {
    lines.push("", "Why steps failed:");
    for (const s of failures) {
      lines.push(`  - ${s.capability ?? s.description} → ${s.failure!.kind}: ${s.failure!.detail}`);
    }
  }

  lines.push(
    "",
    "Note: any capability the agent asked for and did not have is listed in the findings above, " +
      "with its risk, the command it proposed, the effect it expected, and the probe fields that " +
      "would verify it.",
  );

  return lines.join("\n");
}

function buildGraph() {
  return new StateGraph(TicketGraphState)
    .addNode("observe", observe)
    .addNode("strategist", strategist, {
      ends: ["operator", "researcher", "finalize", "humanHandoff", "strategist", END],
    })
    .addNode("operator", operator, {
      ends: ["intentValidator", "strategist", "humanHandoff", END],
    })
    .addNode("researcher", researcher, { ends: ["strategist"] })
    // Between the operator and the reviewer, so nothing reaches the per-step
    // gate without the plan having been weighed as a whole first.
    .addNode("intentValidator", intentValidator, {
      ends: ["reviewSteps", "humanHandoff"],
    })
    .addNode("reviewSteps", reviewSteps)
    .addNode("runNextStep", runNextStep, {
      ends: ["runNextStep", "markAwaitingApproval", "operator", "strategist", "humanHandoff", END],
    })
    .addNode("markAwaitingApproval", markAwaitingApproval)
    .addNode("awaitApproval", awaitApproval, { ends: ["runNextStep"] })
    .addNode("finalize", finalize)
    .addNode("humanHandoff", humanHandoff, { ends: [END] })
    // One context branch, so there is no barrier join and nothing to deadlock
    // on. Both loops re-enter their node freely.
    .addEdge(START, "observe")
    .addEdge("observe", "strategist")
    .addEdge("reviewSteps", "runNextStep")
    .addEdge("markAwaitingApproval", "awaitApproval")
    .addEdge("finalize", END)
    .compile({ checkpointer });
}


declare global {
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH_CHECKPOINTER__: MemorySaver | undefined;
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH__: ReturnType<typeof buildGraph> | undefined;
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH_LIVE__: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH_SWEEP_AT__: number | undefined;
}

const checkpointer: MemorySaver = globalThis.__TICKET_GRAPH_CHECKPOINTER__ ?? new MemorySaver();
if (!globalThis.__TICKET_GRAPH_CHECKPOINTER__) globalThis.__TICKET_GRAPH_CHECKPOINTER__ = checkpointer;

export const ticketGraph = globalThis.__TICKET_GRAPH__ ?? buildGraph();
if (!globalThis.__TICKET_GRAPH__) globalThis.__TICKET_GRAPH__ = ticketGraph;

function tracingConfig(ticketId: string) {
  return {
    // The planner is now re-entrant, so escalation is a real cycle rather than
    // a straight line of distinct nodes. Worst case is 3 tiers × (draft, review,
    // gate, persist) plus a self-looping execute node per step and up to 2
    // verify/replan rounds per tier — comfortably past LangGraph's default of
    // 25 supersteps. The bound still exists; it just no longer fires on a
    // legitimate deep ticket.
    recursionLimit: 100,
    configurable: { thread_id: ticketId },
    runName: `ticket:${ticketId}`,
    tags: [`ticket:${ticketId}`],
    metadata: { ticketId },
  };
}

// ---- crash + orphan recovery -----------------------------------------------
// Node-level failures already end at humanHandoff with an artifact. These cover
// the two ways a ticket used to stay stuck with nobody owning it:
//   1. the run throws out of the graph (a bug, the recursion limit, a transport
//      failure) — the row kept its last status and nobody was told;
//   2. the process restarts mid-run — MemorySaver is process memory, so the
//      checkpoint is gone and a `new`/`executing` row can never resume.
// Both now end the way every other failure does: the employee is told, and the
// ticket lands in the IT queue as `escalated` with a note saying what happened.

const liveRuns: Set<string> = globalThis.__TICKET_GRAPH_LIVE__ ?? new Set();
if (!globalThis.__TICKET_GRAPH_LIVE__) globalThis.__TICKET_GRAPH_LIVE__ = liveRuns;

async function escalateDeadRun(ticketId: string, why: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  if (ticket.status === "resolved" || ticket.status === "escalated" || ticket.status === "awaiting_confirmation") return;
  await updateTicket(ticketId, {
    status: "escalated",
    troubleshootingSummary:
      `Ticket ${ticketId} — escalated because the automated run stopped before reaching a verdict.\n\n` +
      `Problem as reported: ${ticket.subject}\n` +
      `Employee: ${ticket.reporter} <${ticket.reporterEmail}>\n\n` +
      `What happened: ${why}\n` +
      `No automated work is still running on this ticket; a technician should take over from here.`,
  });
  appendTrace(ticketId, "humanHandoff", "completed", `escalated without a graph verdict: ${why}`);
  const firstName = firstNameOf(ticket.reporter);
  await say(
    ticket,
    "handoff",
    `Hi ${firstName} — I hit a problem on my side and couldn't finish this one automatically. ` +
      `I've passed it to the IT team so a person can pick it up. Ticket ${ticketId}.`,
  );
}

async function runGuarded(ticketId: string, run: () => Promise<unknown>): Promise<void> {
  liveRuns.add(ticketId);
  try {
    await run();
  } catch (err) {
    console.error(`[ticket-graph] run died for ${ticketId}:`, err);
    const detail = err instanceof Error ? err.message : String(err);
    await escalateDeadRun(ticketId, `the automation crashed mid-run (${detail})`).catch((e) =>
      console.error(`[ticket-graph] escalateDeadRun failed for ${ticketId}:`, e),
    );
  } finally {
    liveRuns.delete(ticketId);
  }
}

// `new` can sit un-run for the beat between the row insert and `after()` firing;
// anything past this age with no live run is an orphan, not a slow start.
const ORPHAN_GRACE_MS = 90_000;
const SWEEP_EVERY_MS = 30_000;

/**
 * Escalates tickets whose run no longer exists. Called from /api/state (polled
 * constantly, throttled here), so recovery needs no cron and no extra process.
 * `awaiting_approval` / `awaiting_confirmation` are deliberately left alone —
 * they are waiting on a person, not on a dead run; if the checkpoint behind an
 * approval died with the process, the resume itself fails into runGuarded.
 */
export async function sweepOrphanedTickets(): Promise<void> {
  const now = Date.now();
  if (now - (globalThis.__TICKET_GRAPH_SWEEP_AT__ ?? 0) < SWEEP_EVERY_MS) return;
  globalThis.__TICKET_GRAPH_SWEEP_AT__ = now;
  try {
    const tickets = await listTickets();
    for (const t of tickets) {
      if (t.status !== "new" && t.status !== "executing" && t.status !== "drafting") continue;
      if (liveRuns.has(t.id)) continue;
      if (now - t.updatedAt < ORPHAN_GRACE_MS) continue;
      await escalateDeadRun(
        t.id,
        "the server restarted (or the run was killed) while this ticket was in flight; in-memory run state does not survive that, so the run can never finish on its own",
      );
    }
  } catch (err) {
    console.error("[ticket-graph] sweepOrphanedTickets failed:", err);
  }
}

export async function runTicketGraphFromStart(ticketId: string): Promise<void> {
  await runGuarded(ticketId, () => ticketGraph.invoke({ ticketId }, tracingConfig(ticketId)));
}

export async function resumeTicketGraph(
  ticketId: string,
  decision: { approved: true; approver: Approver },
): Promise<void> {
  await runGuarded(ticketId, () =>
    ticketGraph.invoke(new Command({ resume: decision }), tracingConfig(ticketId)),
  );
}

/**
 * The employee says it is still broken. Take one more look.
 *
 * Same `thread_id`, so `diagnoses`, `findings`, `research` and the executed
 * history all carry over — the strategist gets a second look at a ticket it
 * already knows, not a blank one. What resets is the round budget, because this
 * is a new problem statement rather than a continuation of the old one.
 *
 * The START edge runs `observe` again, which is the point: the machine is not
 * what it was when the first look planned against it, and the readings taken
 * after a fix landed are the ones that say whether it did.
 *
 * `reopens` is what stops this being a loop — the strategist hands off once it
 * passes MAX_REOPENS. Escalation is the caller's job when the budget is gone;
 * this function is only the second-look path.
 */
export async function reopenTicketGraph(ticketId: string, detail: string): Promise<void> {
  const current = await ticketGraph.getState(tracingConfig(ticketId)).catch(() => null);
  const reopens = ((current?.values as TState | undefined)?.reopens ?? 0) + 1;
  await runGuarded(ticketId, () =>
    ticketGraph.invoke(
      {
        ticketId,
        followUps: [detail],
        reopens,
        // A fresh budget for a fresh account of the problem. The reopen count is
        // the bound that matters; carrying an exhausted strategyRound over would
        // send the second look straight to handoff without ever running.
        strategyRound: 1,
        operatorRound: 1,
        strategy: null,
      },
      tracingConfig(ticketId),
    ),
  );
}