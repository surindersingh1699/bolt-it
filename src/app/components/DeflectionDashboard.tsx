"use client";

import { DeflectionStat, Ticket } from "@/lib/types";

export function DeflectionDashboard({
  stats,
  tickets,
  demoMode = false,
}: {
  stats: DeflectionStat;
  tickets?: Ticket[];
  demoMode?: boolean;
}) {
  const ratePct = Math.round(stats.rate * 100);
  const avgSec = stats.avgResolutionMs > 0 ? Math.round(stats.avgResolutionMs / 1000) : 0;
  const laborSavedMin = stats.aiResolved * 18;

  // Research framing: autonomy/oversight metrics computed from the actual
  // plans, instead of business KPIs. Demo mode keeps the sales-style bar.
  if (!demoMode && tickets) {
    const steps = tickets.flatMap((t) => t.plan);
    const executed = steps.filter((s) => s.status === "succeeded" || s.status === "failed");
    const autoRun = executed.filter((s) => s.approvalMode === "auto" && !s.governancePromoted).length;
    const humanApproved = executed.filter((s) => s.approvalMode === "human").length;
    const trustPromoted = steps.filter((s) => s.governancePromoted).length;
    const interruptsOpen = tickets.filter((t) => t.status === "awaiting_approval").length;
    const judged = steps.filter((s) => s.riskSource === "judge").length;
    const autonomyPct = executed.length > 0 ? Math.round((autoRun / executed.length) * 100) : 0;

    return (
      <div className="border-b border-neutral-800 bg-neutral-950 px-6 py-2 flex flex-wrap items-center gap-6 text-xs">
        <Metric label="Tickets" value={stats.totalTickets.toString()} />
        <Metric label="Steps auto-executed" value={autoRun.toString()} accent="good" />
        <Metric label="Human approvals" value={humanApproved.toString()} accent={humanApproved > 0 ? "warn" : "neutral"} />
        <Metric label="Trust-promoted" value={trustPromoted.toString()} accent={trustPromoted > 0 ? "violet" : "neutral"} />
        <Metric label="LLM-judged steps" value={judged.toString()} />
        <Metric label="Autonomy" value={executed.length > 0 ? `${autonomyPct}%` : "—"} accent="good" />
        <Metric
          label="Interrupts open"
          value={interruptsOpen.toString()}
          accent={interruptsOpen > 0 ? "warn" : "neutral"}
        />
        <div className="ml-auto flex items-center gap-1.5 text-[10px] text-neutral-500">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          live
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-neutral-800 bg-neutral-950 px-6 py-2 flex flex-wrap items-center gap-6 text-xs">
      <Metric label="Tickets" value={stats.totalTickets.toString()} />
      <Metric
        label="Deflection rate"
        value={`${ratePct}%`}
        accent={ratePct >= 60 ? "good" : ratePct > 0 ? "warn" : "neutral"}
      />
      <Metric label="AI resolved" value={stats.aiResolved.toString()} accent="good" />
      <Metric label="Escalated" value={stats.escalated.toString()} accent={stats.escalated > 0 ? "warn" : "neutral"} />
      <Metric label="Avg resolve" value={avgSec > 0 ? `${avgSec}s` : "—"} />
      <Metric label="Labor saved" value={laborSavedMin > 0 ? `${laborSavedMin}m` : "—"} accent="good" />
      <div className="ml-auto flex items-center gap-1.5 text-[10px] text-neutral-500">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
        live
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent = "neutral",
}: {
  label: string;
  value: string;
  accent?: "good" | "warn" | "neutral" | "violet";
}) {
  const colors = {
    good: "text-emerald-400",
    warn: "text-amber-400",
    neutral: "text-neutral-100",
    violet: "text-violet-300",
  } as const;
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-neutral-500 uppercase tracking-wider">{label}</span>
      <span className={`font-semibold ${colors[accent]}`}>{value}</span>
    </div>
  );
}
