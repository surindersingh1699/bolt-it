import { AgentJob, AgentJobStatus, ExecutionEnvelope } from "./types";

/**
 * The honesty gate.
 *
 * A device job is only "succeeded" when the machine's own before/after probes
 * disagree — i.e. something on the client actually moved. A fix that ran
 * cleanly but left the device identical is `no_effect`, and may never be
 * reported to the user as a completed fix.
 */
export function deriveJobStatus(
  ok: boolean,
  envelope: ExecutionEnvelope | undefined,
): AgentJobStatus {
  if (!ok) return "failed";
  if (!envelope) return "succeeded";
  // Before the no_effect rule, and that ordering is the whole point: a simulated
  // write never touched the machine, so `expectsChange && !changed` is true of
  // every one of them. Checked second, a simulation run would report as
  // universal failure and stop being useful for the thing it exists to do.
  if (envelope.simulated) return "simulated";
  if (envelope.expectsChange && !envelope.effect.changed) return "no_effect";
  return "succeeded";
}

/**
 * True when a job's result may be described to the user as work that happened.
 *
 * `simulated` is excluded for the same reason `no_effect` is: nothing happened
 * on the machine. It must never support a `resolved: true` claim.
 */
export function isRealSuccess(status: AgentJobStatus): boolean {
  return status === "succeeded";
}

function factLine(facts: Record<string, string | number | boolean | null>): string {
  const entries = Object.entries(facts);
  if (entries.length === 0) return "(no facts captured)";
  return entries.map(([k, v]) => `${k}=${v ?? "null"}`).join(" · ");
}

/**
 * Renders the envelope as the audit block that lands on the ticket step — the
 * "proof panel" in text form. Same formatter is used by the job-completion
 * route and by the graph so the ticket log and the job record never disagree.
 */
export function formatProofLines(job: AgentJob): string[] {
  const env = job.envelope;
  const lines: string[] = [];

  // First line, unmissable. A simulated run and a real one otherwise produce the
  // same shape of proof block, and confusing the two is the worst thing this
  // formatter could do.
  if (env?.simulated) {
    lines.push(
      `[DRY RUN] Nothing was sent to ${env.host}. The command below was computed and discarded.`,
    );
  }

  if (env) {
    lines.push(`[Local Agent] Ran on ${env.host} (${env.os}) · ${env.agentVersion} · ${env.durationMs}ms`);
  }
  lines.push(`[Local Agent] Command: ${job.allowlistedCommand}`);

  if (!env) {
    lines.push(`[Proof] No execution envelope returned — device agent is older than the proof protocol.`);
    if (job.output) lines.push(...job.output.split(/\r?\n/).slice(0, 12).map((l) => `[Local Agent] ${l}`));
    if (job.error) lines.push(`[Local Agent] Error: ${job.error}`);
    return lines;
  }

  for (const probe of env.probes) {
    lines.push(`[Proof] ${probe.label}: ${factLine(probe.facts)}`);
  }
  for (const cmd of env.commands) {
    const stderr = cmd.stderr.trim().split(/\r?\n/)[0];
    lines.push(
      `[Proof] exec exit=${cmd.exitCode} (${cmd.durationMs}ms): ${cmd.argv.join(" ").slice(0, 180)}` +
        (cmd.exitCode !== 0 && stderr ? ` — ${stderr.slice(0, 160)}` : ""),
    );
  }

  for (const stepId of env.simulatedDependencyUnmet ?? []) {
    lines.push(
      `[Proof] simulated_dependency_unmet: this step's pre-probe expected state that an earlier ` +
        `simulated write (${stepId}) never produced. Expected on a dry run — not a defect in the plan.`,
    );
  }

  if (env.simulated) {
    lines.push(
      `[Proof] SIMULATED — the machine was not touched, so nothing here is evidence that anything was fixed.`,
    );
  } else if (env.effect.changed) {
    lines.push(`[Proof] EFFECT: ${env.effect.summary}`);
  } else if (env.expectsChange) {
    lines.push(
      `[Proof] NO EFFECT — before and after probes are identical, so nothing on ${env.host} changed. ` +
        `Not reporting this as fixed.`,
    );
  } else {
    lines.push(`[Proof] Read-only step — no device state was expected to change.`);
  }

  if (env.journalPath) {
    lines.push(`[Proof] Device journal: ${env.journalPath} (append-only, on the machine itself)`);
  }
  if (env.changeRecordPath) {
    lines.push(`[Proof] Change record: ${env.changeRecordPath} (on the machine, with the undo command)`);
  }
  if (env.revertCommand) {
    lines.push(`[Proof] Reversible by: ${env.revertCommand}`);
  }
  if (job.error) lines.push(`[Local Agent] Error: ${job.error}`);
  return lines;
}

/** One-line effect statement handed to the LLM verifier and reply writer. */
export function effectSummaryFor(status: AgentJobStatus, envelope?: ExecutionEnvelope): string {
  if (status === "simulated") {
    return "SIMULATED — computed on a dry-run rung and never sent to the machine; nothing changed and nothing was verified.";
  }
  if (status === "no_effect") {
    return "NO EFFECT — commands ran but the device's before/after state is identical; nothing changed.";
  }
  if (status === "failed") {
    return "FAILED — the command did not complete on the device.";
  }
  if (!envelope) return "Completed (no proof envelope).";
  if (!envelope.expectsChange) return `Read-only: ${envelope.effect.summary}`;
  return `VERIFIED CHANGE — ${envelope.effect.summary}`;
}
