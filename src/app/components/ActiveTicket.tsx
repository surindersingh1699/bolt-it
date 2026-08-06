"use client";

import { useAppState } from "./StateProvider";
import { PlanStep, PublicUser, Ticket } from "@/lib/types";
import { useState, useTransition } from "react";
import clsx from "clsx";
import { approveAndExecute, escalateTicket } from "@/app/actions/tickets";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  FlaskConical,
  Globe2,
  Loader2,
  Lock,
  MessageCircle,
  Send,
  ShieldCheck,
} from "lucide-react";
import { AgentTracePanel } from "./AgentTracePanel";
import { AgentGraphView } from "./AgentGraphView";

export function ActiveTicket({
  currentUser,
}: {
  currentUser: PublicUser;
}) {
  const { tickets, selectedTicketId } = useAppState();
  const ticket = tickets.find((t) => t.id === selectedTicketId);
  if (!ticket) {
    return (
      <div className="flex items-center justify-center text-neutral-500 text-sm">
        Select a ticket to view details
      </div>
    );
  }
  return <TicketView ticket={ticket} currentUser={currentUser} />;
}

function TicketView({
  ticket,
  currentUser,
}: {
  ticket: Ticket;
  currentUser: PublicUser;
}) {
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const canApprove = currentUser.isITStaff;

  const onApprove = () => {
    setActionError(null);
    startTransition(async () => {
      try {
        await approveAndExecute(ticket.id);
      } catch (err) {
        setActionError((err as Error).message || "Approval failed.");
      }
    });
  };

  const onEscalate = () => {
    setActionError(null);
    startTransition(async () => {
      try {
        await escalateTicket(ticket.id);
      } catch (err) {
        setActionError((err as Error).message || "Escalation failed.");
      }
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

      <AgentGraphView ticket={ticket} />

      <section className="px-6 py-5 border-b border-neutral-800">
        <SectionTitle>AI Draft Response</SectionTitle>
        {ticket.status === "drafting" || ticket.status === "new" ? (
          <div className="text-sm text-neutral-500 flex items-center gap-2 py-3">
            <Loader2 size={14} className="animate-spin" />
            Drafting plan…
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
              {ticket.citations.length} grounding {ticket.citations.length === 1 ? "citation" : "citations"}
            </div>
          </>
        ) : (
          <div className="text-sm text-neutral-500">No draft yet.</div>
        )}
      </section>

      {ticket.troubleshootingSummary && (
        <section className="px-6 py-5 border-b border-neutral-800">
          <SectionTitle>
            Troubleshooting record{ticket.attempts ? ` · ${ticket.attempts} attempt${ticket.attempts > 1 ? "s" : ""}` : ""}
          </SectionTitle>
          <pre className="text-[11px] text-neutral-400 leading-relaxed whitespace-pre-wrap font-sans">
            {ticket.troubleshootingSummary}
          </pre>
        </section>
      )}

      <AgentTracePanel ticket={ticket} />

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
          {canApprove ? (
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
                Approving as <span className="text-neutral-300">{currentUser.name}</span> ·
                 IT staff
              </span>
              {actionError && (
                <div className="basis-full text-xs text-rose-300 flex items-center gap-1.5 pt-1">
                  <AlertCircle size={12} />
                  {actionError}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-amber-200">
              <Lock size={14} />
              Awaiting IT staff approval. Sign in as a member of the{" "}
              <span className="text-emerald-300">it-staff</span> AD group to approve.
            </div>
          )}
        </section>
      )}

      {ticket.status === "resolved" && (
        <section className="px-6 py-5 bg-emerald-950/10">
          <div className="flex items-center gap-2 text-sm text-emerald-300">
            <CheckCircle2 size={16} />
            Resolved by AI in {Math.round((ticket.resolutionTimeMs ?? 0) / 1000)}s
          </div>
          <p className="text-xs text-neutral-500 mt-2">
            What worked was written to this employee&apos;s memory, so the next similar ticket starts ahead.
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
            <RiskBadge step={step} />
          </div>
          <div className="text-sm text-neutral-200">{step.description}</div>
          {step.log && step.log.length > 0 && (
            <pre className="mt-2 text-[11px] font-mono leading-relaxed whitespace-pre-wrap">
              {step.log.map((line, i) => (
                <span key={i} className={proofLineClass(line)}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}

function RiskBadge({ step }: { step: PlanStep }) {
  if (!step.risk) return null;
  if (step.governancePromoted) {
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 border border-violet-500/30 flex items-center gap-1"
        title={step.riskReason ? `${step.risk} risk — ${step.riskReason}` : undefined}
      >
        <ShieldCheck size={9} />
        trusted · auto
      </span>
    );
  }
  if (step.approvalMode === "human") {
    return (
      <span
        className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1"
        title={step.riskReason}
      >
        <Lock size={9} />
        {step.risk} risk · needs approval
      </span>
    );
  }
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-500 border border-neutral-700"
      title={step.riskReason}
    >
      {step.risk} risk · auto
    </span>
  );
}

// Device evidence is the line a reviewer should read first, so it is the only
// part of the log that gets colour: green when the machine verifiably changed,
// amber when it demonstrably did not.
function proofLineClass(line: string): string {
  if (line.startsWith("[Proof] EFFECT:")) return "text-emerald-400";
  if (line.startsWith("[Proof] NO EFFECT")) return "text-amber-300";
  if (line.startsWith("[Proof]")) return "text-neutral-400";
  return "text-neutral-500";
}

function stepIcon(step: PlanStep) {
  switch (step.kind) {
    case "backend":
      return ShieldCheck;
    case "device":
      return FlaskConical;
    case "reply":
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
    awaiting_confirmation: "bg-sky-500/15 text-sky-300",
    resolved: "bg-emerald-500/15 text-emerald-300",
    escalated: "bg-rose-500/15 text-rose-300",
  } as const;
  const labels = {
    new: "new",
    drafting: "drafting",
    awaiting_approval: "awaiting approval",
    executing: "executing",
    awaiting_confirmation: "awaiting user confirmation",
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
