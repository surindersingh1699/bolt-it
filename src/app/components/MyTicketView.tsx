"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import clsx from "clsx";
import { Check, Loader2, Send } from "lucide-react";
import {
  chatWithAgent,
  confirmTicketResolved,
  createTicket,
  escalateAfterUserDenied,
} from "@/app/actions/tickets";
import { classifyConfirmation } from "@/lib/chat";
import { PlanStep, PublicUser, Ticket } from "@/lib/types";
import { useAppState } from "./StateProvider";
import {
  clockTime,
  employeeStatusBlurb,
  employeeStatusLabel,
  proofOf,
  timeAgo,
  TONE_PILL,
  toneOf,
} from "./ticket-view";

const OPEN_STATUSES = new Set(["new", "drafting", "awaiting_approval", "executing", "awaiting_confirmation"]);

/**
 * The employee half. One question is being answered here: who is waiting on
 * what, and when am I unblocked? Everything the technician needs and the
 * reporter does not — capability ids, risk tiers, graph nodes — stays out.
 */
export function MyTicketView({ currentUser }: { currentUser: PublicUser }) {
  const { tickets } = useAppState();
  const mine = tickets
    .filter((t) => t.reporterEmail === currentUser.email)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const open = mine.find((t) => OPEN_STATUSES.has(t.status));
  const [pickedId, setPickedId] = useState<string | null>(null);
  const ticket = mine.find((t) => t.id === pickedId) ?? open ?? mine[0];

  return (
    <div className="mx-auto w-full max-w-xl px-5 pb-16 pt-6">
      {ticket ? (
        <TicketCard ticket={ticket} />
      ) : (
        <div className="rounded-2xl bg-blue-50 p-6">
          <h1 className="text-[20px] leading-snug text-neutral-900">Something not working?</h1>
          <p className="mt-2 text-[14px] leading-7 text-neutral-600">
            Tell us in your own words. Plain English is fine — no ticket form, no category to pick.
          </p>
        </div>
      )}

      <Composer currentUser={currentUser} ticket={ticket} />

      {mine.length > 1 && (
        <div className="mt-9">
          <div className="text-[12px] text-neutral-500">Your other tickets</div>
          <div className="mt-2 divide-y divide-neutral-200 rounded-xl border border-neutral-200">
            {mine
              .filter((t) => t.id !== ticket?.id)
              .slice(0, 6)
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => setPickedId(t.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-neutral-800">{t.subject}</span>
                    <span className="block text-[12px] text-neutral-400">{timeAgo(t.createdAt)}</span>
                  </span>
                  <span
                    className={clsx(
                      "flex-none rounded-full px-2.5 py-1 text-[11px] font-medium",
                      TONE_PILL[toneOf(t.status)],
                    )}
                  >
                    {employeeStatusLabel(t.status)}
                  </span>
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }) {
  const [pending, startTransition] = useTransition();
  const tone = toneOf(ticket.status);

  return (
    <>
      <div
        className={clsx(
          "rounded-2xl p-6",
          tone === "green" ? "bg-emerald-50" : tone === "red" ? "bg-rose-50" : "bg-blue-50",
        )}
      >
        <div
          className={clsx(
            "text-[11px] font-semibold uppercase tracking-wider",
            tone === "green" ? "text-emerald-700" : tone === "red" ? "text-rose-700" : "text-blue-700",
          )}
        >
          {employeeStatusLabel(ticket.status)}
        </div>
        <h1 className="mt-2 text-[20px] leading-snug text-neutral-900">{ticket.subject}</h1>
        <p className="mt-1.5 text-[14px] leading-7 text-neutral-600">{employeeStatusBlurb(ticket)}</p>
      </div>

      {ticket.status === "awaiting_confirmation" && (
        <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-5">
          <div className="text-[15px] font-semibold text-amber-900">Is it actually fixed?</div>
          <p className="mt-1 text-[13.5px] leading-6 text-amber-900/80">
            We only close this if you say it worked.
          </p>
          <button
            onClick={() => startTransition(() => confirmTicketResolved(ticket.id))}
            disabled={pending}
            className="mt-4 w-full rounded-full bg-blue-600 px-5 py-3 text-[14.5px] font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            Yes, it&apos;s working
          </button>
          <button
            onClick={() => startTransition(() => escalateAfterUserDenied(ticket.id))}
            disabled={pending}
            className="mt-2.5 w-full rounded-full border border-neutral-300 bg-white px-5 py-3 text-[14px] text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
          >
            No, still broken
          </button>
        </div>
      )}

      {ticket.plan.length > 0 && <Stepper ticket={ticket} />}

      {ticket.chat && ticket.chat.length > 0 && (
        <div className="mt-7 space-y-2.5">
          {ticket.chat.map((m, i) => (
            <div
              key={i}
              className={clsx(
                "max-w-[88%] rounded-2xl px-4 py-2.5 text-[14px] leading-6",
                m.from === "agent" ? "bg-neutral-100 text-neutral-800" : "ml-auto bg-blue-600 text-white",
              )}
            >
              {m.text}
              <div className={clsx("mt-1 text-[10px]", m.from === "agent" ? "text-neutral-400" : "text-blue-100")}>
                {clockTime(m.at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Stepper({ ticket }: { ticket: Ticket }) {
  return (
    <div className="relative mt-7 pl-8">
      <div className="absolute bottom-5 left-[10px] top-2 w-0.5 bg-neutral-200" />
      {ticket.plan.map((step) => (
        <StepperRow key={step.id} step={step} />
      ))}
    </div>
  );
}

function StepperRow({ step }: { step: PlanStep }) {
  const proof = proofOf(step);
  const done = step.status === "succeeded";
  const failed = step.status === "failed";
  const running = step.status === "running";
  const waiting = step.approvalMode === "human" && step.status === "pending";

  return (
    <div className="relative pb-6">
      <span
        className={clsx(
          "absolute -left-8 top-0 flex h-[22px] w-[22px] items-center justify-center rounded-full border-[3px] border-white text-[11px] text-white",
          done ? "bg-emerald-600" : failed ? "bg-rose-600" : running || waiting ? "bg-blue-600" : "bg-neutral-300",
        )}
      >
        {done ? <Check size={12} strokeWidth={3} /> : running ? <Loader2 size={11} className="animate-spin" /> : null}
      </span>
      <div
        className={clsx(
          "text-[14.5px] leading-6",
          waiting || running ? "font-medium text-blue-700" : done || failed ? "text-neutral-800" : "text-neutral-400",
        )}
      >
        {step.description}
      </div>
      {waiting && (
        <div className="mt-1 text-[13px] leading-6 text-neutral-500">
          Waiting on IT to approve. This changes nothing else on your machine.
        </div>
      )}
      {proof && (
        <div className={clsx("mt-1 text-[13px] leading-6", proof.changed ? "text-emerald-700" : "text-amber-700")}>
          {proof.changed ? "Confirmed: " : "Heads up: "}
          {proof.text}
        </div>
      )}
    </div>
  );
}

/**
 * One box for everything the reporter says. A yes/no while we are waiting on
 * confirmation answers that question; anything else goes to the agent, which
 * files a fresh ticket itself if the message turns out to be a different issue.
 */
function Composer({ currentUser, ticket }: { currentUser: PublicUser; ticket?: Ticket }) {
  const { tickets } = useAppState();
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const boxRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");

    const awaiting = tickets
      .filter((t) => t.reporterEmail === currentUser.email && t.status === "awaiting_confirmation")
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (awaiting) {
      const verdict = classifyConfirmation(body);
      if (verdict !== "ambiguous") {
        startTransition(async () => {
          if (verdict === "yes") await confirmTicketResolved(awaiting.id);
          else await escalateAfterUserDenied(awaiting.id);
        });
        return;
      }
    }

    const recent = tickets
      .filter((t) => t.reporterEmail === currentUser.email && Date.now() - t.updatedAt < 30 * 60 * 1000)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    startTransition(async () => {
      if (recent) {
        const routed = await chatWithAgent(recent.id, body);
        if (routed === "chat") return;
      }
      await createTicket({
        reporter: currentUser.name,
        reporterEmail: currentUser.email,
        subject: body.split(/[.\n!?]/)[0].slice(0, 80) || "IT issue",
        body,
        channel: "slack",
      });
    });
  };

  return (
    <div className="mt-6">
      <div className="flex items-end gap-2 rounded-3xl border border-neutral-300 bg-white px-5 py-3 focus-within:border-blue-600">
        <textarea
          ref={boxRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={ticket ? "Reply, or tell us about something else…" : "What's broken?"}
          className="max-h-40 flex-1 resize-none bg-transparent py-1 text-[15px] leading-7 text-neutral-900 outline-none placeholder:text-neutral-400"
        />
        <button
          onClick={send}
          disabled={pending || !draft.trim()}
          className="mb-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-blue-600 text-white transition-colors hover:bg-blue-700 disabled:opacity-30"
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}
