import { getTicket, getWorkspace, listAgentJobs } from "@/lib/data";
import { AgentJob, PlanStep, Ticket } from "@/lib/types";
import { humanLabelFor } from "@/lib/agent-jobs";
import { postSlackMessage } from "@/lib/slack";
import { SlackReplyEvidence } from "@/lib/integrations/ai-gateway";
import { appendChat } from "@/lib/chat";

export async function postSlackUpdate(ticket: Ticket, text: string): Promise<void> {
  // Always record in the in-app conversation transcript (the demo Slack tab
  // shows the full thread even with no real Slack wired).
  appendChat(ticket.id, text);
  const ws = await getWorkspace(ticket.workspaceId);
  const ctx = slackContextFromTicket(ticket);
  if (!ws?.slackAccessToken || !ctx.channel) return;
  await postSlackMessage(ws.slackAccessToken, ctx.channel, text, ctx.threadTs).catch(() => undefined);
}

export function humanStepLabel(step: PlanStep): string {
  if (step.description) return step.description;
  if (step.kind === "tensorlake") return humanLabelFor(step.capability);
  if (step.kind === "insforge") return "Running secure backend action";
  if (step.kind === "aside") return "Running action in your browser session";
  if (step.kind === "slack_reply") return "Replying with the resolution";
  return "Working";
}

export function substituteParams(
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

export function slackContextFromTicket(ticket: Ticket): { channel?: string; threadTs?: string } {
  const channel = ticket.body.match(/Slack channel:\s*([A-Z0-9]+)/i)?.[1];
  const threadTs = ticket.body.match(/Slack thread:\s*([0-9.]+)/i)?.[1];
  return { channel, threadTs };
}

export function buildSlackReplyEvidence(
  steps: PlanStep[],
  jobs: AgentJob[],
): SlackReplyEvidence[] {
  return steps
    .filter((s) => s.kind !== "slack_reply" && s.status !== "pending" && s.status !== "skipped")
    .map((s) => {
      const matchingJob = jobs
        .filter((j) => j.stepId === s.id && j.status === "succeeded" && j.output)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
      return {
        stepDescription: s.description || humanStepLabel(s),
        capability: s.capability,
        status: s.status,
        logLines: s.log ?? [],
        agentOutput: matchingJob?.output,
      };
    });
}

export async function waitForAgentJobs(ticketId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ticket = await getTicket(ticketId);
    if (!ticket) return;
    const allJobs = await listAgentJobs(ticket.workspaceId);
    const pending = allJobs.filter(
      (j) => j.ticketId === ticketId && (j.status === "queued" || j.status === "claimed"),
    );
    if (pending.length === 0) return;
    await new Promise((r) => setTimeout(r, 800));
  }
}

export function inferTagsFromTicket(text: string): string[] {
  const t = text.toLowerCase();
  const tags: string[] = [];
  for (const tag of ["figma", "sso", "okta", "vpn", "network", "password", "reset", "laptop", "mdm"]) {
    if (t.includes(tag)) tags.push(tag);
  }
  if (tags.length === 0) tags.push("misc");
  return tags;
}

export function synthesizeRunbookBody(ticket: Ticket): string {
  const steps = ticket.plan
    .map((s, i) => `${i + 1}. (${s.kind}) ${s.description} — ${s.status}`)
    .join("\n");
  return `Symptom: ${ticket.subject}\n\nUser report: ${ticket.body}\n\nResolution plan executed:\n${steps}\n\nOutcome: resolved by AI in ${Math.round((ticket.resolutionTimeMs ?? 0) / 1000)}s.`;
}
