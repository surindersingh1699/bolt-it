"use client";

import { useAppState } from "./StateProvider";
import { PlanStep, PublicUser, Ticket } from "@/lib/types";
import { useState, useTransition } from "react";
import clsx from "clsx";
import { approveAndExecute, demoApproveAndExecute, escalateTicket } from "@/app/actions/tickets";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  FileText,
  FlaskConical,
  Globe2,
  HardDrive,
  Loader2,
  Lock,
  MessageCircle,
  Network,
  SearchCheck,
  Send,
  ShieldCheck,
  UserCheck,
} from "lucide-react";

export function ActiveTicket({
  currentUser,
  demoMode = false,
}: {
  currentUser: PublicUser;
  demoMode?: boolean;
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
  return <TicketView ticket={ticket} currentUser={currentUser} demoMode={demoMode} />;
}

function TicketView({
  ticket,
  currentUser,
  demoMode,
}: {
  ticket: Ticket;
  currentUser: PublicUser;
  demoMode: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const canApprove = currentUser.isITStaff;

  const onApprove = () => {
    setActionError(null);
    startTransition(async () => {
      try {
        if (demoMode) {
          await demoApproveAndExecute(ticket.id);
        } else {
          await approveAndExecute(ticket.id);
        }
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

      <EvidencePanel ticket={ticket} />

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
                {demoMode ? " demo IT staff" : " IT staff"}
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

function EvidencePanel({ ticket }: { ticket: Ticket }) {
  const evidence = evidenceForTicket(ticket);
  if (evidence.length === 0) return null;
  return (
    <section className="px-6 py-5 border-b border-neutral-800 bg-neutral-950">
      <div className="flex items-center justify-between mb-3">
        <SectionTitle>MSP Evidence Pack</SectionTitle>
        <span className="text-[10px] uppercase tracking-wider text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 rounded px-2 py-1">
          ready for technician review
        </span>
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {evidence.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.title} className="bg-neutral-900/50 border border-neutral-800 rounded-md p-3">
              <div className="flex items-center gap-2 mb-1">
                <Icon size={14} className={item.accent} />
                <span className="text-xs font-medium text-neutral-100">{item.title}</span>
                <span className="ml-auto text-[10px] text-neutral-600">{item.source}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-neutral-400">{item.body}</p>
              {item.detail && (
                <pre className="mt-2 text-[10px] leading-relaxed text-neutral-500 whitespace-pre-wrap font-mono">
                  {item.detail}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function evidenceForTicket(ticket: Ticket): Array<{
  icon: React.ComponentType<{ size?: number; className?: string }>;
  title: string;
  source: string;
  body: string;
  detail?: string;
  accent: string;
}> {
  const text = `${ticket.subject} ${ticket.body}`.toLowerCase();
  const runbookHit = ticket.citations.find((c) => c.source === "nia");
  const userCtx = ticket.citations.find((c) => c.source === "hyperspell");

  if (text.includes("cfo") || text.includes("board meeting") || text.includes("finance drive")) {
    return [
      {
        icon: UserCheck,
        title: "Identity and business impact",
        source: "Hyperspell + directory",
        body: "Frank is Finance leadership, currently in an urgent board-meeting workflow. Recent context shows NetSuite, Excel, VPN, and Slack activity.",
        detail: userCtx?.snippet ?? "Recent apps: netsuite, excel, vpn, slack",
        accent: "text-violet-300",
      },
      {
        icon: Network,
        title: "VPN diagnostic signal",
        source: "MDM + network probe",
        body: "The last known VPN profile points at a retired gateway. Packet probe shows retransmits and MTU mismatch after password change.",
        detail:
          "vpn-client.log: AUTH_FAILED after SAML reauth\nmdm-profile: acme-vpn-usw1-v3, pushed 93 days ago\nprobe: gateway=us-west-1.old.acme.test mtu=1280 retransmits=3",
        accent: "text-cyan-300",
      },
      {
        icon: FileText,
        title: "Company runbook match",
        source: "Nia retrieval",
        body: runbookHit
          ? `${runbookHit.title}: ${runbookHit.snippet}`
          : "VPN performance degraded; intermittent drops. Common cause: client config still references a decommissioned gateway.",
        accent: "text-emerald-300",
      },
      {
        icon: ShieldCheck,
        title: "Execution boundary",
        source: "Policy engine",
        body: "The AI cannot run broad admin commands. The plan is limited to a sandboxed diagnostic, scoped MDM profile push, and Slack reply after technician approval.",
        detail: "allowed: diag.network_probe, mdm.push_vpn_config, slack.send_message\nblocked: unrestricted shell, standing admin session",
        accent: "text-amber-300",
      },
    ];
  }

  if (text.includes("vpn") || text.includes("network")) {
    return [
      {
        icon: Network,
        title: "Network probe",
        source: "Sandbox diagnostics",
        body: "Sandboxed probe checks last-known VPN endpoint, MTU, route health, and recent client profile age before action is approved.",
        detail: "diag.network_probe: isolated VM, no corp network egress, secrets redacted",
        accent: "text-cyan-300",
      },
      {
        icon: HardDrive,
        title: "Device context",
        source: "MDM",
        body: "MDM can push the refreshed VPN profile to the user's assigned device without exposing global admin credentials to the AI.",
        accent: "text-emerald-300",
      },
    ];
  }

  if (text.includes("locked") || text.includes("password") || text.includes("login")) {
    return [
      {
        icon: SearchCheck,
        title: "Auth log review",
        source: "Read-only sandbox",
        body: "The plan confirms the failure pattern in auth logs before unlocking or resetting anything.",
        detail:
          "audit: USER_LOGIN failed x5\npolicy: unlock requires identity verification\nsandbox: read-only mount, destroyed after inspection",
        accent: "text-cyan-300",
      },
      {
        icon: ShieldCheck,
        title: "Identity verification",
        source: "Hyperspell + AD",
        body: "Recent user context and directory state are checked before a privileged identity action is executed.",
        accent: "text-violet-300",
      },
    ];
  }

  return [
    {
      icon: FileText,
      title: "Grounding status",
      source: "Knowledge base",
      body: runbookHit
        ? `${runbookHit.title}: ${runbookHit.snippet}`
        : "No high-confidence runbook match yet. The agent keeps the action plan conservative and asks for more detail.",
      accent: "text-neutral-400",
    },
  ];
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
