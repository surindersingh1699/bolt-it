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
  const [saveScope, setSaveScope] = useState("both");
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
    fd.set("saveScope", saveScope);
    startTransition(async () => {
      try {
        setResult(await analyzeLogsAction(fd));
      } catch (err) {
        setError((err as Error).message || "Log analysis failed.");
      }
    });
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[420px_1fr] divide-x divide-neutral-800 bg-neutral-950">
      <section className="min-h-0 overflow-y-auto p-5">
        <div className="mb-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
            <SearchCheck size={16} className="text-emerald-300" />
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
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </label>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Person context</span>
          <input
            value={reporterEmail}
            onChange={(e) => setReporterEmail(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </label>

        <label className="block mb-3">
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">Logs or error text</span>
          <textarea
            value={logs}
            onChange={(e) => setLogs(e.target.value)}
            rows={14}
            className="mt-1 w-full resize-none rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-xs leading-5 text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </label>

        <div className="mb-4 grid grid-cols-3 gap-2">
          {[
            ["person", "Person"],
            ["company", "Company"],
            ["both", "Both"],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setSaveScope(value)}
              className={`rounded border px-2 py-2 text-xs transition-colors ${
                saveScope === value
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                  : "border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200"
              }`}
            >
              Save to {label}
            </button>
          ))}
        </div>

        <button
          onClick={submit}
          disabled={pending || !logs.trim()}
          className="flex w-full items-center justify-center gap-2 rounded bg-emerald-500 px-4 py-2.5 text-sm font-medium text-neutral-950 transition-colors hover:bg-emerald-400 disabled:opacity-50"
        >
          {pending ? <Loader2 size={15} className="animate-spin" /> : <Brain size={15} />}
          Analyze, ticket, and save context
        </button>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded border border-rose-900/60 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            {error}
          </div>
        )}
      </section>

      <section className="min-h-0 overflow-y-auto p-6">
        {!result ? (
          <div className="flex h-full items-center justify-center text-center">
            <div className="max-w-md">
              <FileText size={28} className="mx-auto mb-3 text-neutral-600" />
              <h2 className="text-lg font-semibold text-neutral-200">Turn raw logs into support context</h2>
              <p className="mt-2 text-sm leading-6 text-neutral-500">
                This is the real useful wedge: any MSP can paste evidence, get a diagnosis, open a
                ticket, and preserve what was learned for the next technician.
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
      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5">
        <div className="mb-2 flex items-center gap-2">
          <SeverityBadge severity={result.severity} />
          <span className="text-[11px] font-mono text-neutral-500">{result.ticketId}</span>
        </div>
        <h2 className="text-xl font-semibold tracking-tight text-neutral-100">{result.title}</h2>
        <p className="mt-3 text-sm leading-6 text-neutral-300">{result.rootCause}</p>
      </div>

      <ResultSection title="Important details" items={result.importantDetails} />
      <ResultSection title="Evidence extracted" items={result.evidence} mono />
      <ResultSection title="Suggested fixes" items={result.suggestedFixes} />

      <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">Ready-to-send user reply</div>
        <p className="text-sm leading-6 text-neutral-200">{result.userReply}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <SaveCard label="Ticket created" value={result.ticketId} ok />
        <SaveCard
          label="Person memory"
          value={result.savedPersonMemory ? result.memoryId ?? "saved" : "not saved"}
          ok={result.savedPersonMemory}
        />
        <SaveCard
          label="Company runbook"
          value={result.savedCompanyRunbook ? result.runbookId ?? "saved" : "not saved"}
          ok={result.savedCompanyRunbook}
        />
      </div>
    </div>
  );
}

function ResultSection({ title, items, mono = false }: { title: string; items: string[]; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/70 p-4">
      <div className="mb-3 text-[11px] uppercase tracking-wider text-neutral-500">{title}</div>
      <ul className="space-y-2">
        {items.map((item, i) => (
          <li key={`${item}-${i}`} className="flex items-start gap-2 text-sm leading-6 text-neutral-300">
            <CheckCircle2 size={14} className="mt-1 shrink-0 text-emerald-400" />
            <span className={mono ? "font-mono text-xs text-neutral-400" : ""}>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: LogAnalysisResult["severity"] }) {
  const cls = {
    low: "bg-neutral-700/40 text-neutral-300",
    medium: "bg-amber-500/15 text-amber-300",
    high: "bg-rose-500/15 text-rose-300",
  }[severity];
  return <span className={`rounded px-2 py-1 text-[10px] uppercase tracking-wider ${cls}`}>{severity}</span>;
}

function SaveCard({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-neutral-500">
        <Save size={12} className={ok ? "text-emerald-400" : "text-neutral-600"} />
        {label}
      </div>
      <div className={ok ? "text-xs text-emerald-300" : "text-xs text-neutral-500"}>{value}</div>
    </div>
  );
}
