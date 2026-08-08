"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import {
  clearTicketsAndJobsForWorkspace,
  deleteTicket,
  getTicket,
  insertTicket,
  listAgentJobs,
  updateTicket,
} from "@/lib/data";
import { Attachment, Ticket } from "@/lib/types";
import { uploadAttachment } from "@/lib/attachments";
import { ensureSeeded } from "@/lib/seed";
import { getCurrentUser } from "@/lib/auth";
import { ACME_WORKSPACE_ID, getCurrentWorkspaceId } from "@/lib/workspace";
import { buildReplyEvidence, firstNameOf, postUpdate } from "@/lib/ticket-helpers";
import { reopenTicketGraph, runTicketGraphFromStart, resumeTicketGraph } from "@/lib/ticket-graph";

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

/**
 * The employee says it did not work.
 *
 * This used to escalate on the spot. It now takes one more look first: their
 * account of what is still happening is new evidence, the machine is re-read on
 * the way in, and the reopen budget in the graph is what decides when a person
 * takes over. Escalating on the first "no" threw away a whole round that was
 * still available and left them with nothing to do but wait.
 */
export async function escalateAfterUserDenied(ticketId: string, detail?: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket || ticket.status !== "awaiting_confirmation") return;
  await takeAnotherLook(ticketId, detail ?? "the employee said the problem is still happening");
  safeRevalidate("/");
}

/**
 * Send the ticket back through the graph with what the employee just told us.
 *
 * No budget check here on purpose. `reopenTicketGraph` counts the reopens and
 * the strategist hands off once it passes MAX_REOPENS, so the bound lives in
 * one place — a second copy of it here could disagree with the graph's.
 */
async function takeAnotherLook(ticketId: string, detail: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  await updateTicket(ticketId, { status: "executing" });
  after(async () => {
    try {
      await reopenTicketGraph(ticketId, detail);
    } catch (err) {
      console.error(`[takeAnotherLook] reopenTicketGraph failed for ${ticketId}:`, err);
    }
  });
}

/** They asked for a person. Trying more things is the wrong answer. */
async function handOffToHuman(ticketId: string, detail: string): Promise<void> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  await updateTicket(ticketId, {
    status: "escalated",
    troubleshootingSummary: `${ticket.troubleshootingSummary ?? ""}\n\nThe employee asked for a person: "${detail}"`.trim(),
  });
}

export async function clearTicketQueue(): Promise<{ tickets: number; agentJobs: number }> {
  const requestingUser = await getCurrentUser();
  const workspaceId =
    requestingUser?.workspaceId ?? (await getCurrentWorkspaceId()) ?? ACME_WORKSPACE_ID;
  const result = await clearTicketsAndJobsForWorkspace(workspaceId);
  safeRevalidate("/");
  return result;
}

/**
 * Delete a single ticket and its jobs.
 *
 * The employee may remove their own tickets; IT staff may remove any. Anything
 * else is refused — a delete button is convenience, not a way to reach across
 * accounts. Idempotent: deleting a ticket that is already gone is a no-op, so a
 * double-click cannot error.
 */
export async function deleteTicketAction(ticketId: string): Promise<void> {
  const requestingUser = await getCurrentUser();
  if (!requestingUser) throw new Error("Not signed in.");

  const ticket = await getTicket(ticketId);
  if (!ticket) return; // already gone

  const ownsIt = ticket.reporterEmail.toLowerCase() === requestingUser.email.toLowerCase();
  if (!ownsIt && !requestingUser.isITStaff) {
    throw new Error("You can only delete your own tickets.");
  }

  await deleteTicket(ticketId);
  safeRevalidate("/");
}

export async function escalateTicket(ticketId: string): Promise<void> {
  const requestingUser = await getCurrentUser();
  if (!requestingUser?.isITStaff) {
    throw new Error("Only IT staff can escalate tickets.");
  }
  await updateTicket(ticketId, { status: "escalated" });
  safeRevalidate("/");
}

/**
 * The employee said something in the thread.
 *
 * The desk answers from the same evidence the engineer had — what actually ran,
 * what the device's own probes said about it, and everything already said in
 * this conversation. It used to answer from a truncated plan summary with no
 * history at all, which is why it half-answered and then re-asked.
 *
 * The reply's `intent` decides where this goes. That is a label the model
 * returns and this function switches on, exactly like the `new_issue` flag it
 * replaces — no model picks a graph node.
 */
export async function chatWithAgent(ticketId: string, message: string): Promise<"chat" | "new_ticket"> {
  const ticket = await getTicket(ticketId);
  if (!ticket) return "new_ticket";

  const firstName = firstNameOf(ticket.reporter);
  const { appendUserChat, getChat } = await import("@/lib/chat");
  const history = getChat(ticketId).slice(-12);

  const jobs = (await listAgentJobs(ticket.workspaceId)).filter((j) => j.ticketId === ticketId);
  const evidence = buildReplyEvidence(ticket.plan, jobs);

  const { conversationalReply } = await import("@/lib/integrations/ai-gateway");
  const result = await conversationalReply({
    ticketId,
    firstName,
    subject: ticket.subject,
    body: ticket.body,
    userMessage: message,
    history,
    evidence,
    diagnosis: ticket.troubleshootingSummary,
    status: ticket.status,
  }).catch(() => null);

  // No usable answer is not a new problem. Opening a ticket here — which is what
  // this used to do — turned every gateway timeout into a duplicate ticket the
  // employee never asked for. Say so instead, and keep their message on the
  // thread it belongs to.
  if (!result) {
    appendUserChat(ticketId, message);
    await postUpdate(
      ticket,
      `Hi ${firstName} — I can't reach my tools at the moment, so I don't want to guess at an answer. ` +
        `I've kept what you said on ticket ${ticketId} and I'll pick it up as soon as I'm back.`,
    );
    safeRevalidate("/");
    return "chat";
  }

  // A different problem. Say so on this thread first — the message becomes the
  // new ticket's body, so without this line it would vanish from here entirely.
  if (result.intent === "new_issue") {
    await postUpdate(ticket, result.reply);
    safeRevalidate("/");
    return "new_ticket";
  }

  appendUserChat(ticketId, message);
  await postUpdate(ticket, result.reply);

  if (result.intent === "wants_human") {
    await handOffToHuman(ticketId, message);
  } else if (result.intent === "still_broken") {
    await takeAnotherLook(ticketId, message);
  }

  safeRevalidate("/");
  return "chat";
}
