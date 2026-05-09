"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Ticket, Runbook, DeflectionStat } from "@/lib/types";

interface AppState {
  tickets: Ticket[];
  runbooks: Runbook[];
  stats: DeflectionStat;
  selectedTicketId: string | null;
  selectTicket: (id: string | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function StateProvider({ children }: { children: React.ReactNode }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [stats, setStats] = useState<DeflectionStat>(emptyStats());
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setTickets(data.tickets);
    setRunbooks(data.runbooks);
    setStats(data.stats);
    setSelectedTicketId((curr) => {
      if (curr && data.tickets.some((t: Ticket) => t.id === curr)) return curr;
      const firstActive = data.tickets.find(
        (t: Ticket) =>
          t.status === "awaiting_approval" ||
          t.status === "executing" ||
          t.status === "drafting" ||
          t.status === "new",
      );
      return firstActive?.id ?? data.tickets[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 600);
    return () => clearInterval(interval);
  }, [refresh]);

  const value = useMemo<AppState>(
    () => ({
      tickets,
      runbooks,
      stats,
      selectedTicketId,
      selectTicket: setSelectedTicketId,
      refresh,
    }),
    [tickets, runbooks, stats, selectedTicketId, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function emptyStats(): DeflectionStat {
  return { totalTickets: 0, aiResolved: 0, escalated: 0, avgResolutionMs: 0, rate: 0 };
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppState must be used inside StateProvider");
  return ctx;
}
