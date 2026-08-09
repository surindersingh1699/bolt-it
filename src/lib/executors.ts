/**
 * How a step actually runs — one executor per `ActionKind`, in a registry.
 *
 * The graph decides WHAT to do and in what order. This decides HOW. They used
 * to be the same four-branch `if/else` inside the graph's execute node, which
 * meant a new execution surface (SSH, Intune, SCCM, a REST endpoint) could not
 * be added without editing the orchestration engine and re-reasoning about the
 * approval gate on the way past.
 *
 * Adding a surface is now: write an executor, register it here. The planner,
 * the reviewer and the interrupt gate are untouched by it.
 *
 * Two rules every executor keeps, both load-bearing:
 *
 *  - **Never throw.** Return `{ ok: false, log, failure }`. A failed step
 *    escalates the ticket; it must not crash the graph (CLAUDE.md rule 4). The
 *    dispatcher catches anyway, but an executor that relies on that is a bug.
 *  - **Always name the failure.** Every non-ok result carries a
 *    `StepFailureKind`. A bare "failed" sends a technician to the wrong place.
 */

import { ActionKind, PlanStep, StepFailure, Ticket } from "./types";
import { directoryInvoke } from "./integrations/directory";
import { communicate } from "./integrations/ai-gateway";
import { enqueueAgentJob } from "./agent-jobs";
import { buildCommand, capabilitySpec } from "./capabilities";
import { autonomyNote, isDryRun } from "./autonomy";
import { formatProofLines, isRealSuccess } from "./evidence";
import { getTicket, listAgentJobs } from "./data";
import { readHeartbeat } from "./agent-heartbeat";
import { buildReplyEvidence, firstNameOf, postUpdate, waitForAgentJobs, waitForJob } from "./ticket-helpers";

/** How long a step waits for the user's machine before the work counts as not done. */
export const AGENT_JOB_TIMEOUT_MS = 45_000;

export interface StepResult {
  ok: boolean;
  log: string[];
  /** Required whenever `ok` is false. */
  failure?: StepFailure;
  /**
   * The step was computed but never sent to the machine. `ok` is true — nothing
   * went wrong — but the step must be recorded as `simulated`, not `succeeded`,
   * or a dry run could close a ticket on work that never happened.
   */
  simulated?: boolean;
}

export type StepExecutor = (ticket: Ticket, step: PlanStep) => Promise<StepResult>;

/** Directory / account actions against our own store. */
const executeBackend: StepExecutor = async (ticket, step) => {
  const r = await directoryInvoke(step, ticket.reporterEmail);
  return {
    ok: r.ok,
    log: r.log,
    failure: r.ok
      ? undefined
      : { kind: "execution", detail: `directory action ${step.capability ?? step.kind} returned not-ok` },
  };
};

/**
 * Can the machine on the other end even do this?
 *
 * The capability registry describes what this SYSTEM can do. The agent's
 * published surface describes what THAT BUILD implements. They are not the same
 * thing the moment a device is running anything but the current bundle, and the
 * gap is expensive: the step is dispatched, the device answers with prose the
 * graph cannot categorise (`Command is not allowlisted`), the operator retries
 * it, and a look is spent theorising about an allowlist that is fine.
 *
 * Three answers, and the difference between them is what the graph does next:
 *
 *  - handler missing  → this build cannot do it at all. Not grantable; a grant
 *    would retry the identical step and fail identically. It routes to the
 *    strategist, which asks for a different observation or requests the
 *    capability outright.
 *  - binary grantable → a decision is missing, not a capability. Marked as such
 *    so `decideGrant` can auto-grant it at AUTONOMY=full.
 *  - binary unknown   → not a read this agent will ever run. Same as the first.
 *
 * A device that reports no surface (a build too old to describe itself) is not
 * second-guessed: the step is dispatched and the agent's own answer stands.
 */
export function unsupportedByDevice(step: PlanStep): StepFailure | null {
  const surface = readHeartbeat()?.surface;
  if (!surface) return null;

  const built = buildCommand(step.capability, step.params);
  if (!built.ok) return null; // enqueueAgentJob reports this better than we can.

  const handler = built.command.split(/\s+/)[0] ?? "";
  if (!surface.handlers.includes(handler)) {
    return {
      kind: "capability_missing",
      detail:
        `the agent on this machine has no "${handler}" handler — it is running an older build, ` +
        `so this read cannot run there however it is phrased`,
    };
  }

  const binary = typeof step.params?.binary === "string" ? step.params.binary : null;
  if (!binary) return null;
  if (surface.binaries.default.includes(binary)) return null;

  if (surface.binaries.grantable.includes(binary)) {
    return {
      kind: "capability_missing",
      detail: `the read-only diagnostic ${binary} is not enabled by default and needs approval for this ticket`,
      grantableBinary: binary,
    };
  }

  return {
    kind: "capability_missing",
    detail:
      `"${binary}" is not on this machine's read-only binary list and no approval can add it — ` +
      `answer the same question with a different read, or request the capability`,
  };
}

/**
 * Work on the employee's machine, decided BY the machine. No parallel narration
 * from the cloud: the before/after probe diff is the verdict, and a job that
 * changed nothing fails the step however clean its exit code was.
 */
const executeDevice: StepExecutor = async (ticket, step) => {
  const log: string[] = [];

  // Dry-run rungs: reads still run — a simulation with no readings tells you
  // nothing about whether the plan was reasonable — but a write is computed,
  // recorded, and dropped. The command is built through the same registry path
  // as a real one, so what the artifact shows is exactly what would have run.
  const spec = capabilitySpec(step.capability);
  if (isDryRun() && spec && spec.risk >= 1) {
    const built = buildCommand(step.capability, step.params);
    if (!built.ok) {
      log.push(`[Dry Run] Nothing computed — ${built.reason}`);
      return { ok: false, log, failure: { kind: "capability_missing", detail: built.reason } };
    }
    log.push(
      `[Dry Run] ${autonomyNote()}`,
      `[Dry Run] Would run on ${ticket.reporterEmail}'s machine: ${built.command}`,
      `[Dry Run] Risk ${spec.risk} · reversible=${spec.reversible} · rollback=${spec.rollback ?? "none"}`,
      `[Dry Run] Nothing was sent. This step is recorded as simulated, not succeeded.`,
    );
    return { ok: true, log, simulated: true };
  }

  // What the machine on the other end says it implements. Checking here costs
  // one in-memory read and saves a round trip, a 30s timeout, and — because the
  // device's own refusal is prose — a strategist look spent theorising about it.
  const unsupported = unsupportedByDevice(step);
  if (unsupported) {
    log.push(`[Agent Queue] Nothing dispatched — ${unsupported.detail}`);
    return { ok: false, log, failure: unsupported };
  }

  const queued = await enqueueAgentJob(ticket, step);

  // Nothing was dispatched: either the capability has no device command or the
  // params did not parse. The old code had no way to express this — it coerced
  // bad params and fell through to `toggle_wifi` for an unknown capability, so
  // "we could not build this command" ran as "cycle the employee's adapter".
  if (!queued.ok) {
    log.push(`[Agent Queue] Nothing dispatched — ${queued.reason}`);
    return {
      ok: false,
      log,
      failure: { kind: "capability_missing", detail: queued.reason },
    };
  }

  const job = queued.job;
  log.push(`[Agent Queue] Job ${job.id} dispatched to the device agent`);
  log.push(`[Agent Queue] ${job.allowlistedCommand}`);

  const finished = await waitForJob(job.id, AGENT_JOB_TIMEOUT_MS);

  if (!finished) {
    log.push(
      `[Local Agent] No result within ${AGENT_JOB_TIMEOUT_MS / 1000}s — the device agent is offline or busy. ` +
        `Nothing was done on the user's machine.`,
    );
    return {
      ok: false,
      log,
      failure: {
        kind: "timeout",
        detail: `device agent did not report within ${AGENT_JOB_TIMEOUT_MS / 1000}s; nothing ran on ${ticket.reporterEmail}'s machine`,
      },
    };
  }

  const proof = [...log, ...formatProofLines(finished)];
  const ok = isRealSuccess(finished.status);

  if (finished.status === "no_effect") {
    proof.push(`[Local Agent] Step marked failed: the fix ran but the device did not change.`);
    return {
      ok: false,
      log: proof,
      failure: {
        kind: "no_effect",
        detail: `commands ran on ${finished.envelope?.host ?? "the device"} and the before/after probes are identical`,
      },
    };
  }

  if (!ok) {
    // A binary the agent would run if a person said so is a different problem
    // from one that errored: the first is answered by a decision, the second by
    // a different approach. Classifying both as `execution` is what let the
    // strategist re-authorise the same refused check three rounds running.
    const grantable = grantableBinaryFrom(finished.error);
    if (grantable) {
      return {
        ok: false,
        log: [...proof, `[Local Agent] ${grantable} needs a technician's approval before it can run`],
        failure: {
          kind: "capability_missing",
          detail: `the read-only diagnostic ${grantable} is not enabled by default and needs a technician to approve it for this ticket`,
          grantableBinary: grantable,
        },
      };
    }
    return {
      ok: false,
      log: proof,
      failure: {
        kind: "execution",
        detail: finished.error || "the command did not complete on the device",
      },
    };
  }

  return { ok: true, log: proof };
};

/**
 * The agent marks a refusal it would accept a grant for as
 * `GRANTABLE:<binary>:<message>`. Anything else is a refusal no approval fixes.
 */
export function grantableBinaryFrom(error: string | undefined): string | null {
  const m = /^GRANTABLE:([A-Za-z0-9_.-]{1,32}):/.exec(error ?? "");
  return m ? m[1] : null;
}

/**
 * The message the employee sees. Waits for outstanding device jobs first so the
 * reply is composed from what actually happened rather than from the plan.
 */
const executeReply: StepExecutor = async (ticket, step) => {
  const log = [`[Reply] Waiting for any pending device jobs before composing reply`];
  await waitForAgentJobs(ticket.id, 20_000);

  const fresh = await getTicket(ticket.id);
  const stepsBeforeReply = (fresh?.plan ?? []).filter((s) => s.id !== step.id);
  const allJobs = await listAgentJobs(ticket.workspaceId);
  const jobsForTicket = allJobs.filter((j) => j.ticketId === ticket.id);

  const evidence = buildReplyEvidence(stepsBeforeReply, jobsForTicket);
  log.push(`[Reply] Composing the desk's resolution message from ${evidence.length} executed step(s)`);

  const firstName = firstNameOf(ticket.reporter);
  const synthesized = await communicate({
    ticketId: ticket.id,
    moment: "resolution",
    reporterFirstName: firstName,
    subject: ticket.subject,
    body: ticket.body,
    agentSummary: ticket.draftResponse,
    evidence,
  }).catch(() => null);

  const replyText =
    synthesized ?? ticket.draftResponse ?? `Hi ${firstName} — your IT ticket ${ticket.id} has been updated.`;
  log.push(
    synthesized
      ? `[Reply] Composed from real step results`
      : `[Reply] Desk unavailable — falling back to the engineer's own summary`,
  );
  await postUpdate(ticket, replyText);

  // A reply cannot fail in a way the employee should be escalated over: the
  // text went out, worst case from the earlier draft rather than fresh evidence.
  return { ok: true, log };
};

export const EXECUTORS: Record<ActionKind, StepExecutor> = {
  backend: executeBackend,
  device: executeDevice,
  reply: executeReply,
};
