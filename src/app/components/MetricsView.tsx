"use client";

/**
 * Operational read on the agent itself, rather than on any one ticket.
 *
 * Everything here is computed from what the tickets already carry — the failure
 * taxonomy, how many diagnostic looks each took, and the per-ticket cost ledger. There
 * is no separate metrics pipeline to fall out of sync, and nothing is estimated:
 * a number that cannot be derived from a real ticket is not shown at all.
 *
 * The deliberate omission is currency. Token counts are exact because the
 * gateway reports them; prices move and differ per account, so a hard-coded
 * rate table would quietly go wrong and be believed. Tokens are the honest unit.
 */

import { useMemo } from "react";
import { AlertTriangle, Coins, Layers, TrendingUp } from "lucide-react";
import { PublicUser, StepFailureKind } from "@/lib/types";
import { useAppState } from "./StateProvider";
import { summarizeAgentMetrics } from "./ticket-view";

const FAILURE_LABEL: Record<StepFailureKind, string> = {
  execution: "Command failed",
  timeout: "Device agent never answered",
  no_effect: "Ran, machine unchanged",
  policy_block: "Refused — did not follow from the ticket",
  unsupported_assumption: "Refused — diagnosis not established",
  capability_missing: "No capability for the fix",
  dependency_unavailable: "A provider was down",
  conflicting_evidence: "Evidence pointed two ways",
};

export function MetricsView({ currentUser }: { currentUser: PublicUser }) {
  const { tickets } = useAppState();
  const m = useMemo(() => summarizeAgentMetrics(tickets), [tickets]);

  if (tickets.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-10 text-[13.5px] text-neutral-500">
        No tickets yet, so there is nothing to measure.
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto p-6">
      <h1 className="text-[19px] text-neutral-900">How the agent is doing</h1>
      <p className="mt-1 text-[13px] text-neutral-500">
        Across {m.total} ticket{m.total === 1 ? "" : "s"} in {currentUser.team === "" ? "this workspace" : "this workspace"}.
        Every figure is counted from real tickets — nothing here is estimated.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          icon={<TrendingUp size={14} />}
          label="Finished without a person"
          value={pct(m.autonomous, m.total)}
          sub={`${m.autonomous} of ${m.total}`}
        />
        <Stat
          icon={<AlertTriangle size={14} />}
          label="Needed a human"
          value={pct(m.escalated, m.total)}
          sub={`${m.escalated} handed over`}
        />
        <Stat
          icon={<Layers size={14} />}
          label="Needed a second look"
          value={pct(m.multiLook, m.total)}
          sub="one pass was not enough"
        />
        <Stat
          icon={<Coins size={14} />}
          label="Tokens per ticket"
          value={m.ticketsWithUsage > 0 ? Math.round(m.tokens / m.ticketsWithUsage).toLocaleString() : "—"}
          sub={m.ticketsWithUsage > 0 ? `${m.tokens.toLocaleString()} total` : "no calls recorded yet"}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Panel
          title="How many looks a ticket took"
          hint="A look is one call to the expensive model. The operator's rounds are not counted here — those are cheap by design. This distribution is the whole cost story."
        >
          {([1, 2, 3, 4] as const).map((n) => (
            <Bar
              key={n}
              label={n === 1 ? "One look was enough" : n === 4 ? "4 or more looks" : `${n} looks`}
              value={m.byLooks[n] ?? 0}
              total={m.total}
              tone={n >= 3 ? "amber" : "blue"}
            />
          ))}
        </Panel>

        <Panel
          title="Why steps failed"
          hint="A bare “failed” sends a technician to the wrong place. A timeout is an offline agent; “ran, machine unchanged” is a fix that silently did nothing."
        >
          {m.failures.length === 0 ? (
            <p className="text-[13px] text-neutral-500">No step has failed yet.</p>
          ) : (
            m.failures.map(([kind, n]) => (
              <Bar
                key={kind}
                label={FAILURE_LABEL[kind] ?? kind}
                value={n}
                total={m.failureTotal}
                tone={kind === "no_effect" || kind === "unsupported_assumption" ? "rose" : "neutral"}
              />
            ))
          )}
        </Panel>

        <Panel
          title="What the tokens went on"
          hint="Counted from the gateway's own usage block, including the calls that failed — those are the ones most worth spotting."
        >
          {m.byCall.length === 0 ? (
            <p className="text-[13px] text-neutral-500">No model calls recorded in this process yet.</p>
          ) : (
            m.byCall.map(([call, tokens]) => (
              <Bar key={call} label={call} value={tokens} total={m.tokens} tone="blue" unit="tokens" />
            ))
          )}
        </Panel>

        <Panel
          title="Approvals"
          hint="How often the safety gate actually stopped something, and how often it refused a step outright."
        >
          <Bar label="Waiting on a person now" value={m.awaitingApproval} total={m.total} tone="amber" />
          <Bar label="Steps refused before running" value={m.refused} total={Math.max(m.steps, 1)} tone="rose" />
          <p className="mt-3 text-[12px] leading-relaxed text-neutral-500">
            A refusal is not a malfunction. It means a step did not follow from the reported problem, or rested on a
            cause nothing had established.
          </p>
        </Panel>
      </div>
    </div>
  );
}

const pct = (n: number, total: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);

function Stat({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 p-4">
      <div className="flex items-center gap-1.5 text-[12px] text-neutral-500">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-[24px] leading-none text-neutral-900">{value}</div>
      <div className="mt-1.5 text-[11.5px] text-neutral-400">{sub}</div>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 p-4">
      <h2 className="text-[14px] text-neutral-900">{title}</h2>
      <p className="mt-1 mb-3 text-[12px] leading-relaxed text-neutral-500">{hint}</p>
      {children}
    </section>
  );
}

const TONE: Record<string, string> = {
  blue: "bg-blue-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  neutral: "bg-neutral-400",
};

function Bar({
  label,
  value,
  total,
  tone,
  unit,
}: {
  label: string;
  value: number;
  total: number;
  tone: string;
  unit?: string;
}) {
  const width = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
        <span className="min-w-0 truncate text-neutral-700">{label}</span>
        <span className="flex-none text-neutral-500">
          {value.toLocaleString()}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-100">
        {/* Zero stays visibly zero: no minimum width that would imply a count. */}
        <div className={`h-full rounded-full ${TONE[tone] ?? TONE.neutral}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}
