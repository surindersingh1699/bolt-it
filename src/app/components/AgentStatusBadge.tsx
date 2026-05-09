"use client";

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import clsx from "clsx";

interface HeartbeatResponse {
  connected: boolean;
  hostname?: string;
  os?: string;
  lastPingAt?: number;
  ageMs?: number;
}

const POLL_INTERVAL_MS = 4000;

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

  const tooltip = state.connected
    ? `${state.os ?? "unknown OS"} - last ping ${formatAge(state.ageMs ?? 0)}`
    : state.lastPingAt
      ? `Last seen ${formatAge(state.ageMs ?? 0)}`
      : "No local agent has connected yet";

  return (
    <div
      title={tooltip}
      className={clsx(
        "hidden md:flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border bg-neutral-900 transition-colors",
        state.connected
          ? "border-emerald-500/30 text-emerald-200"
          : "border-neutral-800 text-neutral-400",
      )}
    >
      <Cpu size={12} />
      <span
        className={clsx(
          "w-1.5 h-1.5 rounded-full",
          state.connected ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" : "bg-neutral-600",
        )}
      />
      {state.connected ? (
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
