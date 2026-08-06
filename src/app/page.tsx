import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Check } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STEPS = [
  {
    title: "Someone says what's broken",
    body: "In their own words. No form, no category, no severity dropdown.",
  },
  {
    title: "We check the actual machine",
    body: "Their device, their account, and what we already learned about them — before guessing.",
  },
  {
    title: "A person approves the change",
    body: "Anything that touches a machine stops here and waits for IT. Account unlocks always do.",
  },
  {
    title: "We prove it worked",
    body: "We read the machine again afterwards. If nothing changed, the ticket is not resolved.",
  },
];

const TRUTHS = [
  "Nothing runs on a machine without a named person approving it.",
  "Every action is one named capability — there is no run-anything tool.",
  "A fix that changes nothing on the machine is a failure, not a resolution.",
  "The employee sees who is waiting on what, in plain English.",
];

export default async function Landing() {
  const user = await getCurrentUser();
  if (user) redirect("/app");

  return (
    <div className="min-h-screen bg-white text-neutral-900">
      <header className="flex items-center gap-4 px-6 py-4">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-blue-600 text-[17px] font-bold text-white">
            b
          </div>
          <span className="text-[18px]">Bolt-it</span>
        </Link>
        <Link
          href="/login"
          className="ml-auto rounded-full bg-blue-600 px-5 py-2.5 text-[13.5px] font-medium text-white transition-colors hover:bg-blue-700"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-24 pt-16">
        <h1 className="text-[44px] font-normal leading-[1.1] tracking-tight sm:text-[56px]">
          IT support that
          <br />
          actually fixes things.
        </h1>
        <p className="mt-6 max-w-xl text-[17px] leading-8 text-neutral-600">
          Most IT tickets are one known fix away. Bolt-it reads the machine, works out what&apos;s
          wrong, asks a technician before changing anything, and then checks the machine again to
          prove the fix landed.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href="/login"
            className="flex items-center gap-2 rounded-full bg-blue-600 px-7 py-3.5 text-[15px] font-medium text-white transition-colors hover:bg-blue-700"
          >
            Sign in
            <ArrowRight size={16} />
          </Link>
          <span className="text-[13.5px] text-neutral-500">
            One workspace, one directory, no demo accounts.
          </span>
        </div>

        <section className="mt-20">
          <h2 className="text-[13px] font-medium uppercase tracking-[0.12em] text-neutral-500">
            How a ticket goes
          </h2>
          <ol className="relative mt-7 pl-9">
            <div className="absolute bottom-6 left-[11px] top-2 w-0.5 bg-neutral-200" />
            {STEPS.map((step, i) => (
              <li key={step.title} className="relative pb-8">
                <span className="absolute -left-9 top-0 flex h-6 w-6 items-center justify-center rounded-full border-[3px] border-white bg-blue-600 text-[12px] font-medium text-white">
                  {i + 1}
                </span>
                <div className="text-[16px] font-medium">{step.title}</div>
                <p className="mt-1 max-w-xl text-[14.5px] leading-7 text-neutral-600">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-10 rounded-2xl bg-[#f6f8fc] p-8">
          <h2 className="text-[20px]">The rules it works under</h2>
          <div className="mt-5 space-y-3">
            {TRUTHS.map((line) => (
              <div key={line} className="flex items-start gap-3 text-[14.5px] leading-7 text-neutral-700">
                <Check size={16} className="mt-1.5 flex-none text-blue-600" strokeWidth={2.5} />
                {line}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
