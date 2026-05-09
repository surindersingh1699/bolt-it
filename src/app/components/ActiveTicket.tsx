"use client";

import { useAppState } from "./StateProvider";
import { PlanStep, Ticket } from "@/lib/types";
import { useTransition } from "react";
import clsx from "clsx";
import { approveAndExecute, escalateTicket } from "@/app/actions/tickets";
import { CheckCircle2, AlertCircle, Loader2, Circle, Send, ShieldCheck, FlaskConical, Globe2, MessageCircle } from "lucide-react";

export function ActiveTicket() {
  const { tickets, selectedTicketId } = useAppState();
  const ticket = tickets.find((t) => t.id === selectedTicketId);
  if (!ticket) {
    return (
      <div className="flex items-center justify-center text-neutral-500 text-sm">
        Select a ticket to view details
      </div>
    );
  }
  return <TicketView ticket={ticket} />;
}

function TicketView({ ticket }: { ticket: Ticket }) {
  const [pending, startTransition] = useTransition();

  const onApprove = () => {
    startTransition(async () => {
      await approveAndExecute(ticket.id);
    });
  };

  const onEscalate = () => {
    startTransition(async () => {
      await escalateTicket(ticket.id);
    });
  };

  return (
    <div className="overflow-y-auto bg-neutral-950">
      <div className="sticky top-0 bg-neutral-950/95 backdrop-blur border-b border-neutral-800 px-6 py-4 z-10">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-[11px] font-mono text-neutral-500">{ticket.id}</span>
          <StatusBadge status={ticket.status} />
          <span className="ml-auto text-xs text-neutral-500">
            from <span className="text-neutral-300">{ticket.reporter}</span>
            <span className="text-neutral-600"> · {ticket.reporterEmail}</span>
          </span>
        </div>
        <h2 className="text-lg font-semibold text-neutral-100 mb-1">{ticket.subject}</h2>
        <p className="text-sm text-neutral-400 leading-relaxed">{ticket.body}</p>
      </div>

      <section className="px-6 py-5 border-b border-neutral-800">
        <SectionTitle>AI Draft Response</SectionTitle>
        {ticket.status === "drafting" || ticket.status === "new" ? (
          <div className="text-sm text-neutral-500 flex items-center gap-2 py-3">
            <Loader2 size={14} className="animate-spin" />
            Drafting plan from runbooks…
          </div>
        ) : ticket.draftResponse ? (
          <>
            <div className="bg-neutral-900 border border-neutral-800 rounded-lg p-4 text-sm text-neutral-200 leading-relaxed">
              {ticket.draftResponse}
            </div>
            <div className="flex items-center gap-2 mt-2 text-xs text-neutral-500">
              <ShieldCheck size={12} className="text-emerald-400" />
              Confidence: {Math.round(ticket.confidence * 100)}%
              <span className="text-neutral-700">·</span>
              {ticket.citations.filter((c) => c.source === "nia").length} runbook citations from Nia
            </div>
          </>
        ) : (
          <div className="text-sm text-neutral-500">No draft yet.</div>
        )}
      </section>

      <section className="px-6 py-5 border-b border-neutral-800">
        <SectionTitle>Action Plan</SectionTitle>
        {ticket.plan.length === 0 ? (
          <div className="text-sm text-neutral-500">No plan yet.</div>
        ) : (
          <ol className="space-y-2">
            {ticket.plan.map((step, idx) => (
              <PlanStepRow key={step.id} step={step} index={idx} />
            ))}
          </ol>
        )}
      </section>

      {ticket.status === "awaiting_approval" && (
        <section className="px-6 py-5 border-b border-neutral-800 bg-amber-950/10 sticky bottom-0">
          <div className="flex items-center gap-3">
            <button
              onClick={onApprove}
              disabled={pending}
              className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-neutral-950 font-medium text-sm px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            >
              <CheckCircle2 size={14} />
              Approve & Execute
            </button>
            <button
              onClick={onEscalate}
              disabled={pending}
              className="bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm px-4 py-2 rounded-md flex items-center gap-2 transition-colors"
            >
              <AlertCircle size={14} />
              Escalate to human
            </button>
            <span className="text-xs text-neutral-500 ml-auto">
              Technician approval is the trust gate. Agent never acts without it.
            </span>
          </div>
        </section>
      )}

      {ticket.status === "resolved" && (
        <section className="px-6 py-5 bg-emerald-950/10">
          <div className="flex items-center gap-2 text-sm text-emerald-300">
            <CheckCircle2 size={16} />
            Resolved by AI in {Math.round((ticket.resolutionTimeMs ?? 0) / 1000)}s
          </div>
          <p className="text-xs text-neutral-500 mt-2">
            Resolution auto-extracted to a runbook entry. The next identical ticket will resolve faster.
          </p>
        </section>
      )}

      {ticket.status === "escalated" && (
        <section className="px-6 py-5 bg-rose-950/10">
          <div className="flex items-center gap-2 text-sm text-rose-300">
            <AlertCircle size={16} />
            Escalated to human technician
          </div>
        </section>
      )}
    </div>
  );
}

function PlanStepRow({ step, index }: { step: PlanStep; index: number }) {
  const Icon = stepIcon(step);
  return (
    <li className="bg-neutral-900/40 border border-neutral-800 rounded-md p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">{stepStatusIcon(step.status)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-mono text-neutral-500">#{index + 1}</span>
            <span className="text-[10px] uppercase tracking-wider text-neutral-500 flex items-center gap-1">
              <Icon size={10} />
              {step.kind}
            </span>
            {step.capability && (
              <span className="text-[10px] font-mono text-neutral-600">{step.capability}</span>
            )}
          </div>
          <div className="text-sm text-neutral-200">{step.description}</div>
          {step.log && step.log.length > 0 && (
            <pre className="mt-2 text-[11px] font-mono text-neutral-500 leading-relaxed whitespace-pre-wrap">
              {step.log.join("\n")}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}

function stepIcon(step: PlanStep) {
  switch (step.kind) {
    case "insforge":
      return ShieldCheck;
    case "aside":
      return Globe2;
    case "tensorlake":
      return FlaskConical;
    case "slack_reply":
      return MessageCircle;
    default:
      return Send;
  }
}

function stepStatusIcon(status: PlanStep["status"]) {
  if (status === "succeeded") return <CheckCircle2 size={14} className="text-emerald-400" />;
  if (status === "failed") return <AlertCircle size={14} className="text-rose-400" />;
  if (status === "running") return <Loader2 size={14} className="animate-spin text-cyan-400" />;
  return <Circle size={14} className="text-neutral-700" />;
}

function StatusBadge({ status }: { status: Ticket["status"] }) {
  const map = {
    new: "bg-blue-500/15 text-blue-300",
    drafting: "bg-violet-500/15 text-violet-300",
    awaiting_approval: "bg-amber-500/15 text-amber-300",
    executing: "bg-cyan-500/15 text-cyan-300",
    resolved: "bg-emerald-500/15 text-emerald-300",
    escalated: "bg-rose-500/15 text-rose-300",
  } as const;
  const labels = {
    new: "new",
    drafting: "drafting",
    awaiting_approval: "awaiting approval",
    executing: "executing",
    resolved: "resolved",
    escalated: "escalated",
  } as const;
  return (
    <span className={clsx("text-[10px] uppercase tracking-wider px-2 py-0.5 rounded", map[status])}>
      {labels[status]}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] uppercase tracking-wider text-neutral-500 mb-2 font-medium">
      {children}
    </h3>
  );
}
