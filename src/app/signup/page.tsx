import { redirect } from "next/navigation";
import Link from "next/link";
import {
  ArrowRight,
  AlertTriangle,
  Building2,
  CheckCircle2,
  Files,
  PlugZap,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { signupAction } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

const ERR_MESSAGE: Record<string, string> = {
  email_taken: "An account with that email already exists. Sign in instead.",
  invalid_input: "Check the form and try again.",
};

interface SignupPageProps {
  searchParams: Promise<{ err?: string; email?: string; from?: string }>;
}

export default async function SignupPage({ searchParams }: SignupPageProps) {
  await ensureSeeded();
  const existing = await getCurrentUser();
  if (existing) redirect("/app");

  const sp = await searchParams;
  const err = sp.err
    ? ERR_MESSAGE[sp.err] ?? sp.err.replace(/_/g, " ")
    : null;
  const prefilledEmail = sp.email ?? "";
  const fromDemo = sp.from === "demo";

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto grid min-h-screen max-w-6xl grid-cols-1 items-center gap-8 px-5 py-8 lg:grid-cols-[1fr_440px]">
        <section className="hidden lg:block">
          <div className="mb-6 flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-400 text-sm font-black text-neutral-950">
              IT
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">MSP Copilot</div>
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">
                Secure enrollment
              </div>
            </div>
          </div>
          <h1 className="max-w-2xl text-5xl font-semibold leading-tight tracking-tight text-white">
            Give the AI the context your best technician already looks for.
          </h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-neutral-400">
            Create a company workspace, then prepare documents, Slack or email, identity context,
            and device logs for the secure connector flow. The AI drafts fixes; your IT staff stays
            in control.
          </p>
          <div className="mt-8 grid max-w-2xl grid-cols-2 gap-3">
            <EnrollmentCard icon={<Building2 size={17} />} title="Company profile" body="Domain-based workspace and MSP admin access." />
            <EnrollmentCard icon={<Files size={17} />} title="Knowledge upload" body="Runbooks, policies, vendor notes, and SOPs." />
            <EnrollmentCard icon={<PlugZap size={17} />} title="Context connectors" body="Planned Slack OAuth, email, identity, Hyperspell, and device logs." />
            <EnrollmentCard icon={<ShieldCheck size={17} />} title="Approval policy" body="Choose what requires technician review." />
          </div>
        </section>

        <div className="w-full rounded-xl border border-neutral-800 bg-neutral-900 p-6 shadow-2xl shadow-emerald-950/20 sm:p-8">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-emerald-400 text-neutral-950 font-bold">
              IT
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Create your workspace</div>
              <div className="text-[11px] text-neutral-500">MSP Copilot</div>
            </div>
          </div>

        {fromDemo && (
          <div className="mb-4 rounded-md border border-emerald-800/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200 flex items-start gap-2">
            <ArrowRight size={13} className="mt-0.5 shrink-0" />
            <span>
              <strong>We&apos;ll bring your demo tickets with you.</strong> Anything you generated
              in the anonymous demo will be moved into this new workspace.
            </span>
          </div>
        )}

        <h1 className="text-xl font-semibold mb-1">Enroll your company</h1>
        <p className="text-sm text-neutral-400 mb-2">
          Your workspace is auto-created from your email domain. Anyone else with the same
          domain can join later as a teammate.
        </p>
        <p className="text-[11px] text-neutral-500 mb-6">
          The first person from a domain becomes the IT admin. (Override below if you&apos;re
          a teammate joining an existing workspace.)
        </p>

        {err && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        <form action={signupAction} className="space-y-3">
          <Field label="Work email" name="email" type="email" required defaultValue={prefilledEmail} placeholder="you@example.com" />
          <Field label="Full name" name="name" required placeholder="Jane Doe" />
          <Field label="Password" name="password" type="password" required placeholder="at least 6 characters" />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Team" name="team" placeholder="Engineering" />
            <Field label="Title" name="title" placeholder="Engineer" />
          </div>
          <label className="flex items-start gap-2 mt-2 cursor-pointer text-xs text-neutral-300">
            <input
              name="isITStaff"
              type="checkbox"
              className="mt-0.5 accent-emerald-500"
            />
            <span>
              I&apos;m setting up the IT side — give me technician console access
              (can approve agent plans).
            </span>
          </label>
          <button
            type="submit"
            className="w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium text-sm py-2 rounded flex items-center justify-center gap-2 transition-colors mt-2"
          >
            <UserPlus size={14} /> Create secure workspace
          </button>
        </form>

        <div className="mt-5 rounded-md border border-neutral-800 bg-neutral-950/70 p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
            After this step
          </div>
          <div className="space-y-2 text-xs text-neutral-300">
            <NextStep>Upload company documents and runbooks</NextStep>
            <NextStep>Connect Slack OAuth, email domain, and identity context after verification</NextStep>
            <NextStep>Set technician approval and escalation rules</NextStep>
          </div>
        </div>

        <div className="mt-5 text-xs text-neutral-500 flex items-center justify-between">
          <span>Already have an account?</span>
          <Link href="/login" className="text-emerald-300 hover:text-emerald-200">
            Sign in →
          </Link>
        </div>

        <div className="mt-5 text-[11px] text-neutral-500 flex items-start gap-2">
          <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-400/80" />
          <span>
            Demo backend: accounts persist in InsForge. Passwords are hashed with PBKDF2.
          </span>
        </div>
      </div>
    </div>
    </div>
  );
}

function EnrollmentCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-neutral-900 p-4">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-emerald-400/10 text-emerald-300">
        {icon}
      </div>
      <div className="text-sm font-semibold text-white">{title}</div>
      <div className="mt-1 text-sm leading-6 text-neutral-400">{body}</div>
    </div>
  );
}

function NextStep({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
      <span>{children}</span>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-neutral-500">{label}</span>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
      />
    </label>
  );
}
