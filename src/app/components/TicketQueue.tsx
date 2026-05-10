"use client";

import { useAppState } from "./StateProvider";
import { Ticket } from "@/lib/types";
import clsx from "clsx";
import { Inbox, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { clearTicketQueue } from "@/app/actions/tickets";

export function TicketQueue() {
  const { tickets, selectedTicketId, selectTicket } = useAppState();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClear = () => {
    if (tickets.length === 0) return;
    if (!confirm(`Delete all ${tickets.length} tickets in this workspace? Runbooks are kept.`)) return;
    setError(null);
    startTransition(async () => {
      try {
        await clearTicketQueue();
      } catch (err) {
        setError((err as Error).message || "Clear failed");
      }
    });
  };

  return (
    <div className="overflow-y-auto bg-neutral-950">
      <div className="px-4 py-3 sticky top-0 bg-neutral-950/95 backdrop-blur border-b border-neutral-800 flex items-center gap-2">
        <Inbox size={14} className="text-neutral-500" />
        <span className="text-xs uppercase tracking-wider text-neutral-500">Queue</span>
        <span className="ml-auto text-xs text-neutral-600">{tickets.length}</span>
        <button
          onClick={onClear}
          disabled={pending || tickets.length === 0}
          title="Delete all tickets (runbooks kept)"
          className="text-[11px] text-neutral-500 hover:text-rose-300 disabled:opacity-30 disabled:hover:text-neutral-500 flex items-center gap-1"
        >
          <Trash2 size={12} />
          {pending ? "clearing…" : "clear"}
        </button>
      </div>
      {error && (
        <div className="px-4 py-2 text-[11px] text-rose-300 border-b border-rose-900/40 bg-rose-950/20">
          {error}
        </div>
      )}
      {tickets.length === 0 && (
        <div className="px-4 py-8 text-center text-neutral-500 text-xs">
          No tickets yet.<br />
          Open the Slack tab to send one.
        </div>
      )}
      <ul className="divide-y divide-neutral-900">
        {tickets.map((t) => (
          <li key={t.id}>
            <button
              onClick={() => selectTicket(t.id)}
              className={clsx(
                "w-full text-left px-4 py-3 hover:bg-neutral-900 transition-colors",
                selectedTicketId === t.id && "bg-neutral-900",
              )}
            >
              <div className="flex items-center gap-2 mb-1">
                <StatusDot status={t.status} />
                <span className="text-[11px] font-mono text-neutral-500">{t.id}</span>
                <span className="ml-auto text-[10px] text-neutral-600">
                  {timeAgo(t.createdAt)}
                </span>
              </div>
              <div className="text-sm text-neutral-200 line-clamp-1">{t.subject}</div>
              <div className="text-xs text-neutral-500 mt-0.5 line-clamp-1">
                {t.reporter} · {labelForStatus(t.status)}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusDot({ status }: { status: Ticket["status"] }) {
  const color = {
    new: "bg-blue-400",
    drafting: "bg-violet-400 animate-pulse",
    awaiting_approval: "bg-amber-400 animate-pulse",
    executing: "bg-cyan-400 animate-pulse",
    awaiting_confirmation: "bg-sky-400 animate-pulse",
    resolved: "bg-emerald-400",
    escalated: "bg-rose-400",
  }[status];
  return <span className={clsx("w-2 h-2 rounded-full", color)} />;
}

function labelForStatus(status: Ticket["status"]): string {
  return {
    new: "new",
    drafting: "AI drafting…",
    awaiting_approval: "needs approval",
    executing: "executing…",
    awaiting_confirmation: "waiting on user reply",
    resolved: "resolved by AI",
    escalated: "escalated",
  }[status];
}

function timeAgo(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}
