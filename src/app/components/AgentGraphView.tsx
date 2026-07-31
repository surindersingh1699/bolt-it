"use client";

import { Ticket } from "@/lib/types";
import type { TraceEvent } from "@/lib/trace";

// Live LangGraph pipeline visual: each node lights up as the real trace
// reaches it — cyan glow = running now, amber glow = paused on the human
// gate, green = done, red = failed. Derived entirely from ticket.trace.

interface NodeDef {
  id: string;
  label: string;
  x: number;
  y: number;
  match: (n: string) => boolean;
}

const W = 150;
const H = 44;

const NODES: NodeDef[] = [
  { id: "ctxUser", label: "User context", x: 20, y: 16, match: (n) => n === "gatherUserContext" },
  { id: "ctxMem", label: "Memory search", x: 20, y: 86, match: (n) => n === "gatherMemories" },
  { id: "ctxDev", label: "Device lookup", x: 20, y: 156, match: (n) => n === "gatherDeviceContext" },
  { id: "draft", label: "Draft plan (LLM)", x: 220, y: 86, match: (n) => n === "draftPlan" },
  { id: "classify", label: "Classify risk", x: 420, y: 86, match: (n) => n === "classifyRisk" },
  { id: "execute", label: "Execute steps", x: 620, y: 86, match: (n) => n === "persistPlan" || n.startsWith("execute:") },
  { id: "gate", label: "Human gate", x: 620, y: 186, match: (n) => n === "interrupt" },
  { id: "verify", label: "Verify outcome", x: 820, y: 86, match: (n) => n === "verifyOutcome" },
  { id: "replan", label: "Re-plan", x: 820, y: 186, match: (n) => n === "replan" },
  { id: "finalize", label: "Finalize", x: 1020, y: 86, match: (n) => n === "finalize" || n === "exhausted" || n === "escalate" },
];

const EDGES: Array<[string, string]> = [
  ["ctxUser", "classify"],
  ["ctxMem", "draft"],
  ["ctxDev", "classify"],
  ["draft", "classify"],
  ["classify", "execute"],
  ["execute", "gate"],
  ["gate", "execute"],
  ["execute", "verify"],
  ["verify", "replan"],
  ["replan", "execute"],
  ["verify", "finalize"],
];

type NodeState = "idle" | "running" | "done" | "failed" | "paused" | "resumed";

function nodeStates(trace: TraceEvent[], ticketStatus: Ticket["status"]): Record<string, NodeState> {
  const states: Record<string, NodeState> = {};
  for (const n of NODES) states[n.id] = "idle";

  for (const ev of trace) {
    const node = NODES.find((n) => n.match(ev.node));
    if (!node) continue;
    if (ev.status === "failed") states[node.id] = "failed";
    else if (ev.status === "interrupted") states[node.id] = "paused";
    else if (ev.status === "resumed") states[node.id] = "resumed";
    else if (ev.status === "completed" && states[node.id] !== "failed") states[node.id] = "done";
    else if (ev.status === "started" && states[node.id] === "idle") states[node.id] = "running";
  }

  // The most recent trace event marks the live frontier while the ticket is active.
  const last = trace[trace.length - 1];
  const active = !["resolved", "escalated", "awaiting_confirmation"].includes(ticketStatus);
  if (last && active) {
    const node = NODES.find((n) => n.match(last.node));
    if (node && last.status !== "interrupted") {
      // the NEXT logical hop is what's running; glowing the latest node reads better
      if (states[node.id] === "done") states[node.id] = "running";
    }
  }
  if (ticketStatus === "awaiting_approval") states["gate"] = "paused";
  return states;
}

const STYLE: Record<NodeState, { fill: string; stroke: string; text: string; glow?: string; pulse?: boolean }> = {
  idle: { fill: "#171717", stroke: "#333", text: "#666" },
  running: { fill: "#083344", stroke: "#22d3ee", text: "#a5f3fc", glow: "#22d3ee", pulse: true },
  done: { fill: "#052e1b", stroke: "#34d399", text: "#a7f3d0" },
  failed: { fill: "#3f0d1d", stroke: "#fb7185", text: "#fecdd3", glow: "#fb7185" },
  paused: { fill: "#422006", stroke: "#fbbf24", text: "#fde68a", glow: "#fbbf24", pulse: true },
  resumed: { fill: "#2e1065", stroke: "#a78bfa", text: "#ddd6fe" },
};

export function AgentGraphView({ ticket }: { ticket: Ticket }) {
  const trace = ticket.trace ?? [];
  if (trace.length === 0) return null;
  const states = nodeStates(trace, ticket.status);
  const byId = Object.fromEntries(NODES.map((n) => [n.id, n]));

  return (
    <section className="px-6 py-4 border-b border-neutral-800 bg-neutral-950/60">
      <svg viewBox="0 0 1190 250" className="w-full h-auto" role="img" aria-label="Agent pipeline">
        <defs>
          <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {EDGES.map(([a, b]) => {
          const na = byId[a];
          const nb = byId[b];
          const lit = states[a] !== "idle" && states[b] !== "idle";
          const x1 = na.x + W;
          const y1 = na.y + H / 2;
          const x2 = nb.x;
          const y2 = nb.y + H / 2;
          // vertical-ish edges (loops to gate/replan rows) connect via sides
          const vertical = Math.abs(na.x - nb.x) < W;
          const path = vertical
            ? `M ${na.x + W / 2} ${na.y < nb.y ? na.y + H : na.y} L ${nb.x + W / 2} ${na.y < nb.y ? nb.y : nb.y + H}`
            : `M ${x1} ${y1} C ${x1 + 25} ${y1}, ${x2 - 25} ${y2}, ${x2} ${y2}`;
          return (
            <path
              key={`${a}-${b}`}
              d={path}
              fill="none"
              stroke={lit ? "#34d399" : "#2a2a2a"}
              strokeWidth={lit ? 1.6 : 1}
              opacity={lit ? 0.8 : 0.6}
            />
          );
        })}

        {NODES.map((n) => {
          const s = STYLE[states[n.id]];
          return (
            <g key={n.id} className={s.pulse ? "animate-pulse" : undefined}>
              <rect
                x={n.x}
                y={n.y}
                width={W}
                height={H}
                rx={9}
                fill={s.fill}
                stroke={s.stroke}
                strokeWidth={1.4}
                filter={s.glow ? "url(#glow)" : undefined}
              />
              <text
                x={n.x + W / 2}
                y={n.y + H / 2 + 4}
                textAnchor="middle"
                fontSize={13}
                fontFamily="ui-sans-serif, system-ui"
                fill={s.text}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </section>
  );
}
