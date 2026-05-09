import { redirect } from "next/navigation";
import Link from "next/link";
import { Lock, ShieldCheck, AlertTriangle } from "lucide-react";
import { loginAction } from "@/app/actions/auth";
import { listADAccounts, listADUsers } from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";
import { ADAccount, ADUser } from "@/lib/types";
import { ACME_WORKSPACE_ID } from "@/lib/workspace";

export const dynamic = "force-dynamic";

const ERR_MESSAGE: Record<string, string> = {
  bad_credentials: "Email or password is incorrect.",
  account_locked: "Account is locked. File an IT ticket to unlock.",
  account_disabled: "Account is disabled. Contact IT.",
  password_expired: "Password expired. File an IT ticket to reset.",
  stale_kerberos: "Stale Kerberos ticket on your AD account. File an IT ticket.",
};

const DEMO_PASSWORDS: Record<string, string> = {
  "alice@acme.test": "demo-pass-1",
  "bob@acme.test": "demo-pass-2",
  "carol@acme.test": "demo-pass-3",
  "dan@acme.test": "demo-pass-4",
  "eve@acme.test": "demo-pass-5",
  "frank@acme.test": "demo-pass-6",
  "priya@acme.test": "demo-pass-7",
  "morgan@acme.test": "demo-pass-it",
  "sam@acme.test": "demo-pass-it2",
};

interface LoginPageProps {
  searchParams: Promise<{ err?: string; email?: string; demo?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  await ensureSeeded();
  const existing = await getCurrentUser();
  if (existing) redirect("/app");

  const sp = await searchParams;
  const err = sp.err && ERR_MESSAGE[sp.err] ? ERR_MESSAGE[sp.err] : null;
  const prefilledEmail = sp.email ?? "";
  const showSeededList = sp.demo === "1" || process.env.NODE_ENV !== "production";

  const [users, accounts] = showSeededList
    ? await Promise.all([listADUsers(ACME_WORKSPACE_ID), listADAccounts(ACME_WORKSPACE_ID)])
    : [[], []];
  const accountByEmail = new Map(accounts.map((a) => [a.email, a]));

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
      <div className={showSeededList ? "w-full max-w-3xl grid md:grid-cols-[1fr_360px] gap-6" : "w-full max-w-md"}>
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8">
          <div className="flex items-center gap-2 mb-6">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-neutral-950 font-bold">
              IT
            </div>
            <div>
              <div className="text-sm font-semibold tracking-tight">Sign in to your workspace</div>
              <div className="text-[11px] text-neutral-500">AI-Native IT Support</div>
            </div>
          </div>

          <h1 className="text-xl font-semibold mb-1">Sign in</h1>
          <p className="text-sm text-neutral-400 mb-6">
            Use the email + password you signed up with. Sessions are 8 hours.
          </p>

          {err && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
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
                placeholder="alice@acme.test"
                className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
              />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-neutral-500">Password</span>
              <input
                name="password"
                type="password"
                required
                placeholder="demo-pass-…"
                className="mt-1 w-full bg-neutral-950 border border-neutral-800 rounded px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:border-neutral-600"
              />
            </label>
            <button
              type="submit"
              className="w-full bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium text-sm py-2 rounded flex items-center justify-center gap-2 transition-colors"
            >
              <Lock size={14} /> Sign in
            </button>
          </form>

          <div className="mt-4 text-xs text-neutral-500 flex items-center justify-between">
            <span>No account?</span>
            <Link href="/signup" className="text-emerald-300 hover:text-emerald-200">
              Create one →
            </Link>
          </div>

          <div className="mt-6 text-[11px] text-neutral-500 flex items-start gap-2">
            <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-400/80" />
            <span>
              No account? Try the{" "}
              <Link href="/api/demo/start" className="text-emerald-300 hover:text-emerald-200">
                live demo
              </Link>{" "}
              first — no signup required.
            </span>
          </div>
        </div>

        {showSeededList && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
            <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">
              Acme Corp seeded AD (dev only)
            </div>
            <div className="text-[10px] text-neutral-600 mb-3">
              One-click sign-in for the seeded test workspace. Hidden in production.
            </div>
            <ul className="space-y-1.5">
              {users.map((u) => {
                const acct = accountByEmail.get(u.email);
                return <UserRow key={u.email} user={u} account={acct} password={DEMO_PASSWORDS[u.email]} />;
              })}
            </ul>
            <div className="mt-4 text-[10px] text-neutral-500 leading-relaxed">
              <span className="text-neutral-400">Tip:</span> sign in as a non-IT user to file
              tickets, then sign in as <span className="text-emerald-300">morgan@acme.test</span>{" "}
              (IT staff) to approve agent plans.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UserRow({
  user,
  account,
  password,
}: {
  user: ADUser;
  account: ADAccount | undefined;
  password: string | undefined;
}) {
  const status = account?.status ?? "active";
  const statusColor =
    status === "active"
      ? "bg-emerald-500/15 text-emerald-300"
      : status === "locked"
        ? "bg-red-500/15 text-red-300"
        : status === "password_expired"
          ? "bg-amber-500/15 text-amber-300"
          : status === "stale_kerberos"
            ? "bg-violet-500/15 text-violet-300"
            : "bg-neutral-700/40 text-neutral-300";

  const canLogin = status === "active" && password;

  return (
    <li className="border border-neutral-800 rounded p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{user.name}</div>
          <div className="text-[11px] text-neutral-500 truncate">{user.email}</div>
        </div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${statusColor} shrink-0`}>
          {status.replace("_", " ")}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="text-[10px] text-neutral-500 truncate">
          {user.title} · {user.team}
          {user.isITStaff && <span className="ml-1 text-emerald-300">· IT</span>}
        </div>
        {canLogin ? (
          <form action={loginAction}>
            <input type="hidden" name="email" value={user.email} />
            <input type="hidden" name="password" value={password} />
            <button
              type="submit"
              className="text-[10px] bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-2 py-1 rounded transition-colors"
            >
              Log in
            </button>
          </form>
        ) : (
          <span className="text-[10px] text-neutral-600">file ticket →</span>
        )}
      </div>
    </li>
  );
}
