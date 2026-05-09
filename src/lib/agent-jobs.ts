import { randomBytes } from "crypto";
import { insertAgentJob, updateStep } from "./data";
import { AgentJob, PlanStep, Ticket } from "./types";

export function isAgentJobCapability(capability?: string): boolean {
  return (
    capability === "diag.network_probe" ||
    capability === "sandbox.read_auth_logs" ||
    capability === "sandbox.read_kerberos_logs"
  );
}

export async function enqueueAgentJob(ticket: Ticket, step: PlanStep): Promise<AgentJob> {
  const now = Date.now();
  const job: AgentJob = {
    id: `job-${randomBytes(6).toString("hex")}`,
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    stepId: step.id,
    kind: jobKindForCapability(step.capability),
    targetUserEmail: ticket.reporterEmail,
    instructions: instructionsForCapability(ticket, step),
    allowlistedCommand: commandForCapability(step.capability, ticket.reporterEmail),
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await insertAgentJob(job);
  await updateStep(ticket.id, step.id, {
    log: [
      `[Agent Queue] Created ${job.id}`,
      `[Agent Queue] Capability: ${step.capability ?? step.kind}`,
      `[Agent Queue] Safe command: ${job.allowlistedCommand}`,
      `[Agent Queue] Local sandbox agent may poll /api/agent/jobs to execute diagnostics.`,
    ],
  });
  return job;
}

function jobKindForCapability(capability?: string): AgentJob["kind"] {
  if (capability === "diag.network_probe") return "network_probe";
  if (capability === "sandbox.read_auth_logs" || capability === "sandbox.read_kerberos_logs") {
    return "collect_logs";
  }
  return "app_diagnostic";
}

function commandForCapability(capability: string | undefined, email: string): string {
  const user = email.replace(/[^a-zA-Z0-9@._-]/g, "");
  if (capability === "diag.network_probe") {
    return `collect_vpn_diagnostics --user ${user} --redact-secrets`;
  }
  if (capability === "sandbox.read_kerberos_logs") {
    return `collect_windows_event_logs --user ${user} --source kerberos --redact-secrets`;
  }
  if (capability === "sandbox.read_auth_logs") {
    return `collect_auth_logs --user ${user} --window 2h --redact-secrets`;
  }
  return `collect_app_logs --user ${user} --redact-secrets`;
}

function instructionsForCapability(ticket: Ticket, step: PlanStep): string {
  return [
    `Ticket ${ticket.id}: ${ticket.subject}`,
    `Reporter: ${ticket.reporter} <${ticket.reporterEmail}>`,
    `Approved diagnostic step: ${step.description}`,
    "Run only the allowlisted command in the local sandbox.",
    "Redact secrets, tokens, cookies, IPs if policy requires it.",
    "Return concise findings and relevant log lines.",
  ].join("\n");
}
