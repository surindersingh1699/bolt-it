"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import clsx from "clsx";
import {
  Check,
  ChevronLeft,
  Image as ImageIcon,
  Loader2,
  LogOut,
  Paperclip,
  Plus,
  SendHorizontal,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import {
  chatWithAgent,
  confirmTicketResolved,
  createTicket,
  deleteTicketAction,
  escalateAfterUserDenied,
} from "@/app/actions/tickets";
import { attachToTicket } from "@/app/actions/attachments";
import { MAX_ATTACHMENTS_PER_CALL as MAX_SCREENSHOTS } from "@/lib/attachments";
import { classifyConfirmation } from "@/lib/chat";
import { parseMrkdwn } from "@/lib/mrkdwn";
import { PlanStep, PublicUser, Ticket } from "@/lib/types";
import { useAppState } from "./StateProvider";
import {
  avatarColor,
  clockTime,
  employeeStatusLabel,
  initialsOf,
  proofOf,
  reconcileSelection,
  TONE_PILL,
  toneOf,
} from "./ticket-view";

const BOT_NAME = "Bolt IT";
const OPEN_STATUSES = new Set(["new", "drafting", "awaiting_approval", "executing", "awaiting_confirmation"]);
const BUSY_STATUSES = new Set(["new", "drafting", "executing"]);

/**
 * The desk posts two different things down one channel: sentences written for
 * the person, and a running note of what the agent is doing right now, marked
 * with a wrench or a pause. Rendered identically they became one wall of prose
 * — the reader could not tell the explanation from the progress, and both got
 * skimmed. The marker is the only thing that separates them, so it is read here
 * and thrown away before the text is shown.
 */
const ACTIVITY_MARKERS = ["\u{1F527}", "⏸"];

interface Row {
  key: string;
  from: "user" | "agent";
  at: number;
  text: string;
  /** "activity" is a live progress note; "prose" is something said to them. */
  kind: "prose" | "activity";
}

function classify(from: "user" | "agent", text: string): { kind: Row["kind"]; text: string } {
  const marker = from === "agent" && ACTIVITY_MARKERS.find((m) => text.startsWith(m));
  if (!marker) return { kind: "prose", text };
  return { kind: "activity", text: text.slice(marker.length).trim().replace(/…$/, "") };
}

/** How far along a ticket is, for the rail item and the thread header. */
function progressOf(ticket: Ticket): { done: number; total: number; pct: number } {
  const steps = ticket.plan.filter((s) => s.kind !== "reply");
  const total = steps.length;
  const done = steps.filter((s) => s.status === "succeeded" || s.status === "failed").length;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * The employee helpdesk. A left rail of the person's own tickets, each with its
 * live progress, and a thread per ticket they can keep working. A new problem is
 * a new ticket — so several can be open and worked in parallel, which the single
 * flat channel could not express.
 *
 * Same server actions as before (createTicket / chatWithAgent / confirm), so this
 * is a new surface over identical routing, not a second code path.
 */
export function EmployeePortal({ currentUser }: { currentUser: PublicUser }) {
  const { tickets } = useAppState();

  const mine = useMemo(
    () =>
      tickets
        .filter((t) => t.reporterEmail === currentUser.email)
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [tickets, currentUser.email],
  );

  // `null` selection with composeNew=true is the "start a new ticket" state.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeNew, setComposeNew] = useState(false);

  // A ticket this person just filed, which the 600ms poll has not returned yet.
  // Held in a ref rather than state: it must not itself cause a render, and the
  // reconciler below has to see the current value on the very next one.
  const awaitingId = useRef<string | null>(null);

  // Keep a valid selection as tickets arrive. Default to the most recently
  // touched one; fall back to the new-issue screen when the person has none.
  useEffect(() => {
    if (composeNew) return;
    const decision = reconcileSelection({
      selectedId,
      awaitingId: awaitingId.current,
      ids: mine.map((t) => t.id),
      firstOpenId: (mine.find((t) => OPEN_STATUSES.has(t.status)) ?? mine[0])?.id ?? null,
    });
    if (decision.clearAwaiting) awaitingId.current = null;
    if (decision.kind === "select") setSelectedId(decision.id);
    if (decision.kind === "compose") setComposeNew(true);
  }, [mine, selectedId, composeNew]);

  const selected = mine.find((t) => t.id === selectedId) ?? null;

  const openTicket = (id: string) => {
    setComposeNew(false);
    setSelectedId(id);
  };
  /**
   * A ticket filed from this browser. Distinct from `openTicket` because the row
   * does not exist as far as the poll is concerned yet, and the reconciler needs
   * to be told to hold this selection rather than repair it to the newest
   * existing ticket — which is what used to drop the person on their last one.
   */
  const openCreatedTicket = (id: string) => {
    awaitingId.current = id;
    openTicket(id);
  };
  const startNew = () => {
    setComposeNew(true);
    setSelectedId(null);
  };

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 bg-neutral-50">
      <Rail
        currentUser={currentUser}
        tickets={mine}
        selectedId={composeNew ? null : selectedId}
        onOpen={openTicket}
        onNew={startNew}
      />

      <main className={clsx("min-w-0 flex-1 flex-col bg-white", selected || composeNew ? "flex" : "hidden sm:flex")}>
        {composeNew || !selected ? (
          <NewIssue
            currentUser={currentUser}
            hasTickets={mine.length > 0}
            onBack={mine.length > 0 ? () => setComposeNew(false) : undefined}
            onCreated={openCreatedTicket}
          />
        ) : (
          <TicketThread ticket={selected} currentUser={currentUser} onCreated={openCreatedTicket} />
        )}
      </main>
    </div>
  );
}

// ─── Left rail: the person's tickets ─────────────────────────────────────────

function Rail({
  currentUser,
  tickets,
  selectedId,
  onOpen,
  onNew,
}: {
  currentUser: PublicUser;
  tickets: Ticket[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <nav className="flex w-full flex-none flex-col border-r border-neutral-200 bg-white sm:w-[300px]">
      <div className="flex items-center gap-2.5 border-b border-neutral-200 px-4 py-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-blue-600 text-white">
          <Zap size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-bold leading-tight text-neutral-900">IT Support</div>
          <div className="truncate text-[12px] text-neutral-500">{currentUser.name}</div>
        </div>
        <form action={logoutAction} className="flex-none">
          <button
            type="submit"
            title="Sign out"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
          >
            <LogOut size={15} />
          </button>
        </form>
      </div>

      <div className="px-3 pt-3">
        <button
          onClick={onNew}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-blue-700"
        >
          <Plus size={16} /> Report an issue
        </button>
      </div>

      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
          Your tickets
        </div>
        {tickets.length === 0 ? (
          <p className="px-2 py-3 text-[13px] leading-5 text-neutral-500">
            No tickets yet. Report an issue and it shows up here.
          </p>
        ) : (
          <ul className="space-y-1">
            {tickets.map((t) => (
              <RailItem key={t.id} ticket={t} active={t.id === selectedId} onClick={() => onOpen(t.id)} />
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

function RailItem({ ticket, active, onClick }: { ticket: Ticket; active: boolean; onClick: () => void }) {
  const { done, total, pct } = progressOf(ticket);
  const busy = BUSY_STATUSES.has(ticket.status);
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  // The poll in StateProvider refreshes the list, so the row simply disappears
  // once the delete lands — no local removal to keep in sync.
  const remove = () =>
    startTransition(async () => {
      await deleteTicketAction(ticket.id).catch(() => {});
    });

  return (
    <li className="group relative">
      <button
        onClick={onClick}
        className={clsx(
          "w-full rounded-lg border px-3 py-2.5 text-left transition-colors",
          active ? "border-blue-200 bg-blue-50" : "border-transparent hover:bg-neutral-50",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-neutral-900">
            {ticket.subject}
          </span>
          {busy && <Loader2 size={12} className="flex-none animate-spin text-blue-600" />}
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={clsx(
              "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
              TONE_PILL[toneOf(ticket.status)],
            )}
          >
            {employeeStatusLabel(ticket.status)}
          </span>
          <span className="ml-auto flex-none text-[11px] text-neutral-400">
            {ticket.id}
          </span>
        </div>
        {total > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200">
              <div
                className={clsx("h-full rounded-full transition-all", ticket.status === "escalated" ? "bg-amber-500" : "bg-blue-600")}
                style={{ width: `${Math.max(pct, done > 0 ? 8 : 0)}%` }}
              />
            </div>
            <span className="flex-none text-[10.5px] tabular-nums text-neutral-400">
              {done}/{total}
            </span>
          </div>
        )}
      </button>

      {/* Delete: a sibling of the row button (nesting buttons is invalid), shown
          on hover, with a two-step inline confirm so a stray click can't wipe a
          ticket. */}
      {confirming ? (
        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-white/95 px-1 shadow-sm ring-1 ring-neutral-200">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              remove();
            }}
            disabled={pending}
            title="Delete this ticket"
            aria-label="Confirm delete"
            className="rounded p-1 text-red-600 hover:bg-red-50"
          >
            {pending ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={3} />}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(false);
            }}
            title="Keep it"
            aria-label="Cancel delete"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100"
          >
            <X size={13} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirming(true);
          }}
          title="Delete ticket"
          aria-label="Delete ticket"
          className="absolute right-1.5 top-1.5 rounded p-1 text-neutral-300 opacity-0 transition hover:bg-neutral-100 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
        >
          <Trash2 size={13} />
        </button>
      )}
    </li>
  );
}

// ─── New issue ───────────────────────────────────────────────────────────────

function NewIssue({
  currentUser,
  hasTickets,
  onBack,
  onCreated,
}: {
  currentUser: PublicUser;
  hasTickets: boolean;
  onBack?: () => void;
  onCreated: (id: string) => void;
}) {
  const [pending, startTransition] = useTransition();

  const submit = (text: string, files: File[]) => {
    startTransition(async () => {
      // The files go with the create call rather than after it: the graph starts
      // the moment the ticket row exists, and its first look reads the images.
      const formData = new FormData();
      for (const f of files) formData.append("file", f);
      const id = await createTicket(
        {
          reporter: currentUser.name,
          reporterEmail: currentUser.email,
          subject: text.split(/[.\n!?]/)[0].slice(0, 80) || "IT issue",
          body: text,
          channel: "portal",
        },
        formData,
      );
      onCreated(id);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-none items-center gap-2 border-b border-neutral-200 px-4 py-3">
        {onBack && (
          <button
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 hover:bg-neutral-100 sm:hidden"
            title="Back"
          >
            <ChevronLeft size={17} />
          </button>
        )}
        <div className="text-[15px] font-bold text-neutral-900">Report an issue</div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
        <div className="w-full max-w-lg text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-600 text-white">
            <Zap size={26} />
          </div>
          <h1 className="mt-4 text-[22px] font-bold text-neutral-900">What&apos;s going wrong?</h1>
          <p className="mx-auto mt-1.5 max-w-md text-[14px] leading-6 text-neutral-600">
            Describe it in your own words — no forms, no categories. {BOT_NAME} checks your
            actual machine, fixes what it can, and shows you the proof. {hasTickets ? "This starts a new ticket." : ""}
          </p>
        </div>
      </div>

      <Composer placeholder="Describe your issue…" pending={pending} onSend={submit} autoFocus />
    </div>
  );
}

// ─── One ticket's thread ─────────────────────────────────────────────────────

function TicketThread({
  ticket,
  currentUser,
  onCreated,
}: {
  ticket: Ticket;
  currentUser: PublicUser;
  onCreated: (id: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const busy = BUSY_STATUSES.has(ticket.status);
  const awaiting = ticket.status === "awaiting_confirmation";

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [
      { key: `${ticket.id}-body`, from: "user", at: ticket.createdAt, text: ticket.body, kind: "prose" },
    ];
    (ticket.chat ?? []).forEach((m, i) =>
      out.push({ key: `${ticket.id}-chat-${i}`, from: m.from, at: m.at, ...classify(m.from, m.text) }),
    );
    return out.sort((a, b) => a.at - b.at);
  }, [ticket]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rows.length, ticket.status, ticket.plan.length]);

  const send = (text: string, files: File[]) => {
    // On a ticket waiting for confirmation, a plain "yes" closes it — there is
    // nothing left to say and a model call to confirm that would be waste.
    //
    // "No" deliberately does NOT short-circuit any more. It used to escalate on
    // the spot, which meant the one message that carries the most information —
    // what is still happening — was never read by anything. It goes through the
    // desk instead, which answers it and classifies it as `still_broken`.
    if (awaiting && classifyConfirmation(text) === "yes") {
      return startTransition(() => confirmTicketResolved(ticket.id));
    }
    startTransition(async () => {
      if (files.length > 0) {
        const formData = new FormData();
        for (const f of files) formData.append("file", f);
        await attachToTicket(ticket.id, formData);
      }
      const routed = await chatWithAgent(ticket.id, text);
      // The agent decided this message is really a different problem: it becomes
      // its own ticket, and we switch the person to it.
      if (routed === "new_ticket") {
        const id = await createTicket({
          reporter: currentUser.name,
          reporterEmail: currentUser.email,
          subject: text.split(/[.\n!?]/)[0].slice(0, 80) || "IT issue",
          body: text,
          channel: "portal",
        });
        onCreated(id);
      }
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadHeader ticket={ticket} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-5">
          {ticket.plan.length > 0 && <ProgressCard ticket={ticket} />}

          <div className="mt-4">
            {rows.map((row, i) => {
              const prev = rows[i - 1];
              // Grouping now only decides whether the name and avatar repeat.
              // It used to decide whether the bubble repeated too, and since a
              // ticket's whole life fits inside the five-minute window, every
              // agent message merged into the one before it — the wall of text.
              const grouped = Boolean(prev && prev.from === row.from && prev.kind === row.kind);
              return (
                <Message
                  key={row.key}
                  row={row}
                  grouped={grouped}
                  userName={currentUser.name}
                  live={row.kind === "activity" && i === rows.length - 1 && busy}
                />
              );
            })}
          </div>

          {awaiting && <ConfirmBlock ticket={ticket} />}
          {busy && (
            <div className="mt-3 flex items-center gap-2 pl-11 text-[12.5px] italic text-neutral-400">
              <Loader2 size={12} className="animate-spin" /> {BOT_NAME} is working on it…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      <Composer
        placeholder={awaiting ? "Reply, or tell me if it's still broken…" : `Message about ${ticket.id}…`}
        pending={pending}
        onSend={send}
      />
    </div>
  );
}

function ThreadHeader({ ticket }: { ticket: Ticket }) {
  return (
    <header className="flex flex-none items-start gap-3 border-b border-neutral-200 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-bold text-neutral-900">{ticket.subject}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[12px] text-neutral-400">
          <span>{ticket.id}</span>
        </div>
      </div>
      <span
        className={clsx("flex-none rounded-full px-2.5 py-1 text-[11px] font-medium", TONE_PILL[toneOf(ticket.status)])}
      >
        {employeeStatusLabel(ticket.status)}
      </span>
    </header>
  );
}

/** The plan + proof-of-effect, shown inline at the top of the thread. */
function ProgressCard({ ticket }: { ticket: Ticket }) {
  const { done, total } = progressOf(ticket);
  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-semibold uppercase tracking-wide text-neutral-500">Progress</span>
        {total > 0 && <span className="text-[12px] tabular-nums text-neutral-400">{done}/{total} steps</span>}
      </div>
      <div className="mt-3 space-y-3">
        {ticket.plan.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </div>
    </div>
  );
}

function StepRow({ step }: { step: PlanStep }) {
  const proof = proofOf(step);
  const done = step.status === "succeeded";
  const failed = step.status === "failed";
  const running = step.status === "running";
  const waiting = step.approvalMode === "human" && step.status === "pending";

  return (
    <div className="flex gap-2.5">
      <span
        className={clsx(
          "mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full text-white",
          done ? "bg-emerald-600" : failed ? "bg-rose-600" : running || waiting ? "bg-blue-600" : "bg-neutral-300",
        )}
      >
        {done ? <Check size={11} strokeWidth={3} /> : running ? <Loader2 size={10} className="animate-spin" /> : null}
      </span>
      <div className="min-w-0">
        <div
          className={clsx(
            "text-[13px] leading-5",
            waiting || running ? "font-medium text-blue-700" : done || failed ? "text-neutral-800" : "text-neutral-400",
          )}
        >
          {step.description}
        </div>
        {waiting && (
          <div className="mt-0.5 text-[12px] leading-5 text-neutral-500">
            Waiting on IT approval — nothing else changes on your machine.
          </div>
        )}
        {proof && (
          <div className={clsx("mt-0.5 text-[12px] leading-5", proof.changed ? "text-emerald-700" : "text-amber-700")}>
            {proof.changed ? "Confirmed: " : "Heads up: "}
            {proof.text}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One message, one bubble — the shape the staff side already uses.
 *
 * The person reading this is not reading a transcript, they are checking on
 * their own broken laptop between other things. Every message needs its own
 * edge and its own time, so a glance can find where the last one ended.
 */
function Message({
  row,
  grouped,
  userName,
  live,
}: {
  row: Row;
  grouped: boolean;
  userName: string;
  live: boolean;
}) {
  const isBot = row.from === "agent";

  // A progress note is not a sentence addressed to the reader, so it does not
  // get a speech bubble. It is a line of work, and it reads as one.
  if (row.kind === "activity") {
    return (
      <div className="bolt-message-in mt-1.5 flex gap-2.5 pl-[46px]">
        <div
          className={clsx(
            "flex min-w-0 items-start gap-2 rounded-lg bg-neutral-50 px-3 py-2 ring-1 ring-neutral-200/70",
            live && "bolt-activity-live",
          )}
        >
          {live ? (
            <Loader2 size={13} className="mt-0.5 flex-none animate-spin text-blue-600" />
          ) : (
            <Wrench size={13} className="mt-0.5 flex-none text-neutral-400" />
          )}
          <span className="min-w-0 break-words text-[13px] leading-5 text-neutral-600">
            <Mrkdwn text={row.text} />
          </span>
          <span className="mt-0.5 flex-none text-[10.5px] tabular-nums text-neutral-400">
            {clockTime(row.at)}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={clsx("bolt-message-in flex gap-2.5", grouped ? "mt-1" : "mt-3.5")}>
      <div className="w-9 flex-none">
        {!grouped &&
          (isBot ? (
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-white">
              <Zap size={16} />
            </span>
          ) : (
            <span
              className={clsx(
                "flex h-9 w-9 items-center justify-center rounded-lg text-[13px] font-semibold text-white",
                avatarColor(userName),
              )}
            >
              {initialsOf(userName)}
            </span>
          ))}
      </div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-[13.5px] font-bold text-neutral-900">{isBot ? BOT_NAME : userName}</span>
            {isBot && (
              <span className="rounded bg-neutral-200 px-1 py-px text-[10px] font-semibold text-neutral-600">APP</span>
            )}
          </div>
        )}
        <div
          className={clsx(
            "inline-block max-w-full rounded-2xl px-4 py-2.5 text-[14px] leading-[1.6]",
            isBot ? "bg-neutral-100 text-neutral-800" : "bg-blue-600 text-white",
          )}
        >
          <div className="whitespace-pre-wrap break-words">
            <Mrkdwn text={row.text} />
          </div>
          <div className={clsx("mt-1 text-[10.5px] tabular-nums", isBot ? "text-neutral-400" : "text-blue-100")}>
            {clockTime(row.at)}
          </div>
        </div>
      </div>
    </div>
  );
}

function Mrkdwn({ text }: { text: string }) {
  return (
    <>
      {parseMrkdwn(text).map((span, i) => {
        if (span.kind === "bold") return <strong key={i} className="font-bold">{span.text}</strong>;
        if (span.kind === "italic") return <em key={i}>{span.text}</em>;
        if (span.kind === "code")
          return (
            <code
              key={i}
              className="rounded border border-neutral-200 bg-neutral-50 px-1 py-px font-mono text-[13px] text-rose-700"
            >
              {span.text}
            </code>
          );
        return <span key={i}>{span.text}</span>;
      })}
    </>
  );
}

function ConfirmBlock({ ticket }: { ticket: Ticket }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="mt-3 flex gap-2.5 px-2">
      <div className="w-9 flex-none" />
      <div className="rounded-xl border border-neutral-200 bg-white p-3">
        <div className="text-[13.5px] text-neutral-700">
          Only you can close this — is it actually fixed?
        </div>
        <div className="mt-1 text-[12.5px] text-neutral-500">
          If it isn&apos;t, tell me what you&apos;re still seeing and I&apos;ll take another look.
        </div>
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => startTransition(() => confirmTicketResolved(ticket.id))}
            disabled={pending}
            className="rounded-lg bg-emerald-600 px-3.5 py-1.5 text-[13.5px] font-semibold text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
          >
            Yes, it&apos;s working
          </button>
          <button
            onClick={() => startTransition(() => escalateAfterUserDenied(ticket.id))}
            disabled={pending}
            className="rounded-lg border border-neutral-300 bg-white px-3.5 py-1.5 text-[13.5px] font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
          >
            No, still broken
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared composer ─────────────────────────────────────────────────────────

function Composer({
  placeholder,
  pending,
  onSend,
  autoFocus,
}: {
  placeholder: string;
  pending: boolean;
  onSend: (text: string, files: File[]) => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const addFiles = (incoming: FileList | File[] | null) => {
    if (!incoming) return;
    const images = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
    if (images.length > 0) setFiles((prev) => [...prev, ...images].slice(0, MAX_SCREENSHOTS));
  };

  const submit = () => {
    const text = draft.trim();
    // A screenshot on its own is a valid report — people paste the error and
    // nothing else, and asking them to also type something is friction for no
    // reason. The strategist can see it.
    if (!text && files.length === 0) return;
    setDraft("");
    setFiles([]);
    onSend(text || "See the attached screenshot.", files);
  };

  return (
    <div className="flex-none px-5 pb-5">
      {files.length > 0 && (
        <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
          {files.map((f, i) => (
            <span
              key={`${f.name}-${i}`}
              className="flex items-center gap-1.5 rounded-lg bg-neutral-100 py-1 pl-2.5 pr-1.5 text-[12.5px] text-neutral-700"
            >
              <ImageIcon size={13} className="flex-none text-neutral-500" />
              <span className="max-w-[180px] truncate">{f.name}</span>
              <button
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                className="flex h-5 w-5 flex-none items-center justify-center rounded text-neutral-500 hover:bg-neutral-200"
                title="Remove"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border border-neutral-300 px-3.5 py-2.5 focus-within:border-blue-500">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          title="Attach a screenshot"
          className="mb-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100"
        >
          <Paperclip size={15} />
        </button>
        <textarea
          ref={boxRef}
          rows={1}
          value={draft}
          autoFocus={autoFocus}
          onChange={(e) => setDraft(e.target.value)}
          onPaste={(e) => {
            // Screenshot straight out of the clipboard is how people actually
            // send these — Cmd-Shift-4 then Cmd-V, never a file picker.
            const pasted = Array.from(e.clipboardData.files);
            if (pasted.length > 0) {
              e.preventDefault();
              addFiles(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          className="max-h-40 flex-1 resize-none bg-transparent py-1 text-[14.5px] leading-6 text-neutral-900 outline-none placeholder:text-neutral-400"
        />
        <button
          onClick={submit}
          disabled={pending || (!draft.trim() && files.length === 0)}
          title="Send"
          className="mb-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:opacity-30"
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <SendHorizontal size={14} />}
        </button>
      </div>
    </div>
  );
}
