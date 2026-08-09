import clsx from "clsx";
import { AgentJob, AgentJobStatus, DeviceProbe, ExecutionEnvelope, PlanStep } from "@/lib/types";

/**
 * The device's own record of a job, rendered so someone can check it rather than
 * believe it.
 *
 * Everything here was already being captured and persisted — probes with the
 * exact command that read them, every argv with its exit code and stdout, the
 * field-level before/after diff, the paths of the append-only journal and the
 * change record on the machine, and the undo command. None of it had ever been
 * rendered anywhere: `PlanStep.log` reached the browser on every poll and no
 * component read it.
 *
 * The point of the panel is the probe COMMAND next to the facts it produced. A
 * summary a viewer cannot check is a claim; a command they can paste into a
 * terminal on the same machine is evidence.
 *
 * No hooks and no client-only APIs, so this renders both inside the staff
 * ticket (a client component) and on the server-rendered audit page.
 */

const VERDICT: Record<AgentJobStatus, { label: string; className: string }> = {
  succeeded: { label: "CHANGED", className: "bg-emerald-50 text-emerald-700" },
  no_effect: { label: "NO EFFECT", className: "bg-amber-50 text-amber-800" },
  failed: { label: "FAILED", className: "bg-rose-50 text-rose-700" },
  simulated: { label: "DRY RUN", className: "bg-neutral-100 text-neutral-600" },
  queued: { label: "QUEUED", className: "bg-neutral-100 text-neutral-600" },
  claimed: { label: "RUNNING", className: "bg-blue-50 text-blue-700" },
};

/** A read-only job that succeeded says "read", not "changed" — it changed nothing. */
function verdictFor(job: AgentJob) {
  if (job.status === "succeeded" && job.envelope && !job.envelope.expectsChange) {
    return { label: "READ", className: "bg-blue-50 text-blue-700" };
  }
  return VERDICT[job.status];
}

/**
 * `probeCacheDir` measures the directory with node's own `fs` rather than
 * shelling out, so its `command` is a description of a reading and not something
 * to paste. Saying which one this is beats letting a synthetic string sit under
 * a "run this yourself" heading.
 */
const NON_SHELL_PROBE = /^node:fs\s/;

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-neutral-500">
      {children}
    </div>
  );
}

function Facts({ facts }: { facts: DeviceProbe["facts"] }) {
  const entries = Object.entries(facts);
  if (entries.length === 0) return <span className="text-neutral-400">no facts captured</span>;
  return (
    <span className="text-neutral-700">
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && <span className="text-neutral-300"> · </span>}
          {k}=<span className="text-neutral-900">{String(v ?? "null")}</span>
        </span>
      ))}
    </span>
  );
}

function Probes({ probes }: { probes: DeviceProbe[] }) {
  if (probes.length === 0) return null;
  return (
    <div>
      <Label>Reads taken on the machine</Label>
      <div className="space-y-2">
        {probes.map((p, i) => (
          <div key={`${p.label}-${i}`} className="rounded-md bg-neutral-50 px-3 py-2">
            <div className="font-mono text-[11.5px]">
              <span className="text-neutral-500">{p.label}</span>
              <span className="text-neutral-300"> — </span>
              <Facts facts={p.facts} />
            </div>
            {NON_SHELL_PROBE.test(p.command) ? (
              <div className="mt-1 text-[11px] text-neutral-500">
                Measured by the agent&apos;s own filesystem calls ({p.command}) — nothing to re-run.
              </div>
            ) : (
              <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[11px]">
                <span className="text-neutral-500">read by</span>
                <code className="select-all break-all rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-neutral-800 ring-1 ring-neutral-200">
                  {p.command}
                </code>
                <span className="text-neutral-400">exit {p.exitCode}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Effect({ envelope }: { envelope: ExecutionEnvelope }) {
  const { diff, changed, summary } = envelope.effect;
  if (!envelope.expectsChange) {
    return (
      <div className="text-[12px] text-neutral-600">
        Read-only step — no device state was expected to change.
      </div>
    );
  }
  return (
    <div>
      <Label>What moved between the two reads</Label>
      {diff.length === 0 ? (
        <div className="text-[12px] text-amber-800">
          Nothing. The before and after reads are identical, so this is not a fix however clean the
          exit codes were.
        </div>
      ) : (
        <div className="space-y-1">
          {diff.map((d) => (
            <div key={d.field} className="font-mono text-[11.5px]">
              <span className="text-neutral-500">{d.field}</span>{" "}
              <span className="text-neutral-400">{String(d.before ?? "unset")}</span>
              <span className="text-neutral-300"> → </span>
              <span className="text-neutral-900">{String(d.after ?? "unset")}</span>
            </div>
          ))}
        </div>
      )}
      {changed && summary && <div className="mt-1.5 text-[12px] text-emerald-700">{summary}</div>}
    </div>
  );
}

function Commands({ envelope }: { envelope: ExecutionEnvelope }) {
  if (envelope.commands.length === 0) return null;
  return (
    <div>
      <Label>Every command that ran, in order</Label>
      <div className="space-y-2">
        {envelope.commands.map((c, i) => (
          <div key={i} className="rounded-md ring-1 ring-neutral-200">
            <div className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5">
              <code className="select-all break-all font-mono text-[11.5px] text-neutral-800">
                {c.argv.join(" ")}
              </code>
              <span
                className={clsx(
                  "font-mono text-[10.5px]",
                  c.exitCode === 0 ? "text-neutral-400" : "text-rose-600",
                )}
              >
                exit {c.exitCode} · {c.durationMs}ms
              </span>
            </div>
            {(c.stdout.trim() || c.stderr.trim()) && (
              <pre className="max-h-56 overflow-auto border-t border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-[11px] leading-5 text-neutral-600">
                {c.stdout.trim()}
                {c.stderr.trim() && (
                  <span className="text-rose-600">
                    {c.stdout.trim() ? "\n" : ""}
                    {c.stderr.trim()}
                  </span>
                )}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function OnTheMachine({ envelope }: { envelope: ExecutionEnvelope }) {
  const rows: [string, string][] = [];
  if (envelope.journalPath) rows.push(["Append-only journal", envelope.journalPath]);
  if (envelope.changeRecordPath) rows.push(["Change record", envelope.changeRecordPath]);
  if (envelope.revertCommand) rows.push(["Undo this with", envelope.revertCommand]);
  if (rows.length === 0) return null;
  return (
    <div>
      <Label>Written on {envelope.host} itself</Label>
      <div className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-baseline gap-x-2 text-[11.5px]">
            <span className="text-neutral-500">{k}</span>
            <code className="select-all break-all font-mono text-[11px] text-neutral-800">{v}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function Rollback({ envelope }: { envelope: ExecutionEnvelope }) {
  if (!envelope.rolledBack) return null;
  const failed = envelope.rollbackOk === false;
  return (
    <div
      className={clsx(
        "rounded-md px-3 py-2 text-[12px] leading-6",
        failed ? "bg-rose-50 text-rose-900" : "bg-neutral-100 text-neutral-700",
      )}
    >
      {failed ? (
        <>
          <span className="font-medium">Rollback failed.</span> The change did not take and the undo
          did not either, so {envelope.host} is in a state neither the plan nor the undo accounted
          for: {envelope.rollbackError || "no detail reported"}
        </>
      ) : (
        <>
          The change did not take, so the agent put {envelope.host} back the way it found it.
        </>
      )}
    </div>
  );
}

function JobEvidence({ job, step }: { job: AgentJob; step?: PlanStep }) {
  const env = job.envelope;
  const verdict = verdictFor(job);

  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={clsx("rounded px-1.5 py-0.5 text-[10.5px] font-semibold", verdict.className)}>
          {verdict.label}
        </span>
        <code className="break-all font-mono text-[12px] text-neutral-800">
          {job.allowlistedCommand}
        </code>
      </div>
      {step && <div className="mt-1.5 text-[12.5px] text-neutral-600">{step.description}</div>}

      {env ? (
        <>
          <div className="mt-2 font-mono text-[11px] text-neutral-400">
            {env.host} · {env.os} · {env.agentVersion} · {env.durationMs}ms
          </div>
          {env.simulated && (
            <div className="mt-3 rounded-md bg-neutral-100 px-3 py-2 text-[12px] text-neutral-700">
              Dry run. Nothing was sent to {env.host} — the command above was computed and discarded,
              so nothing here is evidence that anything was fixed.
            </div>
          )}
          <div className="mt-4 space-y-4">
            <Probes probes={env.probes} />
            <Effect envelope={env} />
            <Commands envelope={env} />
            <Rollback envelope={env} />
            <OnTheMachine envelope={env} />
          </div>
        </>
      ) : (
        <div className="mt-3 text-[12px] text-neutral-500">
          No execution envelope came back — this device agent is older than the proof protocol, so
          there is nothing here to check.
        </div>
      )}

      {job.error && (
        <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 font-mono text-[11.5px] text-rose-700">
          {job.error}
        </div>
      )}
    </div>
  );
}

/**
 * The caveats, stated rather than hidden. Someone who compares the panel against
 * the machine WILL hit both of these, and finding them unannounced looks like the
 * system is covering something up.
 */
export function EvidenceCaveats() {
  return (
    <div className="space-y-2 text-[11.5px] leading-6 text-neutral-500">
      <p>
        Output is redacted twice — once by the agent before it leaves the machine, once again by the
        server after parsing — so a credential cannot reach this page even from a modified agent. The
        product-key pattern is deliberately blunt and will blank harmless hyphenated serials;{" "}
        <span className="font-mono">[REDACTED:…]</span> here is the filter working, not a command
        that failed.
      </p>
      <p>
        The journal on the machine is written from the un-redacted envelope, so it holds more than
        this page does. Comparing the two and finding extra content on the device is expected.
      </p>
    </div>
  );
}

export function Evidence({
  jobs,
  plan,
  /**
   * Why the evidence could not be read, when it could not be. Distinct from an
   * empty list on purpose: "nothing ran" and "I could not look" are opposite
   * claims, and rendering the first when the second is true is the one failure
   * an audit panel cannot be allowed to have.
   */
  error,
}: {
  jobs: AgentJob[];
  plan?: PlanStep[];
  error?: string;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-[12px] leading-6 text-amber-900">
        {error}
      </div>
    );
  }
  if (jobs.length === 0) {
    return (
      <div className="text-[12px] text-neutral-500">
        Nothing has run on a device for this ticket yet.
      </div>
    );
  }
  const stepById = new Map((plan ?? []).map((s) => [s.id, s]));
  return (
    <div className="space-y-3">
      {jobs.map((j) => (
        <JobEvidence key={j.id} job={j} step={j.stepId ? stepById.get(j.stepId) : undefined} />
      ))}
      <EvidenceCaveats />
    </div>
  );
}
