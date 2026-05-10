import { randomBytes } from "crypto";
import { insertAgentJob, updateStep } from "./data";
import { AgentJob, PlanStep, Ticket } from "./types";

export function isAgentJobCapability(capability?: string): boolean {
  return (
    capability === "diag.network_probe" ||
    capability === "sandbox.read_auth_logs" ||
    capability === "sandbox.read_kerberos_logs" ||
    capability === "fix.restart_app" ||
    capability === "fix.clear_app_cache" ||
    capability === "fix.toggle_wifi"
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
    allowlistedCommand: commandForCapability(step.capability, ticket.reporterEmail, step.params),
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  await insertAgentJob(job);
  await updateStep(ticket.id, step.id, {
    log: [
      `[Agent Queue] Plan step: ${humanLabelFor(step.capability)}`,
      `[Agent Queue] Routing to local sandbox agent on the technician's machine`,
      `[Agent Queue] Sandboxed command (audit): ${job.allowlistedCommand}`,
    ],
  });
  return job;
}

export function humanLabelFor(capability: string | undefined): string {
  if (capability === "diag.network_probe") return "Run network diagnostic in sandbox";
  if (capability === "sandbox.read_auth_logs") return "Inspect system logs in sandbox";
  if (capability === "sandbox.read_kerberos_logs") return "Inspect domain auth logs in sandbox";
  if (capability === "fix.restart_app") return "Restart the application";
  if (capability === "fix.clear_app_cache") return "Clear application cache";
  if (capability === "fix.toggle_wifi") return "Toggle Wi-Fi";
  return "Run sandboxed action";
}

function jobKindForCapability(capability?: string): AgentJob["kind"] {
  if (capability === "diag.network_probe") return "network_probe";
  if (capability === "sandbox.read_auth_logs" || capability === "sandbox.read_kerberos_logs") {
    return "collect_logs";
  }
  return "app_diagnostic";
}

function sanitizeAppName(s: unknown): string {
  return String(s ?? "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64);
}

function commandForCapability(
  capability: string | undefined,
  email: string,
  params: Record<string, unknown> | undefined,
): string {
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
  if (capability === "fix.restart_app") {
    const app = sanitizeAppName(params?.app);
    return `restart_app --app "${app}"`;
  }
  if (capability === "fix.clear_app_cache") {
    const app = sanitizeAppName(params?.app);
    return `clear_app_cache --app "${app}"`;
  }
  if (capability === "fix.toggle_wifi") {
    return `toggle_wifi`;
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
