"use client";

import { useAppState } from "./StateProvider";
import { BookOpen, TrendingUp } from "lucide-react";

export function RunbooksTab() {
  const { runbooks } = useAppState();

  return (
    <div className="h-[calc(100vh-99px)] overflow-y-auto px-8 py-6 max-w-5xl mx-auto">
      <div className="flex items-baseline gap-3 mb-1">
        <h2 className="text-lg font-semibold">Runbook library</h2>
        <span className="text-sm text-neutral-500">{runbooks.length} entries</span>
      </div>
      <p className="text-sm text-neutral-500 mb-6 max-w-2xl">
        Every resolved ticket extracts back to a runbook. The next identical ticket resolves faster — that&apos;s the moat. New entries are auto-indexed in Nia.
      </p>

      <ul className="space-y-3">
        {runbooks.map((rb) => (
          <li
            key={rb.id}
            className="bg-neutral-900/60 border border-neutral-800 rounded-lg p-4"
          >
            <div className="flex items-start gap-3">
              <BookOpen size={16} className="text-emerald-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-1">
                  <h3 className="font-medium text-neutral-100">{rb.title}</h3>
                  <span className="text-[10px] font-mono text-neutral-600">{rb.id}</span>
                </div>
                <p className="text-sm text-neutral-400 leading-relaxed mb-3">{rb.body}</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {rb.tags.map((t) => (
                    <span
                      key={t}
                      className="bg-neutral-800 text-neutral-400 px-2 py-0.5 rounded text-[11px]"
                    >
                      {t}
                    </span>
                  ))}
                  <span className="text-neutral-600 ml-auto flex items-center gap-1">
                    <TrendingUp size={11} className="text-emerald-400" />
                    <span className="text-emerald-300">{rb.successCount}</span>
                    <span>resolutions</span>
                    {rb.failureCount > 0 && (
                      <span className="text-neutral-500"> · {rb.failureCount} failed</span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
