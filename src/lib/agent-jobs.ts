import { randomBytes } from "crypto";
import { insertAgentJob, updateStep } from "./data";
import { AgentJob, PlanStep, Ticket } from "./types";

export function isAgentJobCapability(capability?: string): boolean {
  return (
    capability === "diag.system_info" ||
    capability === "diag.app_status" ||
    capability === "diag.app_logs" ||
    capability === "fix.restart_app" ||
    capability === "fix.clear_app_cache" ||
    capability === "fix.toggle_wifi" ||
    capability === "diag.process_list" ||
    capability === "diag.network_state" ||
    capability === "diag.command_output"
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
      `[Agent Queue] Routing to the local agent on the user's machine`,
      `[Agent Queue] Sandboxed command (audit): ${job.allowlistedCommand}`,
    ],
  });
  return job;
}

export function humanLabelFor(capability: string | undefined): string {
  if (capability === "diag.system_info") return "Collect device hardware and OS info";
  if (capability === "diag.app_status") return "Check whether the app is running";
  if (capability === "diag.app_logs") return "Read the app's recent error events";
  if (capability === "fix.restart_app") return "Restart the application";
  if (capability === "fix.clear_app_cache") return "Clear application cache";
  if (capability === "fix.toggle_wifi") return "Cycle the network adapter";
  if (capability === "diag.process_list") return "List what's running on the machine";
  if (capability === "diag.network_state") return "Read interfaces, routes and DNS";
  if (capability === "diag.command_output") return "Read device state with a read-only command";
  return "Run device action";
}

function jobKindForCapability(capability?: string): AgentJob["kind"] {
  if (capability === "diag.system_info") return "system_info";
  if (capability === "diag.network_state") return "network_probe";
  return "app_diagnostic";
}

function sanitizeAppName(s: unknown): string {
  return String(s ?? "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64);
}

function sanitizeBinary(s: unknown): string {
  return String(s ?? "").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 32);
}

// Arguments are kept to single whitespace-free tokens so the audit string in the
// job record is exactly the argv that will run. The agent re-validates all of
// this against its own allowlist before executing — this is the outbound half.
function sanitizeArgv(s: unknown): string {
  return String(s ?? "")
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && tok.length <= 256 && /^[A-Za-z0-9._\-/:@=+,%[\]]+$/.test(tok))
    .slice(0, 12)
    .join(" ");
}

function commandForCapability(
  capability: string | undefined,
  email: string,
  params: Record<string, unknown> | undefined,
): string {
  const user = email.replace(/[^a-zA-Z0-9@._-]/g, "");
  const app = sanitizeAppName(params?.app);
  if (capability === "diag.system_info") return `collect_system_info --user ${user}`;
  if (capability === "diag.app_status") return `app_status --app "${app}"`;
  if (capability === "diag.app_logs") return `app_event_logs --app "${app}" --limit 15`;
  if (capability === "fix.restart_app") return `restart_app --app "${app}"`;
  if (capability === "fix.clear_app_cache") return `clear_app_cache --app "${app}"`;
  if (capability === "diag.process_list") return "process_list";
  if (capability === "diag.network_state") return "network_state";
  if (capability === "diag.command_output") {
    const args = sanitizeArgv(
      Array.isArray(params?.args) ? (params.args as unknown[]).join(" ") : params?.args,
    );
    return `command_output --binary "${sanitizeBinary(params?.binary)}" --args "${args}"`;
  }
  return "toggle_wifi";
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
