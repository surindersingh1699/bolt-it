"use client";

import { Ticket } from "@/lib/types";
import type { TraceEvent } from "@/lib/trace";
import {
  Brain,
  CircleCheck,
  CircleX,
  Database,
  ExternalLink,
  GitBranch,
  Loader2,
  Monitor,
  PauseCircle,
  PlayCircle,
  RotateCw,
  SearchCheck,
  ShieldCheck,
  UserSearch,
  Wrench,
} from "lucide-react";
import clsx from "clsx";

const NODE_META: Record<string, { label: string; icon: React.ComponentType<{ size?: number; className?: string }> }> = {
  gatherProfile: { label: "Look up directory record", icon: UserSearch },
  gatherMemory: { label: "Recall what we know about this user", icon: Database },
  gatherDeviceContext: { label: "Look up reporter's device", icon: Monitor },
  draftPlan: { label: "Draft plan (LLM)", icon: Brain },
  classifyRisk: { label: "Classify risk per step", icon: ShieldCheck },
  tierGate: { label: "Check autonomy tier", icon: ShieldCheck },
  persistPlan: { label: "Persist plan", icon: Database },
  interrupt: { label: "Human approval gate", icon: PauseCircle },
  verifyOutcome: { label: "Verify: did it actually work?", icon: SearchCheck },
  replan: { label: "Re-plan next attempt", icon: RotateCw },
  exhausted: { label: "Attempts exhausted", icon: CircleX },
  escalate: { label: "Escalate", icon: CircleX },
  updateMemory: { label: "Save what we learned", icon: Database },
  finalize: { label: "Finalize & confirm", icon: CircleCheck },
};

function metaFor(node: string) {
  if (NODE_META[node]) return NODE_META[node];
  if (node.startsWith("execute:")) {
    return { label: `Execute ${node.slice("execute:".length)}`, icon: Wrench };
  }
  // escalate:tier2 — the tier gate refusing to act at the current autonomy level.
  if (node.startsWith("escalate:tier")) {
    return { label: `Escalate — needs tier ${node.slice("escalate:tier".length)}`, icon: CircleX };
  }
  return { label: node, icon: GitBranch };
}

function statusStyle(ev: TraceEvent): { dot: string; text: string } {
  switch (ev.status) {
    case "completed":
      return { dot: "bg-emerald-400", text: "text-neutral-200" };
    case "failed":
      return { dot: "bg-rose-400", text: "text-rose-200" };
    case "interrupted":
      return { dot: "bg-amber-400 animate-pulse", text: "text-amber-200" };
    case "resumed":
      return { dot: "bg-violet-400", text: "text-violet-200" };
    default:
      return { dot: "bg-cyan-400 animate-pulse", text: "text-neutral-300" };
  }
}

export function AgentTracePanel({ ticket }: { ticket: Ticket }) {
  const trace = ticket.trace ?? [];
  if (trace.length === 0) return null;

  // Hide "started" rows that already have a terminal row for the same node.
  const terminalNodes = new Set(trace.filter((e) => e.status !== "started").map((e) => e.node));
  const visible = trace.filter((e) => e.status !== "started" || !terminalNodes.has(e.node));

  return (
    <section className="px-6 py-5 border-b border-neutral-800">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[11px] uppercase tracking-wider text-neutral-500 font-medium flex items-center gap-1.5">
          <GitBranch size={11} />
          Agent trace · LangGraph execution
        </h3>
        <a
          href="https://smith.langchain.com"
          target="_blank"
          rel="noreferrer"
          title={`Full trace in LangSmith — search run name "ticket:${ticket.id}"`}
          className="text-[10px] text-neutral-500 hover:text-neutral-200 flex items-center gap-1 transition-colors"
        >
          ticket:{ticket.id} in LangSmith
          <ExternalLink size={9} />
        </a>
      </div>
      <ol className="relative border-l border-neutral-800 ml-1.5 space-y-2.5">
        {visible.map((ev, i) => {
          const { label, icon: Icon } = metaFor(ev.node);
          const s = statusStyle(ev);
          const running = ev.status === "started";
          return (
            <li key={`${ev.node}-${ev.at}-${i}`} className="pl-4 relative">
              <span
                className={clsx("absolute -left-[4.5px] top-1.5 w-2 h-2 rounded-full", s.dot)}
              />
              <div className="flex items-center gap-2">
                {running ? (
                  <Loader2 size={11} className="animate-spin text-cyan-300" />
                ) : ev.status === "resumed" ? (
                  <PlayCircle size={11} className="text-violet-300" />
                ) : (
                  <Icon size={11} className="text-neutral-500" />
                )}
                <span className={clsx("text-xs font-medium", s.text)}>{label}</span>
                {ev.status === "interrupted" && (
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                    paused
                  </span>
                )}
                {ev.status === "resumed" && (
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30">
                    resumed
                  </span>
                )}
                <span className="ml-auto text-[10px] text-neutral-600 font-mono">
                  {ev.durationMs !== undefined ? `${ev.durationMs}ms` : ""}
                </span>
              </div>
              {ev.detail && (
                <div className="text-[11px] text-neutral-500 mt-0.5 leading-relaxed">{ev.detail}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
