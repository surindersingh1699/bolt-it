"use client";

import { DeflectionStat } from "@/lib/types";

export function DeflectionDashboard({ stats }: { stats: DeflectionStat }) {
  const ratePct = Math.round(stats.rate * 100);
  const avgSec = stats.avgResolutionMs > 0 ? Math.round(stats.avgResolutionMs / 1000) : 0;
  const laborSavedMin = stats.aiResolved * 18;

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
  accent?: "good" | "warn" | "neutral";
}) {
  const colors = {
    good: "text-emerald-400",
    warn: "text-amber-400",
    neutral: "text-neutral-100",
  } as const;
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-neutral-500 uppercase tracking-wider">{label}</span>
      <span className={`font-semibold ${colors[accent]}`}>{value}</span>
    </div>
  );
}
