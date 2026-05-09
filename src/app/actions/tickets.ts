"use server";

import { revalidatePath } from "next/cache";
import {
  getTicket,
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
  void draftPlan(id);
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

    const plan: PlanStep[] = draft.plan.map((step) => ({
      ...step,
      params: substituteParams(step.params, ticket.reporterEmail),
    }));

    await updateTicket(ticketId, {
      status: "awaiting_approval",
      citations,
      confidence: draft.confidence,
      draftResponse: draft.response,
      plan,
    });
  } catch (err) {
    console.warn(`[draftPlan] ${ticketId} failed (${(err as Error).message}); using minimal fallback`);
    const firstName = ticket.reporter.split(/\s+/)[0];
    await updateTicket(ticketId, {
      status: "awaiting_approval",
      citations: [],
      confidence: 0.4,
      draftResponse: `Hi ${firstName} — I'm taking a look at this and will follow up shortly. Could you share any error message or screenshot if you have one?`,
      plan: [
        {
          id: "step-0",
          kind: "slack_reply",
          description: "Acknowledge and ask for more detail",
          status: "pending",
        },
      ],
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
  await runApprovedPlan(ticketId);
}

export async function demoApproveAndExecute(ticketId: string): Promise<void> {
  await runApprovedPlan(ticketId);
}

async function runApprovedPlan(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_approval") return;
  await updateTicket(ticketId, { status: "executing" });
  safeRevalidate("/");
  void executePlan(ticketId);
}

async function executePlan(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;

  for (const step of ticket.plan) {
    await updateStep(ticketId, step.id, { status: "running", startedAt: Date.now() });

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
        const r = await tensorlakeRun(step, ticket.reporterEmail);
        ok = r.ok;
        log = r.log;
      } else if (step.kind === "slack_reply") {
        log = [
          `[Slack] Posting reply in #it-support thread for ${ticket.reporter}`,
          `[Slack] Message delivered`,
        ];
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

  const resolvedTicket = await getTicket(ticketId);
  if (!resolvedTicket) return;

  const resolutionTimeMs = Date.now() - resolvedTicket.createdAt;
  await updateTicket(ticketId, {
    status: "resolved",
    resolvedAt: Date.now(),
    resolvedByAi: true,
    resolutionTimeMs,
  });

  await extractRunbook(ticketId);
  safeRevalidate("/");
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
