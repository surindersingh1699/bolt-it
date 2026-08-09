"use client";

import { useEffect, useState, useTransition } from "react";
import clsx from "clsx";
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleAlert,
  Loader2,
  Lock,
  MessageSquare,
} from "lucide-react";
import { approveAndExecute, escalateTicket } from "@/app/actions/tickets";
import { AgentJob, PlanStep, PublicUser, Ticket } from "@/lib/types";
import { Evidence } from "./Evidence";
import {
  avatarColor,
  clockTime,
  gatedStepOf,
  initialsOf,
  proofOf,
  staffStatusLabel,
  timeAgo,
  TONE_PILL,
  toneOf,
} from "./ticket-view";

export function TicketDetail({
  ticket,
  currentUser,
}: {
  ticket: Ticket;
  currentUser: PublicUser;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const gated = gatedStepOf(ticket);
  const awaiting = ticket.status === "awaiting_approval";

  const run = (fn: () => Promise<void>, fallback: string) => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (err) {
        setError((err as Error).message || fallback);
      }
    });
  };

  return (
    <div className="flex-1 min-w-0 overflow-y-auto">
      <div className="px-8 py-7 max-w-3xl">
        <h1 className="text-[22px] leading-tight text-neutral-900">{ticket.subject}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-2.5 text-[13px] text-neutral-500">
          <span
            className={clsx(
              "flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white",
              avatarColor(ticket.reporter),
            )}
          >
            {initialsOf(ticket.reporter)}
          </span>
          <span className="text-neutral-700">{ticket.reporter}</span>
          <span>·</span>
          <span>{ticket.reporterEmail}</span>
          <span>·</span>
          <span>reported {timeAgo(ticket.createdAt)}</span>
          <span className={clsx("rounded-full px-2.5 py-1 text-[11px] font-medium", TONE_PILL[toneOf(ticket.status)])}>
            {staffStatusLabel(ticket.status)}
          </span>
        </div>

        <p className="mt-5 border-l-2 border-neutral-200 pl-4 text-[14px] leading-7 text-neutral-600">
          {ticket.body}
        </p>

        {ticket.draftResponse && (
          <div className="mt-6 rounded-xl bg-neutral-50 p-5">
            <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
              What we think is wrong
            </div>
            <p className="mt-2 text-[14px] leading-7 text-neutral-800">{ticket.draftResponse}</p>
          </div>
        )}

        <div className="mt-7">
          {awaiting && gated && (
            <ApprovalCard
              key="primary-approval-card"
              step={gated}
              canApprove={currentUser.isITStaff}
              pending={pending}
              onApprove={() => run(() => approveAndExecute(ticket.id), "Approval failed.")}
              onEscalate={() => run(() => escalateTicket(ticket.id), "Escalation failed.")}
            />
          )}

          {ticket.plan.length === 0 ? (
            <div className="flex items-center gap-2 py-3 text-[14px] text-neutral-500">
              <Loader2 size={15} className="animate-spin" />
              Working out what to do…
            </div>
          ) : (
            ticket.plan.map((step) =>
              step === gated && awaiting ? null : <StepRow key={step.id} step={step} />,
            )
          )}
        </div>

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-rose-50 px-4 py-3 text-[13px] text-rose-700">
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        {ticket.status === "resolved" && (
          <Banner tone="green">
            Fixed in {Math.round((ticket.resolutionTimeMs ?? 0) / 1000)}s. What worked was saved to this
            person&apos;s history, so the next one like it starts ahead.
          </Banner>
        )}
        {ticket.status === "escalated" && (
          <Banner tone="red">Handed to a person. Nothing further will run automatically on this ticket.</Banner>
        )}

        {ticket.citations.length > 0 && (
          <div className="mt-8 border-t border-neutral-200 pt-5">
            <div className="text-[12px] text-neutral-500">What we already knew about {ticket.reporter.split(" ")[0]}</div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {ticket.citations.map((c) => (
                <div key={c.ref} className="rounded-lg border border-neutral-200 p-3">
                  <div className="text-[13px] font-medium text-blue-700">{c.title}</div>
                  <p className="mt-1 line-clamp-3 text-[12px] leading-relaxed text-neutral-500">{c.snippet}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {ticket.chat && ticket.chat.length > 0 && (
          <div className="mt-8 border-t border-neutral-200 pt-5">
            <div className="flex items-center gap-2 text-[12px] text-neutral-500">
              <MessageSquare size={13} />
              Conversation with {ticket.reporter.split(" ")[0]}
            </div>
            <div className="mt-3 space-y-2.5">
              {ticket.chat.map((m, i) => (
                <div
                  key={i}
                  className={clsx(
                    "max-w-[85%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-6",
                    m.from === "agent"
                      ? "bg-neutral-100 text-neutral-800"
                      : "ml-auto bg-blue-600 text-white",
                  )}
                >
                  {m.text}
                  <div
                    className={clsx(
                      "mt-1 text-[10px]",
                      m.from === "agent" ? "text-neutral-400" : "text-blue-100",
                    )}
                  >
                    {clockTime(m.at)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <TechnicalDetail ticket={ticket} />
      </div>
    </div>
  );
}

function ApprovalCard({
  step,
  canApprove,
  pending,
  onApprove,
  onEscalate,
}: {
  step: PlanStep;
  canApprove: boolean;
  pending: boolean;
  onApprove: () => void;
  onEscalate: () => void;
}) {
  return (
    <div className="my-3 rounded-2xl border border-blue-600 bg-blue-50 p-5">
      <div className="text-[15px] font-medium text-blue-900">One step needs your OK</div>
      <p className="mt-1.5 text-[14px] leading-7 text-neutral-700">{step.description}</p>
      {step.riskReason && <p className="mt-1 text-[12.5px] text-neutral-500">{step.riskReason}</p>}
      {canApprove ? (
        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <button
            onClick={onApprove}
            disabled={pending}
            className="rounded-full bg-blue-600 px-6 py-2.5 text-[13.5px] font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {pending ? "Approving…" : "Approve & finish"}
          </button>
          <button
            onClick={onEscalate}
            disabled={pending}
            className="rounded-full border border-neutral-300 bg-white px-5 py-2.5 text-[13.5px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:opacity-50"
          >
            Hand to a person
          </button>
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-neutral-600">
          <Lock size={14} />
          Only IT staff can approve this.
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: PlanStep }) {
  const proof = proofOf(step);
  return (
    <div className="flex gap-3.5 py-2.5">
      <StepMark step={step} />
      <div className="min-w-0 flex-1">
        <div
          className={clsx(
            "text-[14px] leading-6",
            step.status === "pending" || step.status === "skipped"
              ? "text-neutral-400"
              : "text-neutral-800",
          )}
        >
          {step.description}
        </div>
        {proof && (
          <div
            className={clsx(
              "mt-1 text-[12.5px] leading-5",
              proof.changed ? "text-emerald-700" : "text-amber-700",
            )}
          >
            {proof.changed ? "Confirmed: " : "Careful: "}
            {proof.text}
          </div>
        )}
      </div>
    </div>
  );
}

function StepMark({ step }: { step: PlanStep }) {
  const base = "mt-0.5 flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full";
  if (step.status === "succeeded")
    return (
      <span className={clsx(base, "bg-emerald-600 text-white")}>
        <Check size={13} strokeWidth={3} />
      </span>
    );
  if (step.status === "failed")
    return (
      <span className={clsx(base, "bg-rose-600 text-white")}>
        <CircleAlert size={13} />
      </span>
    );
  if (step.status === "running")
    return (
      <span className={clsx(base, "bg-blue-600 text-white")}>
        <Loader2 size={12} className="animate-spin" />
      </span>
    );
  return <span className={clsx(base, "border border-neutral-300 bg-white")} />;
}

function Banner({ tone, children }: { tone: "green" | "red"; children: React.ReactNode }) {
  return (
    <div
      className={clsx(
        "mt-6 rounded-xl px-5 py-4 text-[13.5px] leading-6",
        tone === "green" ? "bg-emerald-50 text-emerald-900" : "bg-rose-50 text-rose-900",
      )}
    >
      {children}
    </div>
  );
}

/**
 * The graph's own record, kept but demoted. A technician debugging a bad run
 * still needs node names, risk tiers and capability ids — the employee-facing
 * surface above just should not lead with them.
 */
function TechnicalDetail({ ticket }: { ticket: Ticket }) {
  const trace = ticket.trace ?? [];
  const [open, setOpen] = useState(false);
  // Keyed by ticket AND updatedAt: fetched once when the panel is opened, and
  // again only when the ticket itself has actually moved. The envelopes are far
  // too heavy to ride the 600ms /api/state poll, which is why they have their
  // own route rather than a field on the ticket.
  const [evidence, setEvidence] = useState<{ key: string; jobs: AgentJob[]; error?: string } | null>(
    null,
  );
  const key = `${ticket.id}:${ticket.updatedAt}`;

  useEffect(() => {
    if (!open || evidence?.key === key) return;
    let live = true;
    // A failed fetch is NOT an empty job list. This turned every 401 into
    // "Nothing has run on a device for this ticket yet" — on a ticket whose
    // envelopes were sitting in the database, complete, the whole time. The
    // route already refuses anonymous reads for exactly this reason ("an empty
    // list would read as 'this ticket has no evidence', which is a different and
    // much worse answer than 'you are not signed in'"); swallowing its status
    // here undid that. The one thing this panel must never do is claim nothing
    // happened when it simply could not look.
    fetch(`/api/evidence/${ticket.id}`)
      .then(async (r) => {
        if (r.ok) return { jobs: ((await r.json()) as { jobs?: AgentJob[] }).jobs ?? [] };
        return {
          jobs: [],
          error:
            r.status === 401
              ? "You are not signed in to this workspace, so the device evidence cannot be read. It is not missing — sign in and reopen this panel."
              : `The evidence could not be loaded (HTTP ${r.status}). This says nothing about what ran on the machine.`,
        };
      })
      .then((d) => live && setEvidence({ key, ...d }))
      .catch((err: Error) =>
        live &&
        setEvidence({
          key,
          jobs: [],
          error: `The evidence could not be loaded (${err.message}). This says nothing about what ran on the machine.`,
        }),
      );
    return () => {
      live = false;
    };
  }, [open, key, evidence?.key, ticket.id]);

  const hasDetail = trace.length > 0 || ticket.plan.some((s) => s.capability) || !!ticket.troubleshootingSummary;
  if (!hasDetail) return null;

  return (
    <div className="mt-8 border-t border-neutral-200 pt-4 pb-10">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[12.5px] text-neutral-500 transition-colors hover:text-neutral-800"
      >
        <ChevronRight size={14} className={clsx("transition-transform", open && "rotate-90")} />
        Technical detail
        <span className="text-neutral-400">
          · {ticket.attempts ?? 1} attempt{(ticket.attempts ?? 1) > 1 ? "s" : ""}
          {ticket.attempts && ticket.attempts > 1 ? ` · ${ticket.attempts} looks` : ""}
          {ticket.confidence > 0 ? ` · confidence ${Math.round(ticket.confidence * 100)}%` : ""}
        </span>
      </button>

      {open && (
        <div className="mt-4 space-y-5">
          {ticket.troubleshootingSummary && (
            <pre className="whitespace-pre-wrap rounded-lg bg-neutral-50 p-4 font-sans text-[12px] leading-6 text-neutral-600">
              {ticket.troubleshootingSummary}
            </pre>
          )}

          <div>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                Proof from the machine
              </span>
              <a
                href={`/audit/${ticket.id}`}
                className="text-[11.5px] text-blue-700 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                Open the full audit ↗
              </a>
            </div>
            {evidence ? (
              <Evidence jobs={evidence.jobs} plan={ticket.plan} error={evidence.error} />
            ) : (
              <div className="flex items-center gap-2 text-[12px] text-neutral-500">
                <Loader2 size={13} className="animate-spin" />
                Reading what the device reported…
              </div>
            )}
          </div>

          {ticket.plan.some((s) => s.capability) && (
            <div>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                Steps, as executed
              </div>
              <div className="space-y-1.5">
                {ticket.plan.map((s, i) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-neutral-500">
                    <span className="text-neutral-400">#{i + 1}</span>
                    <span className="text-neutral-700">{s.capability ?? s.kind}</span>
                    <span>{s.status}</span>
                    {s.risk && (
                      <span className={s.approvalMode === "human" ? "text-amber-700" : "text-neutral-400"}>
                        {s.risk} risk · {s.approvalMode}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {trace.length > 0 && (
            <div>
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
                Graph trace
              </div>
              <ol className="space-y-1">
                {trace
                  .filter(
                    (e, _i, all) =>
                      e.status !== "started" ||
                      !all.some((o) => o.node === e.node && o.status !== "started"),
                  )
                  .map((e, i) => (
                    <li key={`${e.node}-${e.at}-${i}`} className="flex gap-2 font-mono text-[11.5px] text-neutral-500">
                      <span className="w-40 flex-none truncate text-neutral-700">{e.node}</span>
                      <span className="w-20 flex-none">{e.status}</span>
                      <span className="flex-none text-neutral-400">
                        {e.durationMs !== undefined ? `${e.durationMs}ms` : ""}
                      </span>
                      {e.detail && <span className="truncate">{e.detail}</span>}
                    </li>
                  ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
