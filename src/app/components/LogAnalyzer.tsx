"use client";

import { useState, useTransition } from "react";
import { analyzeLogsAction, LogAnalysisResult } from "@/app/actions/logs";
import { PublicUser } from "@/lib/types";
import { AlertTriangle, Brain, CheckCircle2, FileText, Loader2, Save, SearchCheck } from "lucide-react";

const SAMPLE_LOG = `2026-05-09T14:12:31Z vpn-client[884] AUTH_FAILED user=frank@acme.test provider=SAML reason=token_expired_after_password_change
2026-05-09T14:12:32Z vpn-client[884] profile gateway=us-west-1.old.acme.test profile_version=2025.01 mdm_profile_age_days=93
2026-05-09T14:12:34Z vpn-client[884] TLS handshake failed peer=us-west-1.old.acme.test alert=certificate_unknown
2026-05-09T14:12:35Z vpn-client[884] route add failed finance-drive.acme.test unreachable
2026-05-09T14:12:36Z vpn-client[884] retry scheduled backoff=30s`;

export function LogAnalyzer({ currentUser }: { currentUser: PublicUser }) {
  const [issue, setIssue] = useState("CFO cannot access VPN after password change before board meeting");
  const [reporterEmail, setReporterEmail] = useState("frank@acme.test");
  const [logs, setLogs] = useState(SAMPLE_LOG);
  const [result, setResult] = useState<LogAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    setResult(null);
    const fd = new FormData();
    fd.set("reporter", currentUser.name);
    fd.set("reporterEmail", reporterEmail);
    fd.set("issue", issue);
    fd.set("logs", logs);
    startTransition(async () => {
      try {
        setResult(await analyzeLogsAction(fd));
      } catch (err) {
        setError((err as Error).message || "Log analysis failed.");
      }
    });
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[420px_1fr] divide-x divide-neutral-200 bg-white">
      <section className="min-h-0 overflow-y-auto p-5">
        <div className="mb-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
            <SearchCheck size={16} className="text-blue-600" />
            Analyze logs
          </div>
          <p className="mt-1 text-xs leading-5 text-neutral-500">
            Paste VPN, Okta, Windows Event Viewer, printer, or app logs. The analyzer creates a
            ticket and saves useful context for future support.
          </p>
        </div>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Issue</span>
          <input
            value={issue}
            onChange={(e) => setIssue(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-600 focus:outline-none"
          />
        </label>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Person context</span>
          <input
            value={reporterEmail}
            onChange={(e) => setReporterEmail(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-blue-600 focus:outline-none"
          />
        </label>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Logs or error text</span>
          <textarea
            value={logs}
            onChange={(e) => setLogs(e.target.value)}
            rows={14}
            className="mt-1 w-full resize-none rounded border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-xs leading-5 text-neutral-900 placeholder:text-neutral-400 focus:border-blue-600 focus:outline-none"
          />
        </label>

        <button
          onClick={submit}
          disabled={pending || !logs.trim()}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Brain size={15} />}
          Analyze, ticket, and save context
        </button>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded bg-rose-50 px-3 py-2 text-xs text-rose-700">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </section>

      <section className="min-h-0 overflow-y-auto p-6">
        {!result ? (
          <div className="flex h-full items-center justify-center text-center">
            <div className="max-w-md">
              <FileText size={28} className="mx-auto mb-3 text-neutral-400" />
              <h2 className="text-lg font-medium text-neutral-800">Turn raw logs into a ticket</h2>
              <p className="mt-2 text-sm leading-6 text-neutral-500">
                Paste the evidence you already have. You get a diagnosis, a ticket, and the finding
                saved against that person — so the next technician starts where you finished.
              </p>
            </div>
          </div>
        ) : (
          <AnalysisResult result={result} />
        )}
      </section>
    </div>
  );
}

function AnalysisResult({ result }: { result: LogAnalysisResult }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-5">
        <div className="mb-2 flex items-center gap-2">
          <SeverityBadge severity={result.severity} />
          <span className="text-[11px] font-mono text-neutral-500">{result.ticketId}</span>
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-neutral-900">{result.title}</h2>
        <p className="mt-3 text-sm leading-6 text-neutral-700">{result.rootCause}</p>
      </div>

      <ResultSection title="Important details" items={result.importantDetails} />
      <ResultSection title="Evidence extracted" items={result.evidence} mono />
      <ResultSection title="Suggested fixes" items={result.suggestedFixes} />

      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">Ready-to-send user reply</div>
        <p className="text-sm leading-6 text-neutral-800">{result.userReply}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SaveCard label="Ticket created" value={result.ticketId} ok />
        <SaveCard
          label="Person memory"
          value={result.savedPersonMemory ? result.memoryId ?? "saved" : "not saved"}
          ok={result.savedPersonMemory}
        />
      </div>
    </div>
  );
}

function ResultSection({ title, items, mono = false }: { title: string; items: string[]; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50/70 p-4">
      <div className="mb-3 text-[11px] uppercase tracking-wider text-neutral-500">{title}</div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={`${item}-${i}`} className="flex items-start gap-2 text-sm leading-6 text-neutral-700">
            <CheckCircle2 size={14} className="mt-1 shrink-0 text-emerald-600" />
            <span className={mono ? "font-mono text-xs text-neutral-500" : ""}>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: LogAnalysisResult["severity"] }) {
  const cls = {
    low: "bg-neutral-100 text-neutral-600",
    medium: "bg-amber-50 text-amber-700",
    high: "bg-rose-50 text-rose-700",
  }[severity];
  return <span className={`rounded px-2 py-1 text-[10px] uppercase tracking-wider ${cls}`}>{severity}</span>;
}

function SaveCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
        <Save size={12} className={ok ? "text-emerald-600" : "text-neutral-400"} />
        {label}
      </div>
      <div className={ok ? "text-xs text-emerald-700" : "text-xs text-neutral-500"}>{value}</div>
    </div>
  );
}
