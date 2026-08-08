"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import clsx from "clsx";

interface CurrentJob {
  id: string;
  command: string;
  startedAt: number;
}

interface HeartbeatResponse {
  connected: boolean;
  hostname?: string;
  os?: string;
  lastPingAt?: number;
  ageMs?: number;
  currentJob?: CurrentJob | null;
  version?: string;
  build?: string | null;
  serverBuild?: string | null;
  staleBuild?: boolean;
}

const POLL_INTERVAL_MS = 1500;

export function AgentStatusBadge() {
  const [state, setState] = useState<HeartbeatResponse>({ connected: false });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/agent/heartbeat", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as HeartbeatResponse;
        if (!cancelled) setState(data);
      } catch {
        if (!cancelled) setState({ connected: false });
      }
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const running = state.connected && !!state.currentJob;
  // A connected agent on the wrong build runs nothing, and saying "connected"
  // about it is the lie that cost T-4935 three looks.
  const stale = state.connected && Boolean(state.staleBuild);
  const buildLine = `agent ${state.version ?? "?"} · build ${state.build ?? "unreported (too old)"}`;
  const tooltip = stale
    ? `${buildLine} — the server is serving ${state.serverBuild ?? "another build"} and hands this agent no work. Restart it: schtasks /end /tn "Bolt-it agent"; schtasks /run /tn "Bolt-it agent"`
    : running
      ? `Running ${state.currentJob!.command} on ${state.hostname ?? "local agent"} · ${buildLine}`
      : state.connected
        ? `${state.os ?? "unknown OS"} · last ping ${formatAge(state.ageMs ?? 0)} · ${buildLine}`
        : state.lastPingAt
          ? `Last seen ${formatAge(state.ageMs ?? 0)}`
          : "No machine has connected yet";

  return (
    <div
      title={tooltip}
      className={clsx(
        "hidden items-center gap-2 rounded-full px-3 py-1.5 text-[12px] md:flex",
        stale
          ? "bg-amber-50 text-amber-700"
          : running
            ? "bg-blue-50 text-blue-700"
            : state.connected
              ? "bg-emerald-50 text-emerald-700"
              : "bg-neutral-100 text-neutral-500",
      )}
    >
      {running && !stale ? (
        <Loader2 size={12} className="animate-spin" />
      ) : (
        <span
          className={clsx(
            "h-2 w-2 rounded-full",
            stale ? "bg-amber-500" : state.connected ? "bg-emerald-600" : "bg-neutral-400",
          )}
        />
      )}
      {stale
        ? `Stale agent on ${state.hostname ?? "a machine"}`
        : running
          ? `Working on ${state.hostname ?? "a machine"}`
          : state.connected
            ? `Connected to ${state.hostname ?? "a machine"}`
            : "No machine connected"}
    </div>
  );
}

function formatAge(ageMs: number): string {
  if (ageMs < 1000) return "just now";
  const s = Math.floor(ageMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
