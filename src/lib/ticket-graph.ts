import { StateGraph, Annotation, START, END, MemorySaver, interrupt, Command } from "@langchain/langgraph";
import { getTicket, updateTicket, updateStep, getWorkspace, listAgentJobs } from "@/lib/data";
import { Citation, PlanStep, Ticket } from "@/lib/types";
import { getUserContext, queryMemories, MemoryHit } from "@/lib/integrations/hyperspell";
import { niaDraft, NiaDraftResult } from "@/lib/integrations/nia";
import { classifyPlan } from "@/lib/policy";
import { insforgeInvoke } from "@/lib/integrations/insforge";
import { asideExecute } from "@/lib/integrations/aside";
import { tensorlakeRun } from "@/lib/integrations/tensorlake";
import { synthesizeSlackReply } from "@/lib/integrations/ai-gateway";
import { postSlackMessage } from "@/lib/slack";
import { enqueueAgentJob, isAgentJobCapability } from "@/lib/agent-jobs";
import { recordCleanExecution } from "@/lib/governance";
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
  draft: Annotation<NiaDraftResult | null>({ reducer: overwrite, default: () => null }),
  pendingStepId: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  justApprovedCapability: Annotation<string | null>({ reducer: overwrite, default: () => null }),
  approver: Annotation<Approver | null>({ reducer: overwrite, default: () => null }),
});

type TState = typeof TicketGraphState.State;

// ---- context gathering (unconditional, mirrors today's Promise.all — Hyperspell is
// always invoked, never gated) ----

async function gatherUserContext(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const userContext = await getUserContext(ticket.reporterEmail).catch(() => null);
  return { userContext };
}

async function gatherMemories(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return {};
  const memories = await queryMemories(`${ticket.subject}\n${ticket.body}`).catch(() => []);
  return { memories };
}

async function draftWithNia(state: TState) {
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
    return { draft };
  } catch (err) {
    console.warn(`[draftWithNia] ${state.ticketId} failed (${(err as Error).message}); using minimal fallback`);
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

// Join: waits on both gatherUserContext and draftWithNia. Classifies risk/precedent
// per step, persists the plan, then goes straight into execution — no hardcoded
// stop here. This is the core behavioral change vs. today: the plan no longer
// waits for a single whole-plan approval before anything runs.
async function classifyAndPersistPlan(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket || !state.draft) return {};
  const draft = state.draft;
  const userCtx = state.userContext;
  const memories = state.memories;

  const citations: Citation[] = [...draft.citations];
  if (userCtx) {
    citations.push({
      source: "hyperspell",
      title: `${userCtx.name} — ${userCtx.team} team`,
      snippet: `Recent apps: ${userCtx.recentApps.join(", ")}`,
      ref: `user:${userCtx.email}`,
    });
  }
  for (const m of memories) {
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

  await updateTicket(state.ticketId, {
    status: "executing",
    citations,
    confidence: draft.confidence,
    draftResponse: draft.response,
    plan,
  });

  const updatedForSlack = await getTicket(state.ticketId);
  if (updatedForSlack) {
    const firstName = ticket.reporter.split(/\s+/)[0];
    const planLines = plan.map((s, i) => `   ${i + 1}. ${humanStepLabel(s)}`).join("\n");
    await postSlackUpdate(
      updatedForSlack,
      `🔎 Hi ${firstName} — here's my plan:\n${planLines}\n\n_Ticket ${state.ticketId} · saved for future reference_`,
    );
  }
  return {};
}

// Shared step dispatcher — identical logic to the old executePlan's per-step try/catch,
// extracted so runNextStep can call it for every "auto" step.
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

// Self-looping execute node. Auto steps run immediately, no click. Only a step whose
// approvalMode is still "human" (i.e. genuinely high-risk and not yet precedent-promoted)
// routes to the approval interrupt — everything else just runs.
async function runNextStep(state: TState) {
  const ticket = await getTicket(state.ticketId);
  if (!ticket) return new Command({ goto: END });

  const step = ticket.plan.find((s) => s.status === "pending");
  if (!step) return new Command({ goto: "finalizeExecution" });

  if (step.approvalMode === "human") {
    return new Command({ goto: "markAwaitingApproval", update: { pendingStepId: step.id } });
  }

  const { ok } = await executeStepAndPersist(ticket, step);

  if (ok && state.approver && state.justApprovedCapability && state.justApprovedCapability === step.capability) {
    recordCleanExecution(ticket.workspaceId, step.capability!, state.approver);
  }

  if (!ok) {
    await updateTicket(state.ticketId, { status: "escalated" });
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

async function finalizeExecution(state: TState) {
  const finishedTicket = await getTicket(state.ticketId);
  if (!finishedTicket) return {};

  await updateTicket(state.ticketId, { status: "awaiting_confirmation" });

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
    .addNode("draftWithNia", draftWithNia)
    .addNode("classifyAndPersistPlan", classifyAndPersistPlan)
    .addNode("runNextStep", runNextStep, { ends: ["runNextStep", "markAwaitingApproval", "finalizeExecution", END] })
    .addNode("markAwaitingApproval", markAwaitingApproval)
    .addNode("awaitApproval", awaitApproval, { ends: ["runNextStep"] })
    .addNode("finalizeExecution", finalizeExecution)
    .addEdge(START, "gatherUserContext")
    .addEdge(START, "gatherMemories")
    .addEdge("gatherMemories", "draftWithNia")
    .addEdge("gatherUserContext", "classifyAndPersistPlan")
    .addEdge("draftWithNia", "classifyAndPersistPlan")
    .addEdge("classifyAndPersistPlan", "runNextStep")
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
