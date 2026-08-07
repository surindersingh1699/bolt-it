"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import {
  clearTicketsAndJobsForWorkspace,
  getTicket,
  insertTicket,
  updateTicket,
} from "@/lib/data";
import { Attachment, Ticket } from "@/lib/types";
import { uploadAttachment } from "@/lib/attachments";
import { ensureSeeded } from "@/lib/seed";
import { getCurrentUser } from "@/lib/auth";
import { ACME_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace";
import { firstNameOf, postUpdate } from "@/lib/ticket-helpers";
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

/**
 * Screenshots are uploaded BEFORE the ticket is inserted, not after.
 *
 * The graph is started from `after()` the moment the row exists, and its very
 * first expensive call reads the attachments. Uploading afterwards would race
 * that: sometimes the strategist sees the screenshot, sometimes it does not,
 * and the difference would look like model flakiness rather than a race.
 */
export async function createTicket(
  input: CreateTicketInput,
  formData?: FormData,
): Promise<string> {
  await ensureSeeded();
  const id = `T-${Math.floor(Math.random() * 9000 + 1000)}`;
  const now = Date.now();
  const workspaceId =
    input.workspaceId ?? (await getCurrentWorkspaceId()) ?? ACME_WORKSPACE_ID;
  const attachments: Attachment[] = [];
  for (const entry of formData?.getAll("file") ?? []) {
    if (!(entry instanceof File) || entry.size === 0) continue;
    const result = await uploadAttachment(id, entry);
    if (result.ok) attachments.push(result.attachment);
    else console.warn(`[createTicket] ${id} attachment rejected: ${result.error}`);
  }

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
    attachments,
    confidence: 0,
    resolvedByAi: false,
  };
  await insertTicket(ticket);
  safeRevalidate("/");
  after(async () => {
    try {
      if (ticket.channel === "slack") {
        const firstName = firstNameOf(ticket.reporter);
        await postUpdate(
          ticket,
          `👋 Hi ${firstName} — got it. I'm gathering context from your history and your machine. Logged as ticket ${ticket.id}.`,
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
    const firstName = firstNameOf(ticket.reporter);
    await postUpdate(
      ticket,
      `🎉 Glad I could help, ${firstName}. I've noted what worked, so the next time this comes up I'll get there faster.`,
    );
  }
  safeRevalidate("/");
}

export async function escalateAfterUserDenied(ticketId: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_confirmation") return;
  await updateTicket(ticketId, { status: "escalated" });
  if (ticket.channel === "slack") {
    const firstName = firstNameOf(ticket.reporter);
    await postUpdate(
      ticket,
      `🙏 Sorry that didn't fix it, ${firstName}. I've escalated ticket ${ticketId} to a human technician — they'll reach out shortly.`,
    );
  }
  safeRevalidate("/");
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
  const firstName = firstNameOf(ticket.reporter);
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
  await postUpdate(ticket, result.reply);
  safeRevalidate("/");
  return "chat";
}
