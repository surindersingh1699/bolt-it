"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import {
  clearTicketsAndJobsForWorkspace,
  getTicket,
  insertRunbook,
  insertTicket,
  listRunbooks,
  updateRunbook,
  updateTicket,
} from "@/lib/data";
import { Ticket } from "@/lib/types";
import { ensureSeeded } from "@/lib/seed";
import { niaIngestTicketResolution } from "@/lib/integrations/nia";
import { addMemory } from "@/lib/integrations/hyperspell";
import { getCurrentUser } from "@/lib/auth";
import { ACME_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace";
import { inferTagsFromTicket, postSlackUpdate, synthesizeRunbookBody } from "@/lib/ticket-helpers";
import { runTicketGraphFromStart, resumeTicketGraph } from "@/lib/ticket-graph";

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
      await runTicketGraphFromStart(id);
    } catch (err) {
      console.error(`[createTicket] ticket graph failed for ${id}:`, err);
    }
  });
  return id;
}

function safeRevalidate(path: string): void {
  try {
    revalidatePath(path);
  } catch {
    // revalidatePath throws if called during a render; client polls /api/state anyway
  }
}

export async function approveAndExecute(ticketId: string): Promise<void> {
  const requestingUser = await getCurrentUser();
  if (!requestingUser?.isITStaff) {
    throw new Error("Only IT staff can approve plans.");
  }
  await resumeApprovedStep(ticketId, {
    name: requestingUser.name,
    email: requestingUser.email,
  });
}

export async function demoApproveAndExecute(ticketId: string): Promise<void> {
  await resumeApprovedStep(ticketId, { name: "demo IT staff", email: "demo@local" });
}

async function resumeApprovedStep(ticketId: string, approver: { name: string; email: string }): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_approval") return;
  // Flip immediately so a duplicate click can't fire a second resume into the
  // same paused graph thread before the first one clears the interrupt.
  await updateTicket(ticketId, { status: "executing" });
  safeRevalidate("/");
  after(async () => {
    try {
      await resumeTicketGraph(ticketId, { approved: true, approver });
    } catch (err) {
      console.error(`[resumeApprovedStep] resumeTicketGraph failed for ${ticketId}:`, err);
    }
  });
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

export async function extractRunbook(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "resolved") return;

  // Write the resolution back to Hyperspell so it's a two-way memory, not just
  // queried on draft. New behavior, not a preserved one — see CLAUDE.md's
  // "Hyperspell is essential" note: it must stay live and unconditional.
  await addMemory(
    `Ticket ${ticket.id} resolved: ${ticket.subject}\n\n${synthesizeRunbookBody(ticket)}`,
    `IT support resolution: ${ticket.subject}`,
    "it-support-ticket-resolution",
    ticket.reporterEmail,
  ).catch(() => null);

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

export async function clearTicketQueue(): Promise<{ tickets: number; agentJobs: number }> {
  const requestingUser = await getCurrentUser();
  const workspaceId =
    requestingUser?.workspaceId ?? (await getCurrentWorkspaceId()) ?? ACME_WORKSPACE_ID;
  const result = await clearTicketsAndJobsForWorkspace(workspaceId);
  safeRevalidate("/");
  return result;
}

export async function escalateTicket(ticketId: string): Promise<void> {
  const requestingUser = await getCurrentUser();
  if (!requestingUser?.isITStaff) {
    throw new Error("Only IT staff can escalate tickets.");
  }
  await updateTicket(ticketId, { status: "escalated" });
  safeRevalidate("/");
}

export async function chatWithAgent(ticketId: string, message: string): Promise<"chat" | "new_ticket"> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return "new_ticket";
  const firstName = ticket.reporter.split(/\s+/)[0];
  const planLines = ticket.plan
    .map((s) => `- [${s.status}] ${s.description}${s.log?.length ? ` | ${s.log.slice(-2).join(" | ").slice(0, 200)}` : ""}`)
    .join("\n");
  const summary = `Subject: ${ticket.subject}\nStatus: ${ticket.status}\nAttempts: ${ticket.attempts ?? 1}\nSteps:\n${planLines}\nTroubleshooting findings:\n${ticket.troubleshootingSummary ?? "(none)"}`;
  const { conversationalReply } = await import("@/lib/integrations/ai-gateway");
  const result = await conversationalReply({ userMessage: message, firstName, ticketSummary: summary });
  if (!result || result.newIssue || !result.reply) return "new_ticket";
  // Record the user's message only once we know it belongs to this thread —
  // on the new_ticket path it becomes the new ticket's body instead.
  const { appendUserChat } = await import("@/lib/chat");
  appendUserChat(ticketId, message);
  await postSlackUpdate(ticket, result.reply);
  safeRevalidate("/");
  return "chat";
}
