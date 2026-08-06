import { redirect } from "next/navigation";
import { Lock, ShieldCheck, AlertTriangle } from "lucide-react";
import { loginAction } from "@/app/actions/auth";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

const ERR_MESSAGE: Record<string, string> = {
  bad_credentials: "Email or password is incorrect.",
  account_locked: "Account is locked. File an IT ticket to unlock.",
  account_disabled: "Account is disabled. Contact IT.",
  password_expired: "Password expired. File an IT ticket to reset.",
  stale_kerberos: "Stale Kerberos ticket on your AD account. File an IT ticket.",
};

interface LoginPageProps {
  searchParams: Promise<{ err?: string; email?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  await ensureSeeded();
  const existing = await getCurrentUser();
  if (existing) redirect("/app");

  const sp = await searchParams;
  const err = sp.err && ERR_MESSAGE[sp.err] ? ERR_MESSAGE[sp.err] : null;
  const prefilledEmail = sp.email ?? "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f6f8fc] p-6 text-neutral-900">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-neutral-200 bg-white p-8">
          <div className="flex items-center gap-2 mb-6">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-blue-600 text-[17px] font-bold text-white">
              b
            </div>
            <div className="text-[17px] text-neutral-900">Bolt-it</div>
          </div>

          <h1 className="mb-1 text-[22px] text-neutral-900">Sign in</h1>
          <p className="mb-6 text-sm text-neutral-500">
            Sessions last 8 hours.
          </p>

          {err && (
            <div className="mb-4 flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2.5 text-[13px] text-rose-700">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{err}</span>
            </div>
          )}

          <form action={loginAction} className="space-y-3">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">Email</span>
              <input
                name="email"
                type="email"
                required
                defaultValue={prefilledEmail}
                placeholder="you@company.com"
                className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-600 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">Password</span>
              <input
                name="password"
                type="password"
                required
                placeholder="Your password"
                className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-600 focus:outline-none"
              />
            </label>
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700"
            >
              <Lock size={14} /> Sign in
            </button>
          </form>

          <div className="mt-6 flex items-start gap-2 text-[12px] text-neutral-500">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-blue-600" />
            <span>Nothing runs on a machine without a person approving it first.</span>
          </div>
        </div>

      </div>
    </div>
  );
}
