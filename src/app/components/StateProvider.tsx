"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { Ticket, Runbook, DeflectionStat, NiaSource } from "@/lib/types";

export interface IntegrationsState {
  slackConnected: boolean;
  slackTeamName: string | null;
  niaSources: NiaSource[];
  niaEnvSources: string[];
  hyperspellMode: "mock" | "live";
}

interface AppState {
  tickets: Ticket[];
  runbooks: Runbook[];
  stats: DeflectionStat;
  integrations: IntegrationsState;
  selectedTicketId: string | null;
  selectTicket: (id: string | null) => void;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function StateProvider({ children }: { children: React.ReactNode }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [runbooks, setRunbooks] = useState<Runbook[]>([]);
  const [stats, setStats] = useState<DeflectionStat>(emptyStats());
  const [integrations, setIntegrations] = useState<IntegrationsState>(emptyIntegrations());
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setTickets(data.tickets);
    setRunbooks(data.runbooks);
    setStats(data.stats);
    if (data.integrations) setIntegrations(data.integrations);
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
      integrations,
      selectedTicketId,
      selectTicket: setSelectedTicketId,
      refresh,
    }),
    [tickets, runbooks, stats, integrations, selectedTicketId, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function emptyStats(): DeflectionStat {
  return { totalTickets: 0, aiResolved: 0, escalated: 0, avgResolutionMs: 0, rate: 0 };
}

function emptyIntegrations(): IntegrationsState {
  return {
    slackConnected: false,
    slackTeamName: null,
    niaSources: [],
    niaEnvSources: [],
    hyperspellMode: "mock",
  };
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAppState must be used inside StateProvider");
  return ctx;
}
