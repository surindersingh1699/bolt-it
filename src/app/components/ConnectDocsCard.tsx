"use client";

import { useEffect, useState, useTransition } from "react";
import { BookOpen, CheckCircle2, FolderGit2, Globe2, Loader2, Plus, Trash2, AlertCircle } from "lucide-react";
import { useAppState } from "./StateProvider";
import { NiaSource } from "@/lib/types";
import {
  connectNiaSource,
  disconnectNiaSource,
  refreshNiaSourceStatuses,
} from "@/app/actions/sources";

export function ConnectDocsCard() {
  const { integrations, refresh } = useAppState();
  const sources = integrations.niaSources;
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const hasIndexing = sources.some((s) => s.status === "indexing");

  useEffect(() => {
    if (!hasIndexing) return;
    const tick = async () => {
      try {
        await refreshNiaSourceStatuses();
        await refresh();
      } catch {
        // ignore — auth/transient
      }
    };
    const interval = setInterval(tick, 10_000);
    return () => clearInterval(interval);
  }, [hasIndexing, refresh]);

  function onAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = url.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const res = await connectNiaSource({ url: trimmed }).catch((err) => ({
        ok: false,
        error: (err as Error).message,
      }));
      if (!res.ok) {
        setError(res.error ?? "Failed to connect source");
        return;
      }
      setUrl("");
      await refresh();
    });
  }

  function onRemove(id: string) {
    startTransition(async () => {
      await disconnectNiaSource(id).catch(() => undefined);
      await refresh();
    });
  }

  return (
    <section className="px-4 py-4 border-b border-neutral-800">
      <div className="flex items-center gap-1.5 mb-3">
        <BookOpen size={12} className="text-emerald-400" />
        <span className="text-[11px] uppercase tracking-wider text-neutral-400">
          Connect docs · Nia
        </span>
        <span className="text-[10px] text-neutral-600 ml-auto">{sources.length}</span>
      </div>

      <form onSubmit={onAdd} className="flex gap-1.5 mb-2">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="github.com/org/repo or https://docs.…"
          disabled={pending}
          className="flex-1 text-[11px] bg-neutral-900/60 border border-neutral-800 rounded px-2 py-1.5 text-neutral-200 placeholder:text-neutral-600 focus:outline-none focus:border-neutral-700"
        />
        <button
          type="submit"
          disabled={pending || !url.trim()}
          className="text-[11px] px-2 py-1.5 rounded bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        >
          {pending ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          Add
        </button>
      </form>

      {error && (
        <div className="text-[10px] text-rose-300 mb-2 flex items-start gap-1">
          <AlertCircle size={10} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {sources.length === 0 ? (
        <p className="text-[11px] text-neutral-500">
          Paste a GitHub repo or docs URL (Google Docs, Notion public, anything Nia can crawl).
        </p>
      ) : (
        <ul className="space-y-1.5">
          {sources.map((s) => (
            <SourceRow key={s.id} source={s} onRemove={() => onRemove(s.id)} disabled={pending} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SourceRow({
  source,
  onRemove,
  disabled,
}: {
  source: NiaSource;
  onRemove: () => void;
  disabled: boolean;
}) {
  const Icon = source.type === "repository" ? FolderGit2 : Globe2;
  return (
    <li className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5">
      <Icon size={12} className="text-neutral-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[11px] text-neutral-200 truncate">{source.displayName}</div>
        {source.errorMessage && (
          <div className="text-[10px] text-rose-300 truncate">{source.errorMessage}</div>
        )}
      </div>
      <StatusPill status={source.status} />
      <button
        onClick={onRemove}
        disabled={disabled}
        title="Disconnect"
        className="text-neutral-500 hover:text-rose-300 disabled:opacity-50"
      >
        <Trash2 size={11} />
      </button>
    </li>
  );
}

function StatusPill({ status }: { status: NiaSource["status"] }) {
  if (status === "ready") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 flex items-center gap-1 shrink-0">
        <CheckCircle2 size={9} /> ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 flex items-center gap-1 shrink-0">
        <AlertCircle size={9} /> failed
      </span>
    );
  }
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 flex items-center gap-1 shrink-0">
      <Loader2 size={9} className="animate-spin" /> indexing
    </span>
  );
}
