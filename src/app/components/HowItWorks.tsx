import {
  MessageSquare,
  FileText,
  ShieldCheck,
  Cpu,
  CheckCircle2,
} from "lucide-react";

const STEPS = [
  {
    icon: <MessageSquare size={18} />,
    title: "1. Intake",
    body: "Your users ask in Slack (or this in-app demo). The agent picks up the request as a structured ticket.",
  },
  {
    icon: <FileText size={18} />,
    title: "2. Draft",
    body: "Real Nia retrieves the matching runbook. AI Gateway grounds the response in Hyperspell memories of recent activity.",
  },
  {
    icon: <ShieldCheck size={18} />,
    title: "3. Approve",
    body: "An IT technician sees the plan with citations and approves or edits. Zero standing access — the agent never holds creds.",
  },
  {
    icon: <Cpu size={18} />,
    title: "4. Execute",
    body: "Plan runs through capability-scoped adapters: InsForge edge functions, Aside browser actions, Tensorlake/Vercel Sandbox diagnostics, Slack reply.",
  },
  {
    icon: <CheckCircle2 size={18} />,
    title: "5. Resolve & learn",
    body: "Ticket closes. Resolution credits an existing runbook or auto-synthesizes a new one for next time. Deflection ticks up.",
  },
];

export function HowItWorks() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
      {STEPS.map((s) => (
        <div
          key={s.title}
          className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 flex flex-col gap-2"
        >
          <div className="flex items-center gap-2 text-emerald-400">
            {s.icon}
            <div className="text-xs font-semibold tracking-tight text-neutral-100">{s.title}</div>
          </div>
          <div className="text-[11px] text-neutral-400 leading-relaxed">{s.body}</div>
        </div>
      ))}
    </div>
  );
}
