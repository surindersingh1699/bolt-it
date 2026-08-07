import { randomBytes } from "crypto";
import { insertAgentJob, updateStep } from "./data";
import { buildCommand, capabilitySpec, humanLabelFor } from "./capabilities";
import { AgentJob, PlanStep, Ticket } from "./types";

export type EnqueueResult =
  | { ok: true; job: AgentJob }
  | { ok: false; reason: string };

function buildJob(
  ticket: Ticket,
  capability: string | undefined,
  command: string,
  instructions: string,
  stepId?: string,
): AgentJob {
  const now = Date.now();
  return {
    id: `job-${randomBytes(6).toString("hex")}`,
    workspaceId: ticket.workspaceId,
    ticketId: ticket.id,
    ...(stepId ? { stepId } : {}),
    kind: jobKindForCapability(capability),
    targetUserEmail: ticket.reporterEmail,
    instructions,
    allowlistedCommand: command,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A read-only probe run for observation rather than for a plan step.
 *
 * Carries no `stepId`, because there is no step: it runs before anything is
 * planned. That absence is load-bearing — `buildReplyEvidence` matches jobs to
 * steps by `stepId`, so an observation job never masquerades as proof that a
 * planned action was carried out.
 */
export async function enqueueProbeJob(
  ticket: Ticket,
  capability: string,
  params?: Record<string, unknown>,
): Promise<EnqueueResult> {
  const built = buildCommand(capability, params);
  if (!built.ok) return { ok: false, reason: built.reason };

  // The observation bundle must stay read-only: it runs on the START edge with
  // no reviewer and no gate, so a mutating capability reaching it would execute
  // completely unsupervised. observe.ts only ever asks for `diag.*`, and this is
  // the second lock on that door.
  const spec = capabilitySpec(capability);
  if (spec && spec.risk !== 0) {
    return { ok: false, reason: `${capability} changes state and cannot run as an observation probe` };
  }

  const job = buildJob(
    ticket,
    capability,
    built.command,
    [
      `Ticket ${ticket.id}: ${ticket.subject}`,
      `Reporter: ${ticket.reporter} <${ticket.reporterEmail}>`,
      `Read-only observation: ${humanLabelFor(capability)}`,
      "Run only the allowlisted command in the local sandbox. Change nothing.",
      "Redact secrets, tokens, cookies, IPs if policy requires it.",
    ].join("\n"),
  );
  await insertAgentJob(job);
  return { ok: true, job };
}

export async function enqueueAgentJob(ticket: Ticket, step: PlanStep): Promise<EnqueueResult> {
  const built = buildCommand(step.capability, step.params);
  if (!built.ok) {
    await updateStep(ticket.id, step.id, {
      log: [`[Agent Queue] Refused before dispatch: ${built.reason}`],
    });
    return { ok: false, reason: built.reason };
  }

  const job = buildJob(
    ticket,
    step.capability,
    built.command,
    instructionsForCapability(ticket, step),
    step.id,
  );
  await insertAgentJob(job);
  await updateStep(ticket.id, step.id, {
    log: [
      `[Agent Queue] Plan step: ${humanLabelFor(step.capability)}`,
      `[Agent Queue] Routing to the local agent on the user's machine`,
      `[Agent Queue] Sandboxed command (audit): ${job.allowlistedCommand}`,
    ],
  });
  return { ok: true, job };
}

export { humanLabelFor };

function jobKindForCapability(capability?: string): AgentJob["kind"] {
  if (capability === "diag.system_info") return "system_info";
  if (capability === "diag.network_state") return "network_probe";
  return "app_diagnostic";
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
