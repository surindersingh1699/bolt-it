"use client";

import { useEffect, useState } from "react";
import type { FleetView } from "@/lib/fleet";

const POLL_INTERVAL_MS = 2000;

export function useFleetState(): FleetView | null {
  const [data, setData] = useState<FleetView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/fleet", { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as FleetView;
        if (!cancelled) setData(json);
      } catch {
        // keep last-known state on transient fetch failure
      }
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return data;
}
