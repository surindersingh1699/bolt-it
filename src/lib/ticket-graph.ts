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
} from "@/lib/data";
import { Citation, PlanStep, Ticket } from "@/lib/types";
import { UserMemory, EMPTY_MEMORY, preferredName } from "@/lib/memory";
import { DraftResult } from "@/lib/integrations/draft";
import { REVIEWER_MODEL, reviewPlan } from "@/lib/reviewer";
import { directoryInvoke } from "@/lib/integrations/directory";
import { knowledgeInvoke } from "@/lib/integrations/knowledge";
import { aiGatewayDraft, synthesizeReply, verifyAndReplan, extractUserMemory } from "@/lib/integrations/ai-gateway";
import { enqueueAgentJob, isAgentJobCapability } from "@/lib/agent-jobs";
import { formatProofLines, isRealSuccess } from "@/lib/evidence";
import { appendTrace } from "@/lib/trace";
import { readHeartbeat, HEARTBEAT_CONNECTED_WINDOW_MS } from "@/lib/agent-heartbeat";
import { Tier, nextTier, tierSpec } from "@/lib/tiers";
import {
  buildReplyEvidence,
  firstNameOf,
  humanStepLabel,
  postUpdate,
  substituteParams,
  waitForAgentJobs,
  waitForJob,
} from "@/lib/ticket-helpers";

// How long a step will wait for the user's machine to report back before
// treating the work as not done.
const AGENT_JOB_TIMEOUT_MS = 45_000;

export interface Approver {
  name: string;
  email: string;
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
  draft: Annotation<DraftResult | null>({ reducer: overwrite, default: () => null }),
  citations: Annotation<Citation[]>({ reducer: overwrite, default: () => [] }),
  classifiedPlan: Annotation<PlanStep[]>({ reducer: overwrite, default: () => [] }),
  attempt: Annotation<number>({ reducer: overwrite, default: () => 1 }),
  // Escalation depth. Every ticket starts at first-line and only ever moves down.
  tier: Annotation<Tier>({ reducer: overwrite, default: () => 1 }),
  findings: Annotation<string[]>({ reducer: (cur, upd) => cur.concat(upd), default: () => [] }),
  pendingStepId: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  approver: Annotation<Approver | null>({ reducer: overwrite, default: () => null }),
});

type TState = typeof TicketGraphState.State;

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
      subject: ticket.subject,
      body: ticket.body,
      reporter: ticket.reporter,
      reporterEmail: ticket.reporterEmail,
      customerOrg: ticket.customerOrg,
      workspaceId: ticket.workspaceId,
      memory: state.memory,
      tier,
      priorFindings: state.findings,
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
    return { draft };
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
    const firstName = firstNameOf(ticket.reporter);
    const planLines = state.classifiedPlan.map((s, i) => `   ${i + 1}. ${humanStepLabel(s)}`).join("\n");
    await postUpdate(
      updatedForSlack,
      `🔎 Hi ${firstName} — here's my plan:\n${planLines}\n\n_Ticket ${state.ticketId} · saved for future reference_`,
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
    return new Command({
      goto: "escalateTier",
      update: { findings: [`tier ${state.tier} declined: ${draft.escalateReason || draft.reasoning}`] },
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
      },
    });
  }

  if (state.classifiedPlan.length === 0) {
    return new Command({
      goto: "escalateTier",
      update: { findings: [`tier ${state.tier} produced no runnable steps`] },
    });
  }

  return new Command({ goto: "persistPlan" });
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
    return new Command({ goto: "finalizeExecution" });
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
    return new Command({ goto: "finalizeExecution", update: { tier: next } });
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

  const firstName = firstNameOf(ticket.reporter);
  await postUpdate(
    ticket,
    `⏫ Hi ${firstName} — this needs deeper diagnostics than the first pass could give it, so I've brought in more capable tooling. ` +
      `Next: ${classified.map((s) => humanStepLabel(s)).join(", ")}.`,
  );

  return new Command({
    goto: "runNextStep",
    update: { tier: next, attempt: 1, draft, classifiedPlan: classified },
  });
}

// Shared step dispatcher: one branch per kind, no vendor branding.
async function executeStepAndPersist(ticket: Ticket, step: PlanStep): Promise<{ ok: boolean }> {
  await updateStep(ticket.id, step.id, { status: "running", startedAt: Date.now() });
  if (step.kind !== "reply") {
    await postUpdate(ticket, `\u{1F527} ${humanStepLabel(step)}\u2026`);
  }

  let ok = true;
  let log: string[] = [];

  try {
    if (step.kind === "backend") {
      const r = await directoryInvoke(step, ticket.reporterEmail);
      ok = r.ok;
      log = r.log;
    } else if (step.kind === "knowledge") {
      // External lookup. Everything it returns is fenced as evidence — the tier
      // prompts forbid acting on instructions found inside a fetched page.
      const r = await knowledgeInvoke(step);
      ok = r.ok;
      log = r.log;
    } else if (step.kind === "device") {
      // Work on the user's machine is decided by the machine. No parallel
      // narration from the cloud — the before/after evidence is the verdict.
      const job = await enqueueAgentJob(ticket, step);
      log.push(`[Agent Queue] Job ${job.id} dispatched to the device agent`);
      log.push(`[Agent Queue] ${job.allowlistedCommand}`);

      const finished = await waitForJob(job.id, AGENT_JOB_TIMEOUT_MS);
      if (!finished) {
        ok = false;
        log.push(
          `[Local Agent] No result within ${AGENT_JOB_TIMEOUT_MS / 1000}s — the device agent is offline or busy. ` +
            `Nothing was done on the user's machine.`,
        );
      } else {
        log = [...log, ...formatProofLines(finished)];
        ok = isRealSuccess(finished.status);
        if (finished.status === "no_effect") {
          log.push(`[Local Agent] Step marked failed: the fix ran but the device did not change.`);
        }
      }
    } else if (step.kind === "reply") {
      log = [`[Reply] Waiting for any pending device jobs before composing reply`];
      await waitForAgentJobs(ticket.id, 20_000);

      const fresh = await getTicket(ticket.id);
      const stepsBeforeReply = (fresh?.plan ?? []).filter((s) => s.id !== step.id);
      const allJobs = await listAgentJobs(ticket.workspaceId);
      const jobsForTicket = allJobs.filter((j) => j.ticketId === ticket.id);

      const evidence = buildReplyEvidence(stepsBeforeReply, jobsForTicket);
      log.push(`[Reply] Synthesizing reply from ${evidence.length} executed step(s)`);

      const firstName = firstNameOf(ticket.reporter);
      const synthesized = await synthesizeReply({
        reporterFirstName: firstName,
        subject: ticket.subject,
        body: ticket.body,
        evidence,
      }).catch(() => null);

      const replyText =
        synthesized ?? ticket.draftResponse ?? `Hi ${firstName} — your IT ticket ${ticket.id} has been updated.`;
      log.push(
        synthesized
          ? `[Reply] Composed from real step results`
          : `[Reply] Synthesizer unavailable — falling back to initial draft`,
      );
      await postUpdate(ticket, replyText);
    }
  } catch (err) {
    ok = false;
    log = [`[Error] ${(err as Error).message}`];
  }

  await updateStep(ticket.id, step.id, {
    status: ok ? "succeeded" : "failed",
    log,
    finishedAt: Date.now(),
  });
  return { ok };
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
  const { ok } = await executeStepAndPersist(ticket, step);
  appendTrace(
    state.ticketId,
    `execute:${step.capability ?? step.kind}`,
    ok ? "completed" : "failed",
    `${humanStepLabel(step)} · reviewer cleared this step to run unattended`,
    Date.now() - t0,
  );

  if (!ok) {
    await updateTicket(state.ticketId, { status: "escalated" });
    appendTrace(state.ticketId, "escalate", "completed", "step failed — fail-fast, no retry, escalated to human");
    return new Command({ goto: END });
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
    return new Command({ goto: "finalizeExecution", update: { findings: [finding] } });
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
      return new Command({ goto: "escalateTier", update: { findings: [finding] } });
    }
    appendTrace(
      state.ticketId,
      "exhausted",
      "completed",
      `no fix after tier ${state.tier} — handing to a human with findings`,
    );
    return new Command({ goto: "finalizeExecution", update: { findings: [finding] } });
  }

  return new Command({ goto: "replan", update: { findings: [finding], classifiedPlan: verdict.nextSteps } });
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

  const firstName = firstNameOf(ticket.reporter);
  await postUpdate(
    ticket,
    `🔁 Hi ${firstName} — first approach didn't resolve it. Trying attempt ${nextAttempt}: ${classified
      .map((s) => humanStepLabel(s))
      .join(", ")}`,
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
      const synthesized = await synthesizeReply({
        reporterFirstName: firstName,
        subject: finishedTicket.subject,
        body: finishedTicket.body,
        evidence,
      }).catch(() => null);
      if (synthesized) {
        await postUpdate(finishedTicket, synthesized);
      }
    }

    await postUpdate(
      finishedTicket,
      `Is the issue resolved? Reply *yes* or *no* in this thread (ticket ${state.ticketId}).`,
    );
  }
  return {};
}

// Learn from the ticket we just handled: durable facts about the person, plus
// one line of history. Best-effort — a memory write must never fail a ticket.
async function updateUserMemory(state: TState, ticket: Ticket, outcome: string): Promise<void> {
  const t0 = Date.now();
  const extracted = await extractUserMemory({
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
    .addNode("draftPlan", draftPlanNode)
    .addNode("classifyRisk", classifyRisk)
    .addNode("tierGate", tierGate, { ends: ["persistPlan", "escalateTier"] })
    .addNode("escalateTier", escalateTier, {
      ends: ["runNextStep", "escalateTier", "finalizeExecution", END],
    })
    .addNode("persistPlan", persistPlan)
    .addNode("runNextStep", runNextStep, { ends: ["runNextStep", "markAwaitingApproval", "verifyOutcome", END] })
    .addNode("verifyOutcome", verifyOutcome, { ends: ["replan", "escalateTier", "finalizeExecution", END] })
    .addNode("replan", replan, { ends: ["runNextStep", END] })
    .addNode("markAwaitingApproval", markAwaitingApproval)
    .addNode("awaitApproval", awaitApproval, { ends: ["runNextStep"] })
    .addNode("finalizeExecution", finalizeExecution)
    .addEdge(START, "gatherProfile")
    .addEdge(START, "gatherMemory")
    .addEdge(START, "gatherDeviceContext")
    .addEdge("gatherMemory", "draftPlan")
    // Barrier join: classifyRisk must run exactly once, after ALL three
    // branches. Separate addEdge calls would fire it per-predecessor.
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
