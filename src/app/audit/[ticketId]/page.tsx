import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { getTicket, listAgentJobsForTicket } from "@/lib/data";
import { Evidence } from "@/app/components/Evidence";
import { timeAgo } from "@/app/components/ticket-view";

export const dynamic = "force-dynamic";

/**
 * One ticket's device evidence, full width and standing on its own.
 *
 * The staff ticket carries the same block, but collapsed behind "Technical
 * detail" and squeezed into a 3xl column — right for a technician mid-triage,
 * wrong for the case this page exists for: someone in the room asking whether
 * any of this is real. Here there is nothing to scroll past. Every command that
 * ran on the machine, with its exit code and its output, and next to each read
 * the exact command that produced the numbers, so a sceptic can run it on the
 * same machine and compare.
 *
 * Server-rendered from `data.ts` directly: no client fetch and no polling, so
 * what is on screen when it loads is what stays on screen.
 */
export default async function AuditPage({ params }: { params: Promise<{ ticketId: string }> }) {
  const { ticketId } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const ticket = await getTicket(ticketId, user.workspaceId);
  if (!ticket) {
    return (
      <main className="mx-auto max-w-4xl px-8 py-16 text-[14px] text-neutral-600">
        No ticket <span className="font-mono">{ticketId}</span> in this workspace.
      </main>
    );
  }

  const jobs = await listAgentJobsForTicket(ticket.id, user.workspaceId);

  return (
    <main className="mx-auto max-w-5xl px-8 py-10">
      <Link
        href="/app"
        className="inline-flex items-center gap-1.5 text-[12.5px] text-neutral-500 transition-colors hover:text-neutral-800"
      >
        <ArrowLeft size={14} />
        Back to the queue
      </Link>

      <h1 className="mt-5 text-[22px] leading-tight text-neutral-900">{ticket.subject}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-[11.5px] text-neutral-400">
        <span>{ticket.id}</span>
        <span>·</span>
        <span>{ticket.reporterEmail}</span>
        <span>·</span>
        <span>reported {timeAgo(ticket.createdAt)}</span>
      </div>

      <p className="mt-6 max-w-3xl border-l-2 border-neutral-200 pl-4 text-[13.5px] leading-7 text-neutral-600">
        Every verdict below came from the machine reading its own state before and after the change —
        not from a command exiting zero, and not from a model&apos;s account of what it did. A change
        that ran cleanly and left the machine identical is recorded as a failure. Each read shows the
        command that produced it, so it can be run on {jobs[0]?.envelope?.host ?? "the machine"} and
        compared.
      </p>

      <div className="mt-8">
        <Evidence jobs={jobs} plan={ticket.plan} />
      </div>
    </main>
  );
}
