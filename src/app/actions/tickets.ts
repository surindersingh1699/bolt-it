"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import {
  getTicket,
  getWorkspace,
  insertRunbook,
  insertTicket,
  listRunbooks,
  updateRunbook,
  updateStep,
  updateTicket,
} from "@/lib/data";
import { Citation, PlanStep, Ticket } from "@/lib/types";
import { ensureSeeded } from "@/lib/seed";
import { niaDraft, niaIngestTicketResolution } from "@/lib/integrations/nia";
import { asideExecute } from "@/lib/integrations/aside";
import { insforgeInvoke } from "@/lib/integrations/insforge";
import { tensorlakeRun } from "@/lib/integrations/tensorlake";
import { getUserContext, queryMemories } from "@/lib/integrations/hyperspell";
import { getCurrentUser } from "@/lib/auth";
import { ACME_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace";
import { enqueueAgentJob, humanLabelFor, isAgentJobCapability } from "@/lib/agent-jobs";
import { postSlackMessage } from "@/lib/slack";

async function postSlackUpdate(ticket: Ticket, text: string): Promise<void> {
  const ws = await getWorkspace(ticket.workspaceId);
  const ctx = slackContextFromTicket(ticket);
  if (!ws?.slackAccessToken || !ctx.channel) return;
  await postSlackMessage(ws.slackAccessToken, ctx.channel, text, ctx.threadTs).catch(() => undefined);
}

function humanStepLabel(step: PlanStep): string {
  if (step.description) return step.description;
  if (step.kind === "tensorlake") return humanLabelFor(step.capability);
  if (step.kind === "insforge") return "Running secure backend action";
  if (step.kind === "aside") return "Running action in your browser session";
  if (step.kind === "slack_reply") return "Replying with the resolution";
  return "Working";
}
import { classifyPlan } from "@/lib/policy";

export interface CreateTicketInput {
  reporter: string;
  reporterEmail: string;
  subject: string;
  body: string;
  channel?: "slack" | "email" | "portal";
  customerOrg?: string;
  workspaceId?: string;
}

export async function createTicket(input: CreateTicketInput): Promise<string> {
  await ensureSeeded();
  const id = `T-${Math.floor(Math.random() * 9000 + 1000)}`;
  const now = Date.now();
  const workspaceId =
    input.workspaceId ?? (await getCurrentWorkspaceId()) ?? ACME_WORKSPACE_ID;
  const ticket: Ticket = {
    id,
    workspaceId,
    customerOrg: input.customerOrg ?? "acme",
    channel: input.channel ?? "slack",
    reporter: input.reporter,
    reporterEmail: input.reporterEmail,
    subject: input.subject,
    body: input.body,
    status: "new",
    createdAt: now,
    updatedAt: now,
    plan: [],
    citations: [],
    confidence: 0,
    resolvedByAi: false,
  };
  await insertTicket(ticket);
  safeRevalidate("/");
  after(async () => {
    try {
      if (ticket.channel === "slack") {
        const firstName = ticket.reporter.split(/\s+/)[0];
        await postSlackUpdate(
          ticket,
          `👋 Hi ${firstName} — got it. I'm gathering context from your runbooks, user history, and recent activity. Logged as ticket ${ticket.id}.`,
        );
      }
      await draftPlan(id);
    } catch (err) {
      console.error(`[createTicket] draftPlan failed for ${id}:`, err);
    }
  });
  return id;
}

const DRAFT_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function safeRevalidate(path: string): void {
  try {
    revalidatePath(path);
  } catch {
    // revalidatePath throws if called during a render; client polls /api/state anyway
  }
}

export async function draftPlan(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  await updateTicket(ticketId, { status: "drafting" });
  safeRevalidate("/");

  try {
    const [userCtx, memories] = await Promise.all([
      getUserContext(ticket.reporterEmail).catch(() => null),
      queryMemories(`${ticket.subject}\n${ticket.body}`).catch(() => []),
    ]);
    const draft = await withTimeout(
      niaDraft({
        subject: ticket.subject,
        body: ticket.body,
        reporter: ticket.reporter,
        reporterEmail: ticket.reporterEmail,
        customerOrg: ticket.customerOrg,
        workspaceId: ticket.workspaceId,
        memories,
      }),
      DRAFT_TIMEOUT_MS,
      "draftPlan",
    );

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

    await updateTicket(ticketId, {
      status: "awaiting_approval",
      citations,
      confidence: draft.confidence,
      draftResponse: draft.response,
      plan,
    });
    const updatedForSlack = await getTicket(ticketId);
    if (updatedForSlack) {
      const firstName = ticket.reporter.split(/\s+/)[0];
      const planLines = plan.map((s, i) => `   ${i + 1}. ${humanStepLabel(s)}`).join("\n");
      await postSlackUpdate(
        updatedForSlack,
        `🔎 Hi ${firstName} — I have a plan and I'm waiting for an IT technician to approve it:\n${planLines}\n\n_Ticket ${ticketId} · saved for future reference_`,
      );
    }
  } catch (err) {
    console.warn(`[draftPlan] ${ticketId} failed (${(err as Error).message}); using minimal fallback`);
    const firstName = ticket.reporter.split(/\s+/)[0];
    const fallbackPlan = await classifyPlan(
      [
        {
          id: "step-0",
          kind: "slack_reply",
          description: "Acknowledge and ask for more detail",
          status: "pending",
        },
      ],
      ticket,
    );
    await updateTicket(ticketId, {
      status: "awaiting_approval",
      citations: [],
      confidence: 0.4,
      draftResponse: `Hi ${firstName} — I'm taking a look at this and will follow up shortly. Could you share any error message or screenshot if you have one?`,
      plan: fallbackPlan,
    });
  }
  safeRevalidate("/");
}

function substituteParams(
  params: Record<string, unknown> | undefined,
  reporterEmail: string,
): Record<string, unknown> | undefined {
  if (!params) return params;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string" && v.includes("{reporter_email}")) {
      out[k] = v.replace("{reporter_email}", reporterEmail);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function approveAndExecute(ticketId: string): Promise<void> {
  const requestingUser = await getCurrentUser();
  if (!requestingUser?.isITStaff) {
    throw new Error("Only IT staff can approve plans.");
  }
  await runApprovedPlan(ticketId, {
    name: requestingUser.name,
    email: requestingUser.email,
  });
}

export async function demoApproveAndExecute(ticketId: string): Promise<void> {
  await runApprovedPlan(ticketId, { name: "demo IT staff", email: "demo@local" });
}

interface Approver {
  name: string;
  email: string;
}

async function runApprovedPlan(ticketId: string, approver: Approver): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_approval") return;
  await updateTicket(ticketId, { status: "executing" });
  safeRevalidate("/");
  after(async () => {
    try {
      await executePlan(ticketId, approver);
    } catch (err) {
      console.error(`[runApprovedPlan] executePlan failed for ${ticketId}:`, err);
    }
  });
}

async function executePlan(ticketId: string, approver: Approver): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;

  for (const step of ticket.plan) {
    if (step.approvalMode === "human") {
      await updateStep(ticketId, step.id, {
        log: [
          ...(step.log ?? []),
          `[Policy] High-risk step approved by ${approver.name} (${approver.email}) — proceeding`,
        ],
      });
    }

    await updateStep(ticketId, step.id, { status: "running", startedAt: Date.now() });
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
        log = [
          `[Slack] Posting reply in #it-support thread for ${ticket.reporter}`,
        ];
        const ws = await getWorkspace(ticket.workspaceId);
        const slackContext = slackContextFromTicket(ticket);
        if (ws?.slackAccessToken && slackContext.channel) {
          const msg = await postSlackMessage(
            ws.slackAccessToken,
            slackContext.channel,
            ticket.draftResponse ?? `Hi ${ticket.reporter.split(/\s+/)[0]} — your IT ticket ${ticket.id} has been updated.`,
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

    await updateStep(ticketId, step.id, {
      status: ok ? "succeeded" : "failed",
      log,
      finishedAt: Date.now(),
    });

    if (!ok) {
      await updateTicket(ticketId, { status: "escalated" });
      return;
    }
  }

  const finishedTicket = await getTicket(ticketId);
  if (!finishedTicket) return;

  await updateTicket(ticketId, { status: "awaiting_confirmation" });
  safeRevalidate("/");

  if (finishedTicket.channel === "slack") {
    const firstName = finishedTicket.reporter.split(/\s+/)[0];
    const ranSteps = finishedTicket.plan
      .filter((s) => s.status === "succeeded")
      .map((s, i) => `   ${i + 1}. ${humanStepLabel(s)}`)
      .join("\n");
    await postSlackUpdate(
      finishedTicket,
      `✅ Hi ${firstName} — I finished the plan on your machine:\n${ranSteps}\n\nIs the issue resolved? Reply *yes* or *no* in this thread (ticket ${ticketId}).`,
    );
  }
}

export async function confirmTicketResolved(
  ticketId: string,
  source: "user_slack" | "auto_timeout" = "user_slack",
): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_confirmation") return;
  await updateTicket(ticketId, {
    status: "resolved",
    resolvedAt: Date.now(),
    resolvedByAi: true,
    resolutionTimeMs: Date.now() - ticket.createdAt,
  });
  if (ticket.channel === "slack" && source === "user_slack") {
    const firstName = ticket.reporter.split(/\s+/)[0];
    await postSlackUpdate(
      ticket,
      `🎉 Glad I could help, ${firstName}. I've saved this fix to the runbook so the next identical issue will resolve even faster.`,
    );
  }
  await extractRunbook(ticketId);
  safeRevalidate("/");
}

export async function escalateAfterUserDenied(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_confirmation") return;
  await updateTicket(ticketId, { status: "escalated" });
  if (ticket.channel === "slack") {
    const firstName = ticket.reporter.split(/\s+/)[0];
    await postSlackUpdate(
      ticket,
      `🙏 Sorry that didn't fix it, ${firstName}. I've escalated ticket ${ticketId} to a human technician — they'll reach out shortly.`,
    );
  }
  safeRevalidate("/");
}

function slackContextFromTicket(ticket: Ticket): { channel?: string; threadTs?: string } {
  const channel = ticket.body.match(/Slack channel:\s*([A-Z0-9]+)/i)?.[1];
  const threadTs = ticket.body.match(/Slack thread:\s*([0-9.]+)/i)?.[1];
  return { channel, threadTs };
}

export async function extractRunbook(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "resolved") return;

  const sourceCitation = ticket.citations.find((c) => c.ref.startsWith("runbook:"));
  if (sourceCitation && ticket.confidence >= 0.6) {
    const rbId = sourceCitation.ref.replace("runbook:", "");
    const existing = (await listRunbooks(ticket.workspaceId)).find((r) => r.id === rbId);
    if (existing) {
      await updateRunbook(rbId, {
        successCount: existing.successCount + 1,
        sourceTicketIds: [...existing.sourceTicketIds, ticket.id],
      });
      return;
    }
  }

  const id = `rb-${ticket.id.toLowerCase()}`;
  const tags = inferTagsFromTicket(ticket.subject + " " + ticket.body);
  const body = synthesizeRunbookBody(ticket);
  const now = Date.now();
  await insertRunbook({
    id,
    workspaceId: ticket.workspaceId,
    title: `Auto: ${ticket.subject.slice(0, 80)}`,
    tags,
    body,
    sourceTicketIds: [ticket.id],
    createdAt: now,
    updatedAt: now,
    successCount: 1,
    failureCount: 0,
  });
  await niaIngestTicketResolution(ticket.id, ticket.subject, body, tags);
}

function inferTagsFromTicket(text: string): string[] {
  const t = text.toLowerCase();
  const tags: string[] = [];
  for (const tag of ["figma", "sso", "okta", "vpn", "network", "password", "reset", "laptop", "mdm"]) {
    if (t.includes(tag)) tags.push(tag);
  }
  if (tags.length === 0) tags.push("misc");
  return tags;
}

function synthesizeRunbookBody(ticket: Ticket): string {
  const steps = ticket.plan
    .map((s, i) => `${i + 1}. (${s.kind}) ${s.description} — ${s.status}`)
    .join("\n");
  return `Symptom: ${ticket.subject}\n\nUser report: ${ticket.body}\n\nResolution plan executed:\n${steps}\n\nOutcome: resolved by AI in ${Math.round((ticket.resolutionTimeMs ?? 0) / 1000)}s.`;
}

export async function escalateTicket(ticketId: string): Promise<void> {
  const requestingUser = await getCurrentUser();
  if (!requestingUser?.isITStaff) {
    throw new Error("Only IT staff can escalate tickets.");
  }
  await updateTicket(ticketId, { status: "escalated" });
  safeRevalidate("/");
}
