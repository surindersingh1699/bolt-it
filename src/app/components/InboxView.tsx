"use client";

import clsx from "clsx";
import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { clearTicketQueue } from "@/app/actions/tickets";
import { PublicUser, Ticket } from "@/lib/types";
import { useAppState } from "./StateProvider";
import { TicketDetail } from "./TicketDetail";
import {
  avatarColor,
  GROUPS,
  groupOf,
  initialsOf,
  staffStatusLabel,
  TicketGroup,
  timeAgo,
  TONE_PILL,
  toneOf,
} from "./ticket-view";

export function InboxView({
  group,
  currentUser,
}: {
  group: TicketGroup;
  currentUser: PublicUser;
}) {
  const { tickets, selectedTicketId, selectTicket } = useAppState();
  const inGroup = tickets.filter((t) => groupOf(t.status) === group);
  const selected = inGroup.find((t) => t.id === selectedTicketId) ?? inGroup[0];
  const groupLabel = GROUPS.find((g) => g.id === group)?.label ?? "Tickets";

  return (
    <>
      <div className="flex w-[392px] flex-none flex-col border-r border-neutral-200">
        <ListHeader label={groupLabel} count={inGroup.length} total={tickets.length} />
        <div className="min-h-0 flex-1 overflow-y-auto">
          {inGroup.length === 0 ? (
            <p className="px-5 py-10 text-center text-[13px] leading-6 text-neutral-400">
              Nothing here.
              {group === "approval" && " Nobody is waiting on you."}
            </p>
          ) : (
            inGroup.map((t) => (
              <TicketRow
                key={t.id}
                ticket={t}
                active={t.id === selected?.id}
                onSelect={() => selectTicket(t.id)}
              />
            ))
          )}
        </div>
      </div>

      {selected ? (
        <TicketDetail ticket={selected} currentUser={currentUser} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-[13.5px] text-neutral-400">
          Pick a ticket to see what happened.
        </div>
      )}
    </>
  );
}

function ListHeader({ label, count, total }: { label: string; count: number; total: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClear = () => {
    if (total === 0) return;
    if (!confirm(`Delete all ${total} tickets in this workspace?`)) return;
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
    <div className="flex items-center gap-2 border-b border-neutral-200 px-5 py-4">
      <span className="text-[15px] font-medium text-neutral-900">{label}</span>
      <span className="text-[13px] text-neutral-400">{count}</span>
      <button
        onClick={onClear}
        disabled={pending || total === 0}
        title="Delete every ticket in this workspace"
        className="ml-auto flex items-center gap-1 text-[12px] text-neutral-400 transition-colors hover:text-rose-600 disabled:opacity-30 disabled:hover:text-neutral-400"
      >
        <Trash2 size={12} />
        {pending ? "clearing…" : "clear all"}
      </button>
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </div>
  );
}

function TicketRow({
  ticket,
  active,
  onSelect,
}: {
  ticket: Ticket;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        "flex w-full gap-3.5 border-l-[3px] px-5 py-3.5 text-left transition-colors",
        active
          ? "border-blue-600 bg-blue-50/60"
          : "border-transparent hover:bg-neutral-50",
      )}
    >
      <span
        className={clsx(
          "mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full text-[12px] font-semibold text-white",
          avatarColor(ticket.reporter),
        )}
      >
        {initialsOf(ticket.reporter)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-neutral-900">{ticket.reporter}</span>
          <span className="ml-auto flex-none text-[11px] text-neutral-400">{timeAgo(ticket.createdAt)}</span>
        </span>
        <span
          className={clsx(
            "mt-0.5 block truncate text-[14px]",
            active ? "font-medium text-neutral-900" : "text-neutral-800",
          )}
        >
          {ticket.subject}
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-neutral-500">{ticket.body}</span>
        <span
          className={clsx(
            "mt-2 inline-block rounded-full px-2.5 py-1 text-[11px] font-medium",
            TONE_PILL[toneOf(ticket.status)],
          )}
        >
          {staffStatusLabel(ticket.status)}
        </span>
      </span>
    </button>
  );
}
