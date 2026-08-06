import { StateGraph, Annotation, START, END, MemorySaver, interrupt, Command } from "@langchain/langgraph";
import {
  getTicket,
  updateTicket,
  updateStep,
  listAgentJobs,
  listDevices,
  getADUser,
  getUserMemory,
  rememberUserFact,
  rememberUserEpisode,
  listIncidents,
  rememberIncident,
} from "@/lib/data";
import { Citation, PlanStep, StepFailure, Ticket } from "@/lib/types";
import { UserMemory, EMPTY_MEMORY, preferredName } from "@/lib/memory";
import { DraftResult, RejectedHypothesis } from "@/lib/integrations/draft";
import { REVIEWER_MODEL, reviewPlan } from "@/lib/reviewer";
import {
  aiGatewayDraft,
  communicate,
  synthesizeReply,
  verifyAndReplan,
  extractUserMemory,
  type ReplyEvidence,
} from "@/lib/integrations/ai-gateway";
import { isAgentJobCapability } from "@/lib/agent-jobs";
import { appendTrace } from "@/lib/trace";
import { readHeartbeat, HEARTBEAT_CONNECTED_WINDOW_MS } from "@/lib/agent-heartbeat";
import { CommunicationMoment, Tier, nextTier, tierSpec } from "@/lib/tiers";
import { EXECUTORS } from "@/lib/executors";
import {
  EMPTY_STATS,
  IncidentCategory,
  IncidentStats,
  MIN_SAMPLES,
  classifyIncident,
  summarizeIncidents,
} from "@/lib/incidents";
import {
  buildReplyEvidence,
  firstNameOf,
  humanStepLabel,
  postUpdate,
  substituteParams,
  waitForAgentJobs,
} from "@/lib/ticket-helpers";

export interface Approver {
  name: string;
  email: string;
}

/**
 * What one tier concluded, in structure rather than prose. Written once per tier
 * that drafts, and read only at handoff — a technician inheriting the ticket
 * gets the case in the order a colleague would tell it: what each tier thought,
 * what it ruled out, and why it let go.
 *
 * This is a decision record, never chain of thought. `rejected` holds
 * conclusions the tier reached and the observation that killed each one.
 */
export interface TierDecision {
  tier: Tier;
  hypothesis: string;
  rejected: RejectedHypothesis[];
  capabilitiesConsidered: string[];
  /** How this tier's turn ended, in a few words. */
  outcome: string;
}

function decisionFrom(draft: DraftResult, outcome: string): TierDecision {
  return {
    tier: draft.tier,
    hypothesis: draft.hypothesis || draft.reasoning,
    rejected: draft.rejectedHypotheses,
    capabilitiesConsidered: draft.capabilitiesConsidered,
    outcome,
  };
}

const DRAFT_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const overwrite = <T,>(_current: T, update: T) => update;

const TicketGraphState = Annotation.Root({
  ticketId: Annotation<string>(),
  profile: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  memory: Annotation<UserMemory>({ reducer: overwrite, default: () => EMPTY_MEMORY }),
  deviceContext: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  // Problem class + what has actually worked on it before, across everyone.
  incidentCategory: Annotation<IncidentCategory>({ reducer: overwrite, default: () => "other" }),
  incidents: Annotation<IncidentStats>({ reducer: overwrite, default: () => EMPTY_STATS("other") }),
  draft: Annotation<DraftResult | null>({ reducer: overwrite, default: () => null }),
  citations: Annotation<Citation[]>({ reducer: overwrite, default: () => [] }),
  classifiedPlan: Annotation<PlanStep[]>({ reducer: overwrite, default: () => [] }),
  attempt: Annotation<number>({ reducer: overwrite, default: () => 1 }),
  // Escalation depth. Every ticket starts at first-line and only ever moves down.
  tier: Annotation<Tier>({ reducer: overwrite, default: () => 1 }),
  findings: Annotation<string[]>({ reducer: (cur, upd) => cur.concat(upd), default: () => [] }),
  /**
   * Every confidence this ticket has been assigned, oldest first: the drafting
   * tier's, then one per verification round. Kept as a trail rather than a
   * single number because the SHAPE carries the information — 0.8 → 0.4 means
   * the evidence contradicted a confident plan, which is a different situation
   * from 0.4 → 0.4, and only the first is worth escalating on.
   */
  confidenceTrail: Annotation<number[]>({ reducer: (cur, upd) => cur.concat(upd), default: () => [] }),
  // One record per tier that reasoned about this ticket. `findings` is prose for
  // the next model to read; this is structure for a human to read.
  decisions: Annotation<TierDecision[]>({ reducer: (cur, upd) => cur.concat(upd), default: () => [] }),
  pendingStepId: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  approver: Annotation<Approver | null>({ reducer: overwrite, default: () => null }),
});

type TState = typeof TicketGraphState.State;

// ---- the service desk ------------------------------------------------------
// Tier 1 owns every word the employee sees, for the whole life of the ticket —
// including work done by tiers 2 and 3, which have no reply capability at all.
// One voice start to finish, so an escalation reads as the problem being taken
// more seriously rather than as being passed between strangers.
//
// Always posts something. If the desk model is unavailable the deterministic
// fallback goes out instead: silence during a slow tier is the failure mode this
// whole arrangement exists to prevent.
async function say(
  ticket: Ticket,
  memory: UserMemory,
  tier: Tier,
  moment: CommunicationMoment,
  fallback: string,
  extras: {
    tierSummary?: string;
    plannedSteps?: string[];
    evidence?: ReplyEvidence[];
    findings?: string[];
  } = {},
): Promise<void> {
  const text = await communicate({
    ticketId: ticket.id,
    moment,
    tier,
    reporterFirstName: preferredName(memory, firstNameOf(ticket.reporter)),
    subject: ticket.subject,
    body: ticket.body,
    ...extras,
  }).catch(() => null);
  await postUpdate(ticket, text ?? fallback);
}

// A fix a tier needed and did not have. It cannot be registered at runtime — a
// handler with no probe produces no before/after facts, so it could never be
// verified — but it is exactly the spec a human needs to add one, so it rides
// along in the findings and lands in the handoff artifact.
function noteCapabilityRequest(ticketId: string, draft: DraftResult): string | null {
  const req = draft.capabilityRequest;
  if (!req) return null;
  appendTrace(
    ticketId,
    "capabilityRequest",
    "completed",
    `tier ${draft.tier} asked for a new capability "${req.name}": ${req.why || "(no reason given)"}`,
  );
  return (
    `tier ${draft.tier} requested a capability it does not have — ${req.name} (${req.risk} risk): ${req.why}. ` +
    `Proposed command: ${req.command}. Expected effect: ${req.expectedEffect || "(not stated)"}. ` +
    `Verify via: ${req.probeFields.join(", ") || "(no probe proposed)"}. ` +
    `Reversible by: ${req.reversible || "(not stated)"}.`
  );
}

// ---- context gathering: three unconditional parallel branches from START.

// Who is this person, per the directory we own.
async function gatherProfile(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const user = await getADUser(ticket.reporterEmail).catch(() => null);
  const profile = user ? `${user.name} · ${user.title}, ${user.team} team` : null;
  appendTrace(state.ticketId, "gatherProfile", "completed", profile ?? "no directory record", Date.now() - t0);
  return { profile };
}

// What we have learned about them before: keyed facts + recent ticket history.
async function gatherMemory(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const memory = await getUserMemory(ticket.workspaceId, ticket.reporterEmail).catch(() => EMPTY_MEMORY);
  appendTrace(
    state.ticketId,
    "gatherMemory",
    "completed",
    `${memory.facts.length} fact(s), ${memory.episodes.length} past ticket(s)`,
    Date.now() - t0,
  );
  return { memory };
}

async function gatherDeviceContext(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const devices = await listDevices(ticket.workspaceId);
  const device = devices.find((d) => d.ownerEmail === ticket.reporterEmail);
  const hb = readHeartbeat();
  const live =
    hb &&
    Date.now() - hb.lastPingAt < HEARTBEAT_CONNECTED_WINDOW_MS &&
    device &&
    hb.hostname.toLowerCase() === device.hostname.toLowerCase();
  const detail = device
    ? `${device.hostname} (${device.os})${live ? " · agent online now" : ""}`
    : "no registered device for reporter";
  appendTrace(state.ticketId, "gatherDeviceContext", "completed", detail, Date.now() - t0);
  return { deviceContext: device ? detail : null };
}

// What happened the last time this KIND of problem came in, across everyone.
// Runs on the same parallel fan-out as the other context branches: the category
// is a pure function of the ticket text, so this costs one read and no model
// call. Degrades to empty stats — never to a thrown error.
async function gatherIncidentHistory(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const category = classifyIncident(ticket.subject, ticket.body);
  const rows = await listIncidents(ticket.workspaceId, category).catch(() => []);
  const stats = summarizeIncidents(category, rows);
  const best = stats.capabilities.find((c) => c.attempts >= MIN_SAMPLES && c.successRate > 0);
  appendTrace(
    state.ticketId,
    "gatherIncidentHistory",
    "completed",
    `classed as "${category}" · ${stats.total} past ticket(s), ${stats.resolved} resolved` +
      (best ? ` · best so far: ${best.capability} at ${Math.round(best.successRate * 100)}%` : ""),
    Date.now() - t0,
  );
  return { incidentCategory: category, incidents: stats };
}

/**
 * One tier's attempt at the problem. Shared by the first-line draft node and by
 * escalateTier, so a deeper tier reasons through exactly the same path — same
 * memory, different model, prompt and capability set.
 */
async function draftAtTier(
  state: TState,
  ticket: Ticket,
  tier: Tier,
): Promise<DraftResult | null> {
  const spec = tierSpec(tier);
  return withTimeout(
    aiGatewayDraft({
      ticketId: ticket.id,
      subject: ticket.subject,
      body: ticket.body,
      reporter: ticket.reporter,
      reporterEmail: ticket.reporterEmail,
      customerOrg: ticket.customerOrg,
      workspaceId: ticket.workspaceId,
      memory: state.memory,
      tier,
      priorFindings: state.findings,
      incidents: state.incidents,
    }),
    Math.max(DRAFT_TIMEOUT_MS, spec.budgetMs),
    `draftPlan:tier${tier}`,
  );
}

async function draftPlanNode(state: TState) {
  const t0 = Date.now();
  const spec = tierSpec(state.tier);
  appendTrace(
    state.ticketId,
    "draftPlan",
    "started",
    `tier ${state.tier} (${spec.label}, ${spec.model}) drafting from memory + device context`,
  );
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  try {
    const draft = await draftAtTier(state, ticket, state.tier);
    // No AI_GATEWAY_API_KEY, or the endpoint returned nothing usable. Treated
    // the same as a thrown error: fall through to the acknowledge-only plan
    // below rather than inventing steps we have no grounding for.
    if (!draft) throw new Error("no drafting provider available");
    appendTrace(
      state.ticketId,
      "draftPlan",
      "completed",
      draft.escalate
        ? `tier ${state.tier} declined: ${draft.escalateReason}`
        : `${draft.plan.length} step(s) via ${draft.source} · confidence ${Math.round(draft.confidence * 100)}%` +
          (draft.hypothesis ? ` · hypothesis: ${draft.hypothesis}` : ""),
      Date.now() - t0,
    );
    const capabilityNote = noteCapabilityRequest(state.ticketId, draft);
    return capabilityNote ? { draft, findings: [capabilityNote] } : { draft };
  } catch (err) {
    console.warn(`[draftPlanNode] ${state.ticketId} failed (${(err as Error).message}); using minimal fallback`);
    appendTrace(
      state.ticketId,
      "draftPlan",
      "failed",
      `${(err as Error).message} — using minimal fallback plan`,
      Date.now() - t0,
    );
    const firstName = firstNameOf(ticket.reporter);
    const fallback: DraftResult = {
      citations: [],
      confidence: 0.4,
      reasoning: "draft failed — minimal fallback",
      response: `Hi ${firstName} — I'm taking a look at this and will follow up shortly. Could you share any error message or screenshot if you have one?`,
      plan: [
        { id: "step-0", kind: "reply", description: "Acknowledge and ask for more detail", status: "pending" },
      ],
      source: "fallback",
      tier: state.tier,
      // A drafting outage is not a reason to escalate: the deeper tier would hit
      // the same dead provider. Acknowledge honestly and stop.
      escalate: false,
      escalateReason: "",
      hypothesis: "",
      // Nothing reasoned about this ticket, so there are no discarded
      // explanations and no capability to ask for.
      rejectedHypotheses: [],
      capabilitiesConsidered: [],
      capabilityRequest: null,
    };
    return { draft: fallback };
  }
}

// Join node: waits on all three context branches + the draft.
async function classifyRisk(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket || !state.draft) return {};
  const draft = state.draft;

  const citations: Citation[] = [...draft.citations];
  if (state.profile) {
    citations.push({
      source: "memory",
      title: state.profile,
      snippet: state.memory.facts.map((f) => `${f.key}: ${f.value}`).join(" · ") || "no stored facts yet",
      ref: `user:${ticket.reporterEmail}`,
    });
  }
  for (const e of state.memory.episodes) {
    citations.push({
      source: "memory",
      title: `Past ticket ${e.ticketId}`,
      snippet: e.summary.slice(0, 220),
      ref: `episode:${e.ticketId}`,
    });
  }

  const rawPlan: PlanStep[] = draft.plan.map((step) => ({
    ...step,
    params: substituteParams(step.params, ticket.reporterEmail),
  }));
  const plan = await reviewPlan(rawPlan, ticket);

  const gated = plan.filter((s) => s.approvalMode === "human").length;
  const blocked = plan.filter((s) => s.status === "failed").length;
  appendTrace(
    state.ticketId,
    "reviewPlan",
    "completed",
    `${plan.length} step(s) reviewed by ${REVIEWER_MODEL}: ${plan.length - gated} auto, ${gated} need a person` +
      (blocked ? `, ${blocked} refused outright` : ""),
    Date.now() - t0,
  );
  return { citations, classifiedPlan: plan };
}

// Persist + notify, then walk straight into execution — no whole-plan stop.
async function persistPlan(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket || !state.draft) return {};
  await updateTicket(state.ticketId, {
    status: "executing",
    citations: state.citations,
    confidence: state.draft.confidence,
    draftResponse: state.draft.response,
    plan: state.classifiedPlan,
    tier: state.tier,
  });
  appendTrace(
    state.ticketId,
    "persistPlan",
    "completed",
    `plan saved at tier ${state.tier} (${tierSpec(state.tier).label}) · entering execute loop`,
  );

  const updatedForSlack = await getTicket(state.ticketId);
  if (updatedForSlack) {
    const firstName = preferredName(state.memory, firstNameOf(ticket.reporter));
    const planLines = state.classifiedPlan.map((s, i) => `   ${i + 1}. ${humanStepLabel(s)}`).join("\n");
    await say(
      updatedForSlack,
      state.memory,
      state.tier,
      "intake",
      `Hi ${firstName} — here's what I'm going to check:\n${planLines}\n\n_Ticket ${state.ticketId}_`,
      {
        tierSummary: state.draft.response || undefined,
        plannedSteps: state.classifiedPlan.map((s) => humanStepLabel(s)),
      },
    );
  }
  return {};
}

// Does this tier's draft deserve to run? Three ways it does not: the tier said
// so itself, it asked for a capability above its depth (both arrive as
// draft.escalate), or it is not confident enough to be worth the employee's
// time. Any of them hands the problem down rather than executing a guess.
function tierGate(state: TState) {
  const draft = state.draft;
  if (!draft) return new Command({ goto: "persistPlan" });
  const spec = tierSpec(state.tier);

  if (draft.escalate) {
    const reason = draft.escalateReason || draft.reasoning;
    return new Command({
      goto: "escalateTier",
      update: {
        findings: [`tier ${state.tier} declined: ${reason}`],
        decisions: [decisionFrom(draft, `declined and escalated: ${reason}`)],
      },
    });
  }

  // A fallback draft has no provider behind it — escalating would only re-run the
  // same outage against a more expensive model.
  if (draft.source !== "fallback" && draft.confidence < spec.confidenceFloor) {
    appendTrace(
      state.ticketId,
      "tierGate",
      "completed",
      `tier ${state.tier} confidence ${Math.round(draft.confidence * 100)}% below floor ${Math.round(
        spec.confidenceFloor * 100,
      )}% — escalating rather than guessing`,
    );
    return new Command({
      goto: "escalateTier",
      update: {
        findings: [
          `tier ${state.tier} was only ${Math.round(draft.confidence * 100)}% confident: ${draft.reasoning}`,
        ],
        decisions: [
          decisionFrom(
            draft,
            `escalated on confidence — ${Math.round(draft.confidence * 100)}% against a ${Math.round(
              spec.confidenceFloor * 100,
            )}% floor`,
          ),
        ],
      },
    });
  }

  if (state.classifiedPlan.length === 0) {
    return new Command({
      goto: "escalateTier",
      update: {
        findings: [`tier ${state.tier} produced no runnable steps`],
        decisions: [decisionFrom(draft, "produced no runnable steps")],
      },
    });
  }

  return new Command({
    goto: "persistPlan",
    update: {
      decisions: [decisionFrom(draft, `took the ticket with ${state.classifiedPlan.length} step(s)`)],
      confidenceTrail: [draft.confidence],
    },
  });
}

// Hand the problem to the next tier down: stronger model, wider capability set,
// and every finding so far in its context. The redraft happens here rather than
// by looping back to draftPlan, because draftPlan sits behind a barrier join on
// the three context branches and re-entering it alone would deadlock.
async function escalateTier(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  const next = nextTier(state.tier);
  if (!next) {
    appendTrace(
      state.ticketId,
      "escalate",
      "completed",
      `tier ${state.tier} is the deepest tier — handing to a human technician with findings`,
    );
    return new Command({ goto: "humanHandoff" });
  }

  const spec = tierSpec(next);
  const t0 = Date.now();
  appendTrace(
    state.ticketId,
    `escalate:tier${next}`,
    "started",
    `tier ${state.tier} → tier ${next} (${spec.label}, ${spec.model})`,
  );

  const draft = await draftAtTier(state, ticket, next).catch(() => null);

  if (!draft) {
    appendTrace(
      state.ticketId,
      `escalate:tier${next}`,
      "failed",
      "no drafting provider available — handing to a human",
      Date.now() - t0,
    );
    return new Command({ goto: "humanHandoff", update: { tier: next } });
  }

  if (draft.escalate || draft.plan.length === 0) {
    // This tier also declined. Self-loop: nextTier() returns null at 3, so the
    // chain always terminates at the human handoff above.
    appendTrace(
      state.ticketId,
      `escalate:tier${next}`,
      "completed",
      `tier ${next} also declined: ${draft.escalateReason || "no runnable steps"}`,
      Date.now() - t0,
    );
    return new Command({
      goto: "escalateTier",
      update: {
        tier: next,
        attempt: 1,
        findings: [`tier ${next} declined: ${draft.escalateReason || draft.reasoning}`],
        decisions: [
          decisionFrom(draft, `declined: ${draft.escalateReason || "produced no runnable steps"}`),
        ],
      },
    });
  }

  const withParams = draft.plan.map((s) => ({
    ...s,
    params: substituteParams(s.params, ticket.reporterEmail),
  }));
  const classified = await reviewPlan(withParams, ticket);

  await updateTicket(state.ticketId, {
    status: "executing",
    plan: [...ticket.plan, ...classified],
    tier: next,
  });

  appendTrace(
    state.ticketId,
    `escalate:tier${next}`,
    "completed",
    `tier ${next} took the ticket: ${classified.length} step(s) — ${classified
      .map((s) => s.capability ?? s.kind)
      .join(", ")}` + (draft.hypothesis ? ` · hypothesis: ${draft.hypothesis}` : ""),
    Date.now() - t0,
  );

  const firstName = preferredName(state.memory, firstNameOf(ticket.reporter));
  await say(
    ticket,
    state.memory,
    next,
    "escalation",
    `Hi ${firstName} — this one needs deeper diagnostics than the first pass could give it, so I've brought in more capable tooling. ` +
      `Next: ${classified.map((s) => humanStepLabel(s)).join(", ")}.`,
    {
      tierSummary: draft.response || undefined,
      plannedSteps: classified.map((s) => humanStepLabel(s)),
      findings: state.findings,
    },
  );

  const capabilityNote = noteCapabilityRequest(state.ticketId, draft);

  return new Command({
    goto: "runNextStep",
    update: {
      tier: next,
      attempt: 1,
      draft,
      classifiedPlan: classified,
      ...(capabilityNote ? { findings: [capabilityNote] } : {}),
      decisions: [decisionFrom(draft, `took the ticket with ${classified.length} step(s)`)],
    },
  });
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

  try {
    const result = await EXECUTORS[step.kind](ticket, step);
    ok = result.ok;
    log = result.log;
    failure = result.failure;
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
    status: ok ? "succeeded" : "failed",
    log,
    finishedAt: Date.now(),
    ...(failure ? { failure } : {}),
  });
  return { ok, failure };
}

// Self-looping execute node. Auto steps run immediately; only a step whose
// approvalMode is still "human" routes to the approval interrupt.
async function runNextStep(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  const step = ticket.plan.find((s) => s.status === "pending");
  if (!step) return new Command({ goto: "verifyOutcome" });

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
    // Fail fast — no retry of a step the evidence says did not work. It routes
    // through humanHandoff rather than ending here so the technician who picks
    // this up gets the artifact: what ran, what the machine said, why it failed.
    appendTrace(
      state.ticketId,
      "escalate",
      "completed",
      `step failed (${failure?.kind ?? "execution"}) — fail-fast, no retry, handing to a human`,
    );
    return new Command({
      goto: "humanHandoff",
      update: {
        findings: [
          `tier ${state.tier}: ${humanStepLabel(step)} failed — ${failure?.kind ?? "execution"}: ${
            failure?.detail ?? "no detail"
          }`,
        ],
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
  appendTrace(
    state.ticketId,
    "interrupt",
    "interrupted",
    step
      ? `graph paused at ${step.capability ?? step.kind} (${step.risk} risk) — waiting for human decision`
      : "graph paused — waiting for human decision",
  );
  if (step) {
    await postUpdate(ticket, `⏸ Waiting on IT approval for: ${humanStepLabel(step)}`);
  }
  return {};
}

async function awaitApproval(state: TState) {
  const decision = interrupt({
    ticketId: state.ticketId,
    stepId: state.pendingStepId,
    question: "Approve this high-risk step?",
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
    await updateStep(state.ticketId, step.id, {
      approvalMode: "auto",
      log: [
        ...(step.log ?? []),
        `[Policy] High-risk step approved by ${decision.approver.name} (${decision.approver.email}) — proceeding`,
      ],
    });
  }

  return new Command({
    goto: "runNextStep",
    update: {
      pendingStepId: null,
      approver: decision.approver,
    },
  });
}

// The troubleshooting loop: after every round of steps, look at what the
// machine actually reported and decide — resolved, or try the next thing?
// This is what separates "ran a plan" from "troubleshot the problem".
async function verifyOutcome(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  // Let any queued local-agent jobs land so we judge on real output.
  await waitForAgentJobs(state.ticketId, 20_000);
  const fresh = await getTicket(state.ticketId);
  const allJobs = await listAgentJobs(ticket.workspaceId);
  const jobsForTicket = allJobs.filter((j) => j.ticketId === state.ticketId);
  const evidence = buildReplyEvidence(fresh?.plan ?? [], jobsForTicket);

  // How many rounds this tier gets before the ticket moves down is the tier's
  // own budget, not one global number.
  const maxAttempts = tierSpec(state.tier).maxAttempts;

  const verdict = await verifyAndReplan({
    ticketId: state.ticketId,
    confidenceTrail: state.confidenceTrail,
    subject: ticket.subject,
    body: ticket.body,
    attempt: state.attempt,
    maxAttempts,
    evidence,
    priorFindings: state.findings,
    userContext: state.profile ?? undefined,
    deviceContext: state.deviceContext ?? undefined,
    memory: state.memory,
    tier: state.tier,
  }).catch(() => null);

  if (!verdict) {
    appendTrace(state.ticketId, "verifyOutcome", "completed", "verifier unavailable — accepting current result", Date.now() - t0);
    return new Command({ goto: "finalizeExecution" });
  }

  const finding = `tier ${state.tier}: ${verdict.hypothesis || verdict.reasoning}`;
  appendTrace(
    state.ticketId,
    "verifyOutcome",
    "completed",
    `tier ${state.tier} attempt ${state.attempt}/${maxAttempts} — ${
      verdict.resolved ? "believes RESOLVED" : "NOT resolved"
    } (${Math.round(verdict.confidence * 100)}%): ${verdict.reasoning}`,
    Date.now() - t0,
  );

  if (verdict.resolved) {
    return new Command({
      goto: "finalizeExecution",
      update: { findings: [finding], confidenceTrail: [verdict.confidence] },
    });
  }

  const outOfAttempts = state.attempt >= maxAttempts;
  const outOfIdeas = verdict.nextSteps.length === 0;

  if (outOfAttempts || outOfIdeas) {
    // This tier is done. If there is a deeper one, it gets the problem plus
    // everything learned so far — that is the escalation, and it is the normal
    // path, not a failure. Only the deepest tier hands off to a human.
    if (nextTier(state.tier)) {
      appendTrace(
        state.ticketId,
        "exhausted",
        "completed",
        outOfIdeas
          ? `tier ${state.tier} has no next step within its capabilities — escalating`
          : `tier ${state.tier} used its ${maxAttempts} attempt(s) without a fix — escalating`,
      );
      return new Command({
        goto: "escalateTier",
        update: { findings: [finding], confidenceTrail: [verdict.confidence] },
      });
    }
    appendTrace(
      state.ticketId,
      "exhausted",
      "completed",
      `no fix after tier ${state.tier} — handing to a human with findings`,
    );
    return new Command({
      goto: "humanHandoff",
      update: { findings: [finding], confidenceTrail: [verdict.confidence] },
    });
  }

  return new Command({
    goto: "replan",
    update: {
      findings: [finding],
      classifiedPlan: verdict.nextSteps,
      confidenceTrail: [verdict.confidence],
    },
  });
}

// Classify the newly proposed steps (same risk gate as round one — a follow-up
// fix gets no free pass) and append them to the ticket's plan.
async function replan(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  const nextAttempt = state.attempt + 1;
  const withParams = state.classifiedPlan.map((s) => ({
    ...s,
    params: substituteParams(s.params, ticket.reporterEmail),
  }));
  const classified = await reviewPlan(withParams, ticket);

  await updateTicket(state.ticketId, {
    status: "executing",
    plan: [...ticket.plan, ...classified],
  });

  appendTrace(
    state.ticketId,
    "replan",
    "completed",
    `attempt ${nextAttempt}: trying ${classified.length} new step(s) — ${classified
      .map((s) => s.capability ?? s.kind)
      .join(", ")}`,
    Date.now() - t0,
  );

  const firstName = preferredName(state.memory, firstNameOf(ticket.reporter));
  await say(
    ticket,
    state.memory,
    state.tier,
    "heartbeat",
    `Hi ${firstName} — the first approach didn't resolve it. Trying: ${classified
      .map((s) => humanStepLabel(s))
      .join(", ")}`,
    {
      plannedSteps: classified.map((s) => humanStepLabel(s)),
      findings: state.findings,
    },
  );

  return new Command({ goto: "runNextStep", update: { attempt: nextAttempt } });
}

async function finalizeExecution(state: TState) {
  const finishedTicket = await getTicket(state.ticketId);
  if (!finishedTicket) return {};

  // Always leave a troubleshooting record on the ticket — even when unresolved,
  // a technician picking this up should see what was tried and what was found.
  const summary =
    state.findings.length > 0
      ? state.findings.map((f, i) => `Attempt ${i + 1}: ${f}`).join("\n")
      : "Single-pass resolution — no follow-up attempts needed.";
  await updateTicket(state.ticketId, {
    status: "awaiting_confirmation",
    troubleshootingSummary: summary,
    attempts: state.attempt,
  });
  appendTrace(
    state.ticketId,
    "finalize",
    "completed",
    `${state.attempt} attempt(s) · asking the user to confirm the fix worked`,
  );

  await updateUserMemory(state, finishedTicket, summary);
  // The agent believes this worked, but the employee has not confirmed yet, so
  // the incident is filed as resolved on the strength of the device evidence
  // that got us here — the same evidence the verifier used.
  await recordIncident(state, finishedTicket, true);

  {
    const firstName = preferredName(state.memory, firstNameOf(finishedTicket.reporter));
    const hadReplyStep = finishedTicket.plan.some((s) => s.kind === "reply");

    if (!hadReplyStep) {
      await waitForAgentJobs(state.ticketId, 20_000);
      const refreshed = await getTicket(state.ticketId);
      const stepsForSynth = refreshed?.plan ?? [];
      const allJobs = await listAgentJobs(finishedTicket.workspaceId);
      const jobsForTicket = allJobs.filter((j) => j.ticketId === state.ticketId);
      const evidence = buildReplyEvidence(stepsForSynth, jobsForTicket);
      // The desk explains the outcome, whichever tier actually did the work.
      const synthesized = await communicate({
        ticketId: state.ticketId,
        moment: "resolution",
        tier: state.tier,
        reporterFirstName: firstName,
        subject: finishedTicket.subject,
        body: finishedTicket.body,
        tierSummary: state.draft?.response || undefined,
        evidence,
        findings: state.findings,
      }).catch(() => null);
      // Falls back to the older evidence-only writer rather than going silent.
      const text =
        synthesized ??
        (await synthesizeReply({
          ticketId: state.ticketId,
          reporterFirstName: firstName,
          subject: finishedTicket.subject,
          body: finishedTicket.body,
          evidence,
        }).catch(() => null));
      if (text) {
        await postUpdate(finishedTicket, text);
      }
    }

    await postUpdate(
      finishedTicket,
      `Is the issue resolved? Reply *yes* or *no* in this thread (ticket ${state.ticketId}).`,
    );
  }
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

  await waitForAgentJobs(state.ticketId, 20_000);
  const fresh = await getTicket(state.ticketId);
  const allJobs = await listAgentJobs(ticket.workspaceId);
  const jobsForTicket = allJobs.filter((j) => j.ticketId === state.ticketId);
  const evidence = buildReplyEvidence(fresh?.plan ?? [], jobsForTicket);

  const artifact = buildHandoffArtifact(state, fresh ?? ticket, evidence);

  await updateTicket(state.ticketId, {
    status: "escalated",
    troubleshootingSummary: artifact,
    attempts: state.attempt,
    tier: state.tier,
  });
  appendTrace(
    state.ticketId,
    "humanHandoff",
    "completed",
    `tier ${state.tier} exhausted — handed to a human with ${state.findings.length} finding(s)`,
  );

  await updateUserMemory(state, ticket, artifact);
  await recordIncident(state, fresh ?? ticket, false);

  const firstName = preferredName(state.memory, firstNameOf(ticket.reporter));
  await say(
    ticket,
    state.memory,
    state.tier,
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
    `Ticket ${ticket.id} — escalated to a human after ${state.attempt} attempt(s), reaching tier ${state.tier}.`,
    "",
    `Problem as reported: ${ticket.subject}`,
    `Employee: ${ticket.reporter} <${ticket.reporterEmail}>${state.profile ? ` · ${state.profile}` : ""}`,
    `Device: ${state.deviceContext ?? "no registered device"}`,
  ];

  if (state.draft?.hypothesis) {
    lines.push(`Leading hypothesis: ${state.draft.hypothesis}`);
  }

  // The shape of this line is the point. A trail that falls says the evidence
  // argued against the plan; one that never moves says the rounds bought no
  // information, which is a different conversation to have with the system.
  if (state.confidenceTrail.length > 0) {
    const trail = state.confidenceTrail.map((c) => `${Math.round(c * 100)}%`).join(" → ");
    const first = state.confidenceTrail[0];
    const last = state.confidenceTrail[state.confidenceTrail.length - 1];
    const drift =
      state.confidenceTrail.length < 2
        ? ""
        : last < first - 0.05
          ? " (fell — the evidence argued against the original diagnosis)"
          : last > first + 0.05
            ? " (rose — evidence supported it, but not enough to close)"
            : " (flat — the rounds bought no new information)";
    lines.push(`Confidence over time: ${trail}${drift}`);
  }

  // The case in the order a colleague would tell it: each tier's read, what it
  // eliminated, and why it let go. Read this before the raw findings — it is the
  // part that tells you where NOT to start.
  if (state.decisions.length > 0) {
    lines.push("", "How the case developed:");
    for (const d of state.decisions) {
      lines.push(`  Tier ${d.tier} (${tierSpec(d.tier).label})`);
      lines.push(`    Thought: ${d.hypothesis || "(no hypothesis stated)"}`);
      for (const r of d.rejected) {
        lines.push(`    Ruled out: ${r.hypothesis} — ${r.ruledOutBy}`);
      }
      if (d.capabilitiesConsidered.length > 0) {
        lines.push(`    Weighed: ${d.capabilitiesConsidered.join(", ")}`);
      }
      lines.push(`    Outcome: ${d.outcome}`);
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

/**
 * Record this ticket in the cross-user track record for its problem class.
 *
 * `resolvedBy` is the capability that actually moved the machine — the last
 * step that both succeeded and was not a read. That is a deliberately strict
 * reading: a diagnostic that merely ran in a ticket which later resolved did
 * not fix anything, and crediting it would inflate every probe in the set to a
 * near-perfect score and send the next planner straight at it.
 *
 * Best-effort, like every other memory write: it must never fail a ticket.
 */
async function recordIncident(state: TState, ticket: Ticket, resolved: boolean): Promise<void> {
  const steps = ticket.plan.filter((s) => s.kind !== "reply");
  const capabilitiesUsed = steps.map((s) => s.capability).filter((c): c is string => Boolean(c));

  const fixer = [...steps]
    .reverse()
    .find((s) => s.status === "succeeded" && s.capability?.startsWith("fix."));

  const failed = steps.find((s) => s.failure);

  await rememberIncident({
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    category: state.incidentCategory,
    symptom: ticket.subject,
    tier: state.tier,
    capabilitiesUsed,
    resolvedBy: resolved ? fixer?.capability : undefined,
    resolved,
    failureKind: resolved ? undefined : failed?.failure?.kind,
    at: Date.now(),
  }).catch(() => {});

  appendTrace(
    state.ticketId,
    "recordIncident",
    "completed",
    `filed under "${state.incidentCategory}" · ${resolved ? "resolved" : "not resolved"}` +
      (resolved && fixer?.capability ? ` by ${fixer.capability}` : ""),
  );
}

// Learn from the ticket we just handled: durable facts about the person, plus
// one line of history. Best-effort — a memory write must never fail a ticket.
async function updateUserMemory(state: TState, ticket: Ticket, outcome: string): Promise<void> {
  const t0 = Date.now();
  const extracted = await extractUserMemory({
    ticketId: ticket.id,
    subject: ticket.subject,
    body: ticket.body,
    outcome,
    knownFacts: state.memory.facts,
  }).catch(() => null);
  if (!extracted) return;

  for (const fact of extracted.facts) {
    await rememberUserFact(ticket.workspaceId, ticket.reporterEmail, fact.key, fact.value);
  }
  if (extracted.episode) {
    await rememberUserEpisode(ticket.workspaceId, ticket.reporterEmail, ticket.id, extracted.episode);
  }
  appendTrace(
    state.ticketId,
    "updateMemory",
    "completed",
    `remembered ${extracted.facts.length} fact(s)` + (extracted.episode ? " + 1 episode" : ""),
    Date.now() - t0,
  );
}

declare global {
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH_CHECKPOINTER__: MemorySaver | undefined;
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH__: ReturnType<typeof buildGraph> | undefined;
}

function buildGraph() {
  return new StateGraph(TicketGraphState)
    .addNode("gatherProfile", gatherProfile)
    .addNode("gatherMemory", gatherMemory)
    .addNode("gatherDeviceContext", gatherDeviceContext)
    .addNode("gatherIncidentHistory", gatherIncidentHistory)
    .addNode("draftPlan", draftPlanNode)
    .addNode("classifyRisk", classifyRisk)
    .addNode("tierGate", tierGate, { ends: ["persistPlan", "escalateTier"] })
    .addNode("escalateTier", escalateTier, {
      ends: ["runNextStep", "escalateTier", "humanHandoff", END],
    })
    .addNode("humanHandoff", humanHandoff, { ends: [END] })
    .addNode("persistPlan", persistPlan)
    .addNode("runNextStep", runNextStep, {
      ends: ["runNextStep", "markAwaitingApproval", "verifyOutcome", "humanHandoff", END],
    })
    .addNode("verifyOutcome", verifyOutcome, {
      ends: ["replan", "escalateTier", "finalizeExecution", "humanHandoff", END],
    })
    .addNode("replan", replan, { ends: ["runNextStep", END] })
    .addNode("markAwaitingApproval", markAwaitingApproval)
    .addNode("awaitApproval", awaitApproval, { ends: ["runNextStep"] })
    .addNode("finalizeExecution", finalizeExecution)
    .addEdge(START, "gatherProfile")
    .addEdge(START, "gatherMemory")
    .addEdge(START, "gatherDeviceContext")
    .addEdge(START, "gatherIncidentHistory")
    // draftPlan needs both memories: what we know about this person, and what
    // has worked on this class of problem. Barrier join, so it fires once with
    // both in hand rather than twice with half.
    .addEdge(["gatherMemory", "gatherIncidentHistory"], "draftPlan")
    // Barrier join: classifyRisk must run exactly once, after ALL branches.
    // Separate addEdge calls would fire it per-predecessor.
    .addEdge(["gatherProfile", "gatherDeviceContext", "draftPlan"], "classifyRisk")
    .addEdge("classifyRisk", "tierGate")
    .addEdge("persistPlan", "runNextStep")
    .addEdge("markAwaitingApproval", "awaitApproval")
    .addEdge("finalizeExecution", END)
    .compile({ checkpointer });
}

const checkpointer: MemorySaver = globalThis.__TICKET_GRAPH_CHECKPOINTER__ ?? new MemorySaver();
if (!globalThis.__TICKET_GRAPH_CHECKPOINTER__) globalThis.__TICKET_GRAPH_CHECKPOINTER__ = checkpointer;

export const ticketGraph = globalThis.__TICKET_GRAPH__ ?? buildGraph();
if (!globalThis.__TICKET_GRAPH__) globalThis.__TICKET_GRAPH__ = ticketGraph;

function tracingConfig(ticketId: string) {
  return {
    configurable: { thread_id: ticketId },
    runName: `ticket:${ticketId}`,
    tags: [`ticket:${ticketId}`],
    metadata: { ticketId },
  };
}

export async function runTicketGraphFromStart(ticketId: string): Promise<void> {
  await ticketGraph.invoke({ ticketId }, tracingConfig(ticketId));
}

export async function resumeTicketGraph(
  ticketId: string,
  decision: { approved: true; approver: Approver },
): Promise<void> {
  await ticketGraph.invoke(new Command({ resume: decision }), tracingConfig(ticketId));
}
