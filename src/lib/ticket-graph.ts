import { StateGraph, Annotation, START, END, MemorySaver, interrupt, Command } from "@langchain/langgraph";
import { getTicket, updateTicket, updateStep, getWorkspace, listAgentJobs, listDevices } from "@/lib/data";
import { Citation, PlanStep, Ticket } from "@/lib/types";
import { getUserContext, queryMemories, MemoryHit } from "@/lib/integrations/hyperspell";
import { niaDraft, NiaDraftResult } from "@/lib/integrations/nia";
import { classifyPlan } from "@/lib/policy";
import { insforgeInvoke } from "@/lib/integrations/insforge";
import { asideExecute } from "@/lib/integrations/aside";
import { tensorlakeRun } from "@/lib/integrations/tensorlake";
import { synthesizeSlackReply, verifyAndReplan } from "@/lib/integrations/ai-gateway";
import { postSlackMessage } from "@/lib/slack";
import { enqueueAgentJob, isAgentJobCapability } from "@/lib/agent-jobs";
import { recordCleanExecution } from "@/lib/governance";
import { appendTrace } from "@/lib/trace";
import { readHeartbeat, HEARTBEAT_CONNECTED_WINDOW_MS } from "@/lib/agent-heartbeat";
import {
  buildSlackReplyEvidence,
  humanStepLabel,
  postSlackUpdate,
  slackContextFromTicket,
  substituteParams,
  waitForAgentJobs,
} from "@/lib/ticket-helpers";

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
  userContext: Annotation<Awaited<ReturnType<typeof getUserContext>>>({ reducer: overwrite, default: () => null }),
  memories: Annotation<MemoryHit[]>({ reducer: overwrite, default: () => [] }),
  deviceContext: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  draft: Annotation<NiaDraftResult | null>({ reducer: overwrite, default: () => null }),
  citations: Annotation<Citation[]>({ reducer: overwrite, default: () => [] }),
  classifiedPlan: Annotation<PlanStep[]>({ reducer: overwrite, default: () => [] }),
  attempt: Annotation<number>({ reducer: overwrite, default: () => 1 }),
  findings: Annotation<string[]>({ reducer: (cur, upd) => cur.concat(upd), default: () => [] }),
  pendingStepId: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  justApprovedCapability: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  approver: Annotation<Approver | null>({ reducer: overwrite, default: () => null }),
});

type TState = typeof TicketGraphState.State;

// ---- context gathering: three unconditional parallel branches from START.
// Hyperspell is always invoked (both nodes), never gated.

async function gatherUserContext(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const userContext = await getUserContext(ticket.reporterEmail).catch(() => null);
  appendTrace(
    state.ticketId,
    "gatherUserContext",
    "completed",
    userContext ? `Hyperspell profile: ${userContext.name} · ${userContext.team} team` : "no profile found",
    Date.now() - t0,
  );
  return { userContext };
}

async function gatherMemories(state: TState) {
  const t0 = Date.now();
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const memories = await queryMemories(`${ticket.subject}\n${ticket.body}`).catch(() => []);
  appendTrace(
    state.ticketId,
    "gatherMemories",
    "completed",
    `${memories.length} Hyperspell memory hit(s)`,
    Date.now() - t0,
  );
  return { memories };
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

async function draftWithNia(state: TState) {
  const t0 = Date.now();
  appendTrace(state.ticketId, "draftPlan", "started", "LLM drafting from runbooks + memories");
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  try {
    const draft = await withTimeout(
      niaDraft({
        subject: ticket.subject,
        body: ticket.body,
        reporter: ticket.reporter,
        reporterEmail: ticket.reporterEmail,
        customerOrg: ticket.customerOrg,
        workspaceId: ticket.workspaceId,
        memories: state.memories,
      }),
      DRAFT_TIMEOUT_MS,
      "draftPlan",
    );
    appendTrace(
      state.ticketId,
      "draftPlan",
      "completed",
      `${draft.plan.length} step(s) via ${draft.source} · confidence ${Math.round(draft.confidence * 100)}%`,
      Date.now() - t0,
    );
    return { draft };
  } catch (err) {
    console.warn(`[draftWithNia] ${state.ticketId} failed (${(err as Error).message}); using minimal fallback`);
    appendTrace(
      state.ticketId,
      "draftPlan",
      "failed",
      `${(err as Error).message} — using minimal fallback plan`,
      Date.now() - t0,
    );
    const firstName = ticket.reporter.split(/\s+/)[0];
    const fallback: NiaDraftResult = {
      citations: [],
      confidence: 0.4,
      reasoning: "draft failed — minimal fallback",
      response: `Hi ${firstName} — I'm taking a look at this and will follow up shortly. Could you share any error message or screenshot if you have one?`,
      plan: [
        { id: "step-0", kind: "slack_reply", description: "Acknowledge and ask for more detail", status: "pending" },
      ],
      source: "mock",
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
  const userCtx = state.userContext;

  const citations: Citation[] = [...draft.citations];
  if (userCtx) {
    citations.push({
      source: "hyperspell",
      title: `${userCtx.name} — ${userCtx.team} team`,
      snippet: `Recent apps: ${userCtx.recentApps.join(", ")}`,
      ref: `user:${userCtx.email}`,
    });
  }
  for (const m of state.memories) {
    citations.push({
      source: "hyperspell",
      title: m.title,
      snippet: m.summary.slice(0, 220),
      ref: `memory:${m.resourceId}`,
    });
  }

  const rawPlan: PlanStep[] = draft.plan.map((step) => ({
    ...step,
    params: substituteParams(step.params, ticket.reporterEmail),
  }));
  const plan = await classifyPlan(rawPlan, ticket);

  const gated = plan.filter((s) => s.approvalMode === "human").length;
  const promoted = plan.filter((s) => s.governancePromoted).length;
  const judged = plan.filter((s) => s.riskSource === "judge").length;
  appendTrace(
    state.ticketId,
    "classifyRisk",
    "completed",
    `${plan.length} step(s): ${gated} human-gated, ${plan.length - gated} auto` +
      (promoted ? `, ${promoted} trust-promoted` : "") +
      (judged ? ` · ${judged} via LLM judge` : " · allowlist only"),
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
  });
  appendTrace(state.ticketId, "persistPlan", "completed", "plan saved · entering execute loop");

  const updatedForSlack = await getTicket(state.ticketId);
  if (updatedForSlack) {
    const firstName = ticket.reporter.split(/\s+/)[0];
    const planLines = state.classifiedPlan.map((s, i) => `   ${i + 1}. ${humanStepLabel(s)}`).join("\n");
    await postSlackUpdate(
      updatedForSlack,
      `🔎 Hi ${firstName} — here's my plan:\n${planLines}\n\n_Ticket ${state.ticketId} · saved for future reference_`,
    );
  }
  return {};
}

// Shared step dispatcher — identical logic to the old executePlan's per-step try/catch.
async function executeStepAndPersist(ticket: Ticket, step: PlanStep): Promise<{ ok: boolean }> {
  await updateStep(ticket.id, step.id, { status: "running", startedAt: Date.now() });
  if (step.kind !== "slack_reply") {
    await postSlackUpdate(ticket, `🔧 ${humanStepLabel(step)}…`);
  }

  let ok = true;
  let log: string[] = [];

  try {
    if (step.kind === "insforge") {
      const r = await insforgeInvoke(step, ticket.reporterEmail);
      ok = r.ok;
      log = r.log;
    } else if (step.kind === "aside") {
      const r = await asideExecute(step, ticket.reporterEmail);
      ok = r.ok;
      log = r.log;
    } else if (step.kind === "tensorlake") {
      if (isAgentJobCapability(step.capability)) {
        const job = await enqueueAgentJob(ticket, step);
        log.push(`[Agent Queue] Job ${job.id} queued for local sandbox agent`);
        log.push(`[Agent Queue] ${job.allowlistedCommand}`);
      }
      const r = await tensorlakeRun(step, ticket.reporterEmail);
      ok = r.ok;
      log = [...log, ...r.log];
    } else if (step.kind === "slack_reply") {
      log = [`[Slack] Waiting for any pending local-agent jobs before composing reply`];
      await waitForAgentJobs(ticket.id, 20_000);

      const fresh = await getTicket(ticket.id);
      const stepsBeforeReply = (fresh?.plan ?? []).filter((s) => s.id !== step.id);
      const allJobs = await listAgentJobs(ticket.workspaceId);
      const jobsForTicket = allJobs.filter((j) => j.ticketId === ticket.id);

      const evidence = buildSlackReplyEvidence(stepsBeforeReply, jobsForTicket);
      log.push(`[Slack] Synthesizing reply from ${evidence.length} executed step(s)`);

      const firstName = ticket.reporter.split(/\s+/)[0];
      const synthesized = await synthesizeSlackReply({
        reporterFirstName: firstName,
        subject: ticket.subject,
        body: ticket.body,
        evidence,
      }).catch(() => null);

      const replyText =
        synthesized ?? ticket.draftResponse ?? `Hi ${firstName} — your IT ticket ${ticket.id} has been updated.`;
      if (synthesized) log.push(`[Slack] Reply synthesized from real step results`);
      else log.push(`[Slack] Reply synthesizer unavailable — falling back to initial draft`);

      const ws = await getWorkspace(ticket.workspaceId);
      const slackContext = slackContextFromTicket(ticket);
      if (ws?.slackAccessToken && slackContext.channel) {
        const msg = await postSlackMessage(
          ws.slackAccessToken,
          slackContext.channel,
          replyText,
          slackContext.threadTs,
        );
        if (msg.ok) log.push(`[Slack] Message delivered to ${slackContext.channel}`);
        else log.push(`[Slack] API delivery failed: ${msg.error ?? "unknown_error"}`);
      } else {
        log.push(`[Slack] Message delivered`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    ok = false;
    log = [`[Error] ${(err as Error).message}`];
  }

  await updateStep(ticket.id, step.id, { status: ok ? "succeeded" : "failed", log, finishedAt: Date.now() });
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
    `${humanStepLabel(step)}${step.governancePromoted ? " · ran on precedent (trusted)" : ""}`,
    Date.now() - t0,
  );

  if (ok && state.approver && state.justApprovedCapability && state.justApprovedCapability === step.capability) {
    recordCleanExecution(ticket.workspaceId, step.capability!, state.approver);
  }

  if (!ok) {
    await updateTicket(state.ticketId, { status: "escalated" });
    appendTrace(state.ticketId, "escalate", "completed", "step failed — fail-fast, no retry, escalated to human");
    return new Command({ goto: END });
  }

  return new Command({ goto: "runNextStep", update: { justApprovedCapability: null } });
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
    await postSlackUpdate(ticket, `⏸ Waiting on IT approval for: ${humanStepLabel(step)}`);
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
      justApprovedCapability: step?.capability ?? null,
      pendingStepId: null,
      approver: decision.approver,
    },
  });
}

const MAX_ATTEMPTS = 3;

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
  const evidence = buildSlackReplyEvidence(fresh?.plan ?? [], jobsForTicket);

  const verdict = await verifyAndReplan({
    subject: ticket.subject,
    body: ticket.body,
    attempt: state.attempt,
    maxAttempts: MAX_ATTEMPTS,
    evidence,
    priorFindings: state.findings,
  }).catch(() => null);

  if (!verdict) {
    appendTrace(state.ticketId, "verifyOutcome", "completed", "verifier unavailable — accepting current result", Date.now() - t0);
    return new Command({ goto: "finalizeExecution" });
  }

  const finding = `${verdict.hypothesis || verdict.reasoning}`;
  appendTrace(
    state.ticketId,
    "verifyOutcome",
    "completed",
    `attempt ${state.attempt}/${MAX_ATTEMPTS} — ${verdict.resolved ? "believes RESOLVED" : "NOT resolved"} (${Math.round(
      verdict.confidence * 100,
    )}%): ${verdict.reasoning}`,
    Date.now() - t0,
  );

  if (verdict.resolved || verdict.nextSteps.length === 0 || state.attempt >= MAX_ATTEMPTS) {
    if (!verdict.resolved) {
      appendTrace(
        state.ticketId,
        "exhausted",
        "completed",
        `no fix after ${state.attempt} attempt(s) — handing to a human with findings`,
      );
    }
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
  const classified = await classifyPlan(withParams, ticket);

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

  const firstName = ticket.reporter.split(/\s+/)[0];
  await postSlackUpdate(
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

  if (finishedTicket.channel === "slack") {
    const firstName = finishedTicket.reporter.split(/\s+/)[0];
    const hadSlackReplyStep = finishedTicket.plan.some((s) => s.kind === "slack_reply");

    if (!hadSlackReplyStep) {
      await waitForAgentJobs(state.ticketId, 20_000);
      const refreshed = await getTicket(state.ticketId);
      const stepsForSynth = refreshed?.plan ?? [];
      const allJobs = await listAgentJobs(finishedTicket.workspaceId);
      const jobsForTicket = allJobs.filter((j) => j.ticketId === state.ticketId);
      const evidence = buildSlackReplyEvidence(stepsForSynth, jobsForTicket);
      const synthesized = await synthesizeSlackReply({
        reporterFirstName: firstName,
        subject: finishedTicket.subject,
        body: finishedTicket.body,
        evidence,
      }).catch(() => null);
      if (synthesized) {
        await postSlackUpdate(finishedTicket, synthesized);
      }
    }

    await postSlackUpdate(
      finishedTicket,
      `Is the issue resolved? Reply *yes* or *no* in this thread (ticket ${state.ticketId}).`,
    );
  }
  return {};
}

declare global {
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH_CHECKPOINTER__: MemorySaver | undefined;
  // eslint-disable-next-line no-var
  var __TICKET_GRAPH__: ReturnType<typeof buildGraph> | undefined;
}

function buildGraph() {
  return new StateGraph(TicketGraphState)
    .addNode("gatherUserContext", gatherUserContext)
    .addNode("gatherMemories", gatherMemories)
    .addNode("gatherDeviceContext", gatherDeviceContext)
    .addNode("draftWithNia", draftWithNia)
    .addNode("classifyRisk", classifyRisk)
    .addNode("persistPlan", persistPlan)
    .addNode("runNextStep", runNextStep, { ends: ["runNextStep", "markAwaitingApproval", "verifyOutcome", END] })
    .addNode("verifyOutcome", verifyOutcome, { ends: ["replan", "finalizeExecution", END] })
    .addNode("replan", replan, { ends: ["runNextStep", END] })
    .addNode("markAwaitingApproval", markAwaitingApproval)
    .addNode("awaitApproval", awaitApproval, { ends: ["runNextStep"] })
    .addNode("finalizeExecution", finalizeExecution)
    .addEdge(START, "gatherUserContext")
    .addEdge(START, "gatherMemories")
    .addEdge(START, "gatherDeviceContext")
    .addEdge("gatherMemories", "draftWithNia")
    // Barrier join: classifyRisk must run exactly once, after ALL three
    // branches. Separate addEdge calls would fire it per-predecessor.
    .addEdge(["gatherUserContext", "gatherDeviceContext", "draftWithNia"], "classifyRisk")
    .addEdge("classifyRisk", "persistPlan")
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
