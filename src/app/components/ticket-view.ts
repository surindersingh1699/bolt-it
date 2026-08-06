// Plain-language layer over the ticket model. The graph's vocabulary
// (interrupt, risk tier, capability) is engineering vocabulary — it does not
// belong on the surfaces an employee or a busy technician reads. Everything
// here is pure so both the staff inbox and the employee view phrase the same
// state the same way.

import { PlanStep, StepFailureKind, Ticket, TicketStatus } from "@/lib/types";

export type TicketGroup = "approval" | "working" | "waiting" | "resolved" | "escalated";

export const GROUPS: { id: TicketGroup; label: string }[] = [
  { id: "approval", label: "Needs your approval" },
  { id: "working", label: "Working now" },
  { id: "waiting", label: "Waiting on employee" },
  { id: "resolved", label: "Resolved" },
  { id: "escalated", label: "Handed to a person" },
];

export function groupOf(status: TicketStatus): TicketGroup {
  switch (status) {
    case "awaiting_approval":
      return "approval";
    case "awaiting_confirmation":
      return "waiting";
    case "resolved":
      return "resolved";
    case "escalated":
      return "escalated";
    default:
      return "working";
  }
}

/** How a technician reads the state, in the third person. */
export function staffStatusLabel(status: TicketStatus): string {
  return {
    new: "Just came in",
    drafting: "Working out a fix",
    awaiting_approval: "Approve to finish",
    executing: "Fixing it now",
    awaiting_confirmation: "Waiting on employee",
    resolved: "Fixed",
    escalated: "Handed to a person",
  }[status];
}

/** How the person who raised it reads the same state. */
export function employeeStatusLabel(status: TicketStatus): string {
  return {
    new: "We're getting started",
    drafting: "We're working out a fix",
    awaiting_approval: "Waiting on IT to approve",
    executing: "We're fixing it now",
    awaiting_confirmation: "Did that work?",
    resolved: "Fixed",
    escalated: "A person has taken this over",
  }[status];
}

/** One sentence telling the reporter what is happening to them right now. */
export function employeeStatusBlurb(ticket: Ticket): string {
  switch (ticket.status) {
    case "new":
    case "drafting":
      return "We're looking at your machine and your history now. This usually takes under a minute.";
    case "awaiting_approval":
      return "We found the cause. Someone in IT just has to say yes, then it's fixed automatically.";
    case "executing":
      return "We're making the change now. You can keep working.";
    case "awaiting_confirmation":
      return "We think it's fixed. Tell us whether it actually worked — we only close it if it did.";
    case "resolved":
      return "This one's done. We saved what worked, so next time it goes faster.";
    case "escalated":
      return "This needed a person. A technician has it and will be in touch.";
  }
}

export type Tone = "blue" | "amber" | "green" | "red" | "grey";

export function toneOf(status: TicketStatus): Tone {
  switch (status) {
    case "awaiting_approval":
      return "amber";
    case "resolved":
      return "green";
    case "escalated":
      return "red";
    case "awaiting_confirmation":
      return "grey";
    default:
      return "blue";
  }
}

export const TONE_PILL: Record<Tone, string> = {
  blue: "bg-blue-50 text-blue-700",
  amber: "bg-amber-50 text-amber-800",
  green: "bg-emerald-50 text-emerald-700",
  red: "bg-rose-50 text-rose-700",
  grey: "bg-neutral-100 text-neutral-600",
};

export const TONE_DOT: Record<Tone, string> = {
  blue: "bg-blue-600",
  amber: "bg-amber-500",
  green: "bg-emerald-600",
  red: "bg-rose-600",
  grey: "bg-neutral-400",
};

/**
 * Proof of effect, in words. `no_effect` is the case that matters: the commands
 * ran and the machine did not move, which is a failure however clean the exit
 * code was. Surfacing it in plain text is what stops a no-op reading as a fix.
 */
export function proofOf(step: PlanStep): { changed: boolean; text: string } | null {
  const line = step.log?.find((l) => l.startsWith("[Proof]"));
  if (!line) return null;
  if (line.startsWith("[Proof] EFFECT:")) {
    return { changed: true, text: line.slice("[Proof] EFFECT:".length).trim() || "The machine changed." };
  }
  if (line.startsWith("[Proof] NO EFFECT")) {
    return { changed: false, text: "Ran cleanly, but nothing on the machine changed." };
  }
  return null;
}

/** True when this step is the one currently sitting behind the human gate. */
export function isGatedStep(step: PlanStep): boolean {
  return step.approvalMode === "human" && (step.status === "pending" || step.status === "running");
}

export function gatedStepOf(ticket: Ticket): PlanStep | undefined {
  return ticket.plan.find(isGatedStep);
}

export function timeAgo(ts: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return (
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  );
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-blue-600",
  "bg-emerald-600",
  "bg-violet-600",
  "bg-orange-500",
  "bg-teal-600",
  "bg-rose-600",
  "bg-indigo-600",
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

/**
 * Operational roll-up across tickets, for the metrics view.
 *
 * Pure and exported so the arithmetic can be tested directly: these numbers get
 * quoted in conversations about whether the agent is working, so an off-by-one
 * in the escalation rate is not a cosmetic bug.
 */
export function summarizeAgentMetrics(tickets: Ticket[]) {
  const byTier: Record<number, number> = {};
  const failureCounts = new Map<StepFailureKind, number>();
  const callTokens = new Map<string, number>();
  let tokens = 0;
  let ticketsWithUsage = 0;
  let steps = 0;
  let refused = 0;

  for (const t of tickets) {
    byTier[t.tier ?? 1] = (byTier[t.tier ?? 1] ?? 0) + 1;

    for (const s of t.plan) {
      steps += 1;
      if (s.failure) {
        failureCounts.set(s.failure.kind, (failureCounts.get(s.failure.kind) ?? 0) + 1);
        if (s.failure.kind === "policy_block" || s.failure.kind === "unsupported_assumption") refused += 1;
      }
    }

    if (t.usage && t.usage.calls > 0) {
      ticketsWithUsage += 1;
      tokens += t.usage.totalTokens;
      for (const [call, v] of Object.entries(t.usage.byCall)) {
        callTokens.set(call, (callTokens.get(call) ?? 0) + v.totalTokens);
      }
    }
  }

  const failures = [...failureCounts.entries()].sort((a, b) => b[1] - a[1]);

  return {
    total: tickets.length,
    // Resolved or awaiting the employee's confirmation: either way no
    // technician had to pick it up.
    autonomous: tickets.filter((t) => t.status === "resolved" || t.status === "awaiting_confirmation").length,
    escalated: tickets.filter((t) => t.status === "escalated").length,
    awaitingApproval: tickets.filter((t) => t.status === "awaiting_approval").length,
    deep: tickets.filter((t) => (t.tier ?? 1) === 3).length,
    byTier,
    failures,
    failureTotal: failures.reduce((n, [, v]) => n + v, 0),
    byCall: [...callTokens.entries()].sort((a, b) => b[1] - a[1]),
    tokens,
    ticketsWithUsage,
    steps,
    refused,
  };
}
