import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  BadgeCheck,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  FileSearch,
  LockKeyhole,
  Network,
  ServerCog,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Zap,
} from "lucide-react";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const OUTCOMES = [
  { label: "Target response time", value: "seconds" },
  { label: "Human approval", value: "always" },
  { label: "Company data", value: "private" },
];

const SIGNALS = [
  "Company runbooks and SOPs",
  "User context from Hyperspell",
  "Email, Slack, and identity history",
  "Device logs and network signals",
  "Web search when docs are missing",
];

const CAPABILITIES = [
  {
    icon: <FileSearch size={17} />,
    title: "Ticket resolution",
    body: "AI reads the issue, retrieves the right company knowledge, drafts the answer, and gives the technician an executable plan.",
  },
  {
    icon: <ServerCog size={17} />,
    title: "Asset management",
    body: "Keep device context, ownership, app access, and support history attached to every user and ticket.",
  },
  {
    icon: <Network size={17} />,
    title: "Network support",
    body: "Watch signals, explain likely root cause, and prepare fixes for Wi-Fi, VPN, DNS, printer, and access issues.",
  },
  {
    icon: <BookOpenCheck size={17} />,
    title: "Self-learning knowledge",
    body: "Every approved resolution strengthens the runbook library so repeated problems become faster and cheaper.",
  },
];

const SECURITY = [
  "Company documents are designed to stay scoped to the enrolled workspace.",
  "Technicians approve before actions run.",
  "Every answer includes source context and an audit trail.",
  "No standing broad admin access for the AI agent.",
];

export default async function Landing() {
  const user = await getCurrentUser();
  if (user) redirect("/app");

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-neutral-950/85 px-5 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-400 text-sm font-black text-neutral-950">
              IT
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">MSP Copilot</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                Private AI IT support
              </div>
            </div>
          </Link>
          <nav className="ml-auto flex items-center gap-2 text-sm">
            <Link href="/login" className="hidden px-3 py-2 text-neutral-400 hover:text-neutral-100 sm:inline">
              Sign in
            </Link>
            <Link
              href="/api/demo/start"
              className="rounded-md border border-white/10 bg-neutral-900 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-neutral-800"
            >
              Live demo
            </Link>
            <Link
              href="/signup"
              className="flex items-center gap-1.5 rounded-md bg-emerald-400 px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-300"
            >
              Enroll company
              <ArrowRight size={13} />
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto grid min-h-[calc(100vh-65px)] max-w-7xl grid-cols-1 gap-8 px-5 pb-10 pt-10 lg:grid-cols-[1fr_520px] lg:items-center">
          <div className="flex flex-col gap-7">
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 text-xs text-emerald-200">
              <Sparkles size={13} />
              Built for MSPs that need to support hundreds of users fast
            </div>
            <div className="space-y-5">
              <h1 className="max-w-4xl text-5xl font-semibold leading-[1.02] tracking-tight text-white md:text-7xl">
                Resolve IT tickets in seconds, with human approval.
              </h1>
              <p className="max-w-2xl text-lg leading-8 text-neutral-300">
                A private AI platform for MSP technicians. The demo shows how company docs, user
                context, device logs, and trusted web results become a cited fix plan that a human
                can approve and run.
              </p>
            </div>

            <div className="grid max-w-2xl grid-cols-3 divide-x divide-white/10 rounded-lg border border-white/10 bg-white/[0.03]">
              {OUTCOMES.map((item) => (
                <div key={item.label} className="p-4">
                  <div className="text-xl font-semibold text-white">{item.value}</div>
                  <div className="mt-1 text-[11px] uppercase tracking-wider text-neutral-500">
                    {item.label}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/api/demo/start"
                className="flex items-center gap-2 rounded-md bg-emerald-400 px-5 py-3 text-sm font-semibold text-neutral-950 hover:bg-emerald-300"
              >
                Show judges the demo
                <ArrowRight size={15} />
              </Link>
              <Link
                href="/signup"
                className="flex items-center gap-2 rounded-md border border-white/10 bg-neutral-900 px-5 py-3 text-sm font-medium text-neutral-100 hover:bg-neutral-800"
              >
                Start company enrollment
                <ShieldCheck size={15} />
              </Link>
            </div>
          </div>

          <DemoPreview />
        </section>

        <section className="border-y border-white/10 bg-neutral-900/45">
          <div className="mx-auto grid max-w-7xl grid-cols-1 gap-8 px-5 py-10 lg:grid-cols-[360px_1fr]">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">
                Why it works
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">
                Most IT issues are solvable from the right context.
              </h2>
              <p className="mt-4 text-sm leading-6 text-neutral-400">
                The platform brings together the evidence an MSP technician already checks, then
                makes the fix repeatable, reviewable, and secure.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {SIGNALS.map((signal) => (
                <div key={signal} className="flex items-center gap-3 rounded-md border border-white/10 bg-neutral-950/60 p-4">
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-300" />
                  <span className="text-sm text-neutral-200">{signal}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 py-12">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            {CAPABILITIES.map((capability) => (
              <div key={capability.title} className="rounded-lg border border-white/10 bg-neutral-900 p-5">
                <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-md bg-emerald-400/10 text-emerald-300">
                  {capability.icon}
                </div>
                <h3 className="text-sm font-semibold text-white">{capability.title}</h3>
                <p className="mt-2 text-sm leading-6 text-neutral-400">{capability.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 pb-14">
          <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-white/10 bg-neutral-900 lg:grid-cols-[1fr_430px]">
            <div className="p-6 md:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-300">
                Enrollment
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-white">
                Connect the company once. Every ticket gets smarter.
              </h2>
              <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <EnrollmentStep title="1. Create workspace" body="Company profile, domain, admin, and MSP team access." />
                <EnrollmentStep title="2. Upload knowledge" body="Policies, onboarding docs, SOPs, vendor notes, network maps." />
                <EnrollmentStep title="3. Connect context" body="Email, Slack, identity, ticket history, and Hyperspell memory." />
                <EnrollmentStep title="4. Approve automation" body="Choose what AI can draft, what technicians approve, and what escalates." />
              </div>
            </div>
            <div className="border-t border-white/10 bg-neutral-950 p-6 lg:border-l lg:border-t-0">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-white">
                <LockKeyhole size={16} className="text-emerald-300" />
                Privacy and control model
              </div>
              <div className="space-y-3">
                {SECURITY.map((item) => (
                  <div key={item} className="flex items-start gap-3 text-sm leading-6 text-neutral-300">
                    <BadgeCheck size={16} className="mt-0.5 shrink-0 text-emerald-300" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
              <div className="mt-5 rounded-md border border-amber-400/20 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
                Hackathon scope: this demo uses isolated workspaces. Production hardening includes
                demo TTL cleanup, InsForge RLS proof, and full Slack OAuth install verification.
              </div>
              <Link
                href="/signup"
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 py-3 text-sm font-semibold text-neutral-950 hover:bg-emerald-300"
              >
                Enroll a company
                <ArrowRight size={15} />
              </Link>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function DemoPreview() {
  return (
    <div className="rounded-xl border border-white/10 bg-neutral-900 shadow-2xl shadow-emerald-950/20">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <div className="h-2.5 w-2.5 rounded-full bg-rose-400" />
        <div className="h-2.5 w-2.5 rounded-full bg-amber-400" />
        <div className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <div className="ml-auto rounded bg-neutral-950 px-2 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
          Live ticket
        </div>
      </div>
      <div className="p-4">
        <div className="rounded-lg border border-white/10 bg-neutral-950 p-4">
          <div className="mb-3 flex items-center gap-2">
            <UserCheck size={16} className="text-cyan-300" />
            <div>
              <div className="text-sm font-semibold text-white">CFO cannot access VPN</div>
              <div className="text-xs text-neutral-500">Reported in Slack · high priority</div>
            </div>
            <div className="ml-auto rounded bg-amber-400/10 px-2 py-1 text-[10px] uppercase tracking-wider text-amber-200">
              Awaiting approval
            </div>
          </div>
          <p className="text-sm leading-6 text-neutral-300">
            AI found the VPN certificate renewal runbook, matched the user&apos;s device logs, and
            detected a stale Okta group sync from the last 18 minutes.
          </p>
        </div>

        <div className="mt-3 space-y-2">
          <PlanRow icon={<BookOpenCheck size={14} />} title="Cited fix plan" meta="3 company sources" />
          <PlanRow icon={<Clock3 size={14} />} title="Estimated resolution" meta="42 seconds" />
          <PlanRow icon={<ShieldCheck size={14} />} title="Permission check" meta="requires technician approval" />
          <PlanRow icon={<Zap size={14} />} title="Execute scoped actions" meta="identity sync, VPN cert refresh, Slack reply" />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-md border border-emerald-400/20 bg-emerald-400/10 p-3">
            <div className="text-2xl font-semibold text-emerald-200">87%</div>
            <div className="text-[11px] uppercase tracking-wider text-emerald-300/80">
              Confidence
            </div>
          </div>
          <div className="rounded-md border border-cyan-400/20 bg-cyan-400/10 p-3">
            <div className="text-2xl font-semibold text-cyan-200">$18</div>
            <div className="text-[11px] uppercase tracking-wider text-cyan-300/80">
              Est. labor saved
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlanRow({
  icon,
  title,
  meta,
}: {
  icon: React.ReactNode;
  title: string;
  meta: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-white/10 bg-neutral-950/70 p-3">
      <div className="text-emerald-300">{icon}</div>
      <div className="min-w-0">
        <div className="text-sm font-medium text-neutral-100">{title}</div>
        <div className="text-xs text-neutral-500">{meta}</div>
      </div>
    </div>
  );
}

function EnrollmentStep({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-white/10 bg-neutral-950/50 p-4">
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-1 text-sm leading-6 text-neutral-400">{body}</div>
    </div>
  );
}
