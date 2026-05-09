"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Citation, PlanStep, Ticket } from "@/lib/types";
import { ensureSeeded } from "@/lib/seed";
import { niaDraft, niaIngestTicketResolution } from "@/lib/integrations/nia";
import { asideExecute } from "@/lib/integrations/aside";
import { insforgeInvoke } from "@/lib/integrations/insforge";
import { tensorlakeRun } from "@/lib/integrations/tensorlake";
import { getUserContext } from "@/lib/integrations/hyperspell";

export interface CreateTicketInput {
  reporter: string;
  reporterEmail: string;
  subject: string;
  body: string;
  channel?: "slack" | "email" | "portal";
  customerOrg?: string;
}

export async function createTicket(input: CreateTicketInput): Promise<string> {
  ensureSeeded();
  const id = `T-${Math.floor(Math.random() * 9000 + 1000)}`;
  const now = Date.now();
  const ticket: Ticket = {
    id,
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
  db.insertTicket(ticket);
  revalidatePath("/");
  void draftPlan(id);
  return id;
}

export async function draftPlan(ticketId: string): Promise<void> {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return;
  db.updateTicket(ticketId, { status: "drafting" });
  revalidatePath("/");

  const userCtx = await getUserContext(ticket.reporterEmail);
  const draft = await niaDraft({
    subject: ticket.subject,
    body: ticket.body,
    reporter: ticket.reporter,
    reporterEmail: ticket.reporterEmail,
    customerOrg: ticket.customerOrg,
  });

  const citations: Citation[] = [...draft.citations];
  if (userCtx) {
    citations.push({
      source: "hyperspell",
      title: `${userCtx.name} — ${userCtx.team} team`,
      snippet: `Recent apps: ${userCtx.recentApps.join(", ")}`,
      ref: `user:${userCtx.email}`,
    });
  }

  const plan: PlanStep[] = draft.plan.map((step) => ({
    ...step,
    params: substituteParams(step.params, ticket.reporterEmail),
  }));

  db.updateTicket(ticketId, {
    status: "awaiting_approval",
    citations,
    confidence: draft.confidence,
    draftResponse: draft.response,
    plan,
  });
  revalidatePath("/");
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
  const ticket = db.getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_approval") return;
  db.updateTicket(ticketId, { status: "executing" });
  revalidatePath("/");
  void executePlan(ticketId);
}

async function executePlan(ticketId: string): Promise<void> {
  const ticket = db.getTicket(ticketId);
  if (!ticket) return;

  for (const step of ticket.plan) {
    db.updateStep(ticketId, step.id, { status: "running", startedAt: Date.now() });

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

    db.updateStep(ticketId, step.id, {
      status: ok ? "succeeded" : "failed",
      log,
      finishedAt: Date.now(),
    });

    if (!ok) {
      db.updateTicket(ticketId, { status: "escalated" });
      return;
    }
  }

  const resolvedTicket = db.getTicket(ticketId);
  if (!resolvedTicket) return;

  const resolutionTimeMs = Date.now() - resolvedTicket.createdAt;
  db.updateTicket(ticketId, {
    status: "resolved",
    resolvedAt: Date.now(),
    resolvedByAi: true,
    resolutionTimeMs,
  });

  await extractRunbook(ticketId);
  revalidatePath("/");
}

export async function extractRunbook(ticketId: string): Promise<void> {
  const ticket = db.getTicket(ticketId);
  if (!ticket || ticket.status !== "resolved") return;

  const sourceCitation = ticket.citations.find((c) => c.ref.startsWith("runbook:"));
  if (sourceCitation && ticket.confidence >= 0.6) {
    const rbId = sourceCitation.ref.replace("runbook:", "");
    const existing = db.listRunbooks().find((r) => r.id === rbId);
    if (existing) {
      db.updateRunbook(rbId, {
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
  db.insertRunbook({
    id,
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
  db.updateTicket(ticketId, { status: "escalated" });
  revalidatePath("/");
}
