"use client";

import { useAppState } from "./StateProvider";
import { Citation } from "@/lib/types";
import { BookOpen, CloudCog, DatabaseZap, HardDrive, KeyRound, MessageSquare, ShieldCheck, User2 } from "lucide-react";

type RowTone = "live" | "mock" | "off";

export function KnowledgeSidebar() {
  const { tickets, selectedTicketId, runbooks } = useAppState();
  const ticket = tickets.find((t) => t.id === selectedTicketId);

  if (!ticket) {
    return (
      <div className="bg-neutral-950 overflow-y-auto">
        <div className="px-4 py-4 border-b border-neutral-800">
          <SectionHeader title="Knowledge" />
          <p className="text-[11px] text-neutral-500 mt-1">
            Select a ticket to see per-ticket grounding sources.
          </p>
        </div>
      </div>
    );
  }

  const runbookCites = ticket.citations.filter((c) => c.source === "runbook");
  const userCites = ticket.citations.filter((c) => c.source === "memory");
  const humanGated = ticket.plan.filter((s) => s.approvalMode === "human").length;

  return (
    <div className="bg-neutral-950 overflow-y-auto">
      <div className="px-4 py-4 border-b border-neutral-800 sticky top-0 bg-neutral-950/95 backdrop-blur">
        <SectionHeader title="Grounding sources" />
        <p className="text-[11px] text-neutral-500 mt-1">
          Every AI suggestion is cited. No grounding = no plan.
        </p>
      </div>

      <section className="px-4 py-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5 mb-3">
          <CloudCog size={12} className="text-cyan-400" />
          <span className="text-[11px] uppercase tracking-wider text-neutral-400">
            Connected MSP systems
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2">
          <SystemRow
            icon={<BookOpen size={12} />}
            label="Docs + runbooks"
            value={`${runbooks.length} runbook${runbooks.length === 1 ? "" : "s"}`}
            tone="live"
          />
          <SystemRow
            icon={<KeyRound size={12} />}
            label="Identity actions"
            value="AD / Okta (mocked)"
            tone="mock"
          />
          <SystemRow
            icon={<HardDrive size={12} />}
            label="Device logs"
            value="read-only sandbox"
            tone="live"
          />
          <SystemRow
            icon={<DatabaseZap size={12} />}
            label="Memory"
            value={
              userCites.length > 0
                ? `${userCites.length} context hit${userCites.length === 1 ? "" : "s"}`
                : "no memory for this user yet"
            }
            tone="live"
          />
          <SystemRow
            icon={<ShieldCheck size={12} />}
            label="Policy gate"
            value={
              humanGated > 0
                ? `${humanGated} step${humanGated === 1 ? "" : "s"} → escalate`
                : "all auto"
            }
            tone="live"
          />
        </div>
      </section>

      <section className="px-4 py-4 border-b border-neutral-800">
        <div className="flex items-center gap-1.5 mb-3">
          <BookOpen size={12} className="text-emerald-400" />
          <span className="text-[11px] uppercase tracking-wider text-neutral-400">
            Runbook hits
          </span>
          <span className="text-[10px] text-neutral-600 ml-auto">{runbookCites.length}</span>
        </div>
        {runbookCites.length === 0 && (
          <p className="text-xs text-neutral-500">No runbook matches yet.</p>
        )}
        <ul className="space-y-2">
          {runbookCites.map((c) => (
            <CiteCard key={c.ref} cite={c} runbookCount={runbooks.length} />
          ))}
        </ul>
      </section>

      <section className="px-4 py-4">
        <div className="flex items-center gap-1.5 mb-3">
          <User2 size={12} className="text-violet-400" />
          <span className="text-[11px] uppercase tracking-wider text-neutral-400">
            Memory · user context
          </span>
        </div>
        {userCites.length === 0 ? (
          <p className="text-xs text-neutral-500">
            No memory for this user yet. Facts and history are written when a ticket finishes.
          </p>
        ) : (
          <ul className="space-y-2">
            {userCites.map((c) => (
              <CiteCard key={c.ref} cite={c} runbookCount={0} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SystemRow({
  icon,
  label,
  value,
  tone = "live",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: RowTone;
}) {
  const valueColor =
    tone === "live"
      ? "text-emerald-300"
      : tone === "mock"
        ? "text-amber-300"
        : "text-neutral-500";
  return (
    <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5">
      <span className="text-neutral-500">{icon}</span>
      <span className="text-[11px] text-neutral-300">{label}</span>
      <span className={`ml-auto text-[10px] ${valueColor}`}>{value}</span>
    </div>
  );
}

function CiteCard({ cite, runbookCount: _runbookCount }: { cite: Citation; runbookCount: number }) {
  return (
    <li className="bg-neutral-900/60 border border-neutral-800 rounded-md p-3">
      <div className="text-xs font-medium text-neutral-200 leading-snug mb-1">{cite.title}</div>
      <p className="text-[11px] text-neutral-500 leading-relaxed line-clamp-3">{cite.snippet}</p>
      <div className="text-[10px] text-neutral-600 font-mono mt-1.5">{cite.ref}</div>
    </li>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wider text-neutral-500">{title}</span>
    </div>
  );
}
