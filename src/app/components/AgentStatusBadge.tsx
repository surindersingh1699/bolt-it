"use client";

import { useEffect, useState } from "react";
import { Cpu, Loader2 } from "lucide-react";
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
  const tooltip = running
    ? `Running ${state.currentJob!.command} on ${state.hostname ?? "local agent"}`
    : state.connected
      ? `${state.os ?? "unknown OS"} · last ping ${formatAge(state.ageMs ?? 0)}`
      : state.lastPingAt
        ? `Last seen ${formatAge(state.ageMs ?? 0)}`
        : "No local agent has connected yet";

  return (
    <>
      {running && <ScreenEdgePulse />}
      <div
        title={tooltip}
        className={clsx(
          "hidden md:flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border bg-neutral-900 transition-colors",
          running
            ? "border-cyan-400/60 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.45)]"
            : state.connected
              ? "border-emerald-500/30 text-emerald-200"
              : "border-neutral-800 text-neutral-400",
        )}
      >
        {running ? (
          <Loader2 size={12} className="animate-spin text-cyan-300" />
        ) : (
          <Cpu size={12} />
        )}
        <span
          className={clsx(
            "w-1.5 h-1.5 rounded-full",
            running
              ? "bg-cyan-300 shadow-[0_0_8px_rgba(34,211,238,0.95)] animate-pulse"
              : state.connected
                ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]"
                : "bg-neutral-600",
          )}
        />
        {running ? (
          <>
            <span className="font-medium">Running on {state.hostname ?? "local agent"}</span>
            <span className="text-[10px] text-cyan-200/80 hidden xl:inline font-mono">
              {truncate(state.currentJob!.command, 36)}
            </span>
          </>
        ) : state.connected ? (
          <>
            <span>Local agent</span>
            {state.hostname && (
              <span className="text-[10px] text-emerald-300/70 hidden xl:inline">{state.hostname}</span>
            )}
          </>
        ) : (
          <span>Local agent: offline</span>
        )}
      </div>
    </>
  );
}

function ScreenEdgePulse() {
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] bg-gradient-to-r from-cyan-400/0 via-cyan-300 to-cyan-400/0 animate-pulse" />
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] h-[3px] bg-gradient-to-r from-cyan-400/0 via-cyan-300 to-cyan-400/0 animate-pulse" />
      <div className="pointer-events-none fixed inset-y-0 left-0 z-[60] w-[3px] bg-gradient-to-b from-cyan-400/0 via-cyan-300 to-cyan-400/0 animate-pulse" />
      <div className="pointer-events-none fixed inset-y-0 right-0 z-[60] w-[3px] bg-gradient-to-b from-cyan-400/0 via-cyan-300 to-cyan-400/0 animate-pulse" />
    </>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
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
