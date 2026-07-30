// Per-ticket agent execution trace — the in-product view of what the
// LangGraph run actually did (node starts/finishes, interrupts, resumes).
// In-memory only (like the agent heartbeat): the UI reads it live via
// /api/state; LangSmith remains the durable trace of record.

export type TraceStatus = "started" | "completed" | "failed" | "interrupted" | "resumed";

export interface TraceEvent {
  node: string;
  status: TraceStatus;
  at: number;
  detail?: string;
  durationMs?: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __TICKET_TRACES__: Map<string, TraceEvent[]> | undefined;
}

const traces: Map<string, TraceEvent[]> = globalThis.__TICKET_TRACES__ ?? new Map();
if (!globalThis.__TICKET_TRACES__) globalThis.__TICKET_TRACES__ = traces;

export function appendTrace(
  ticketId: string,
  node: string,
  status: TraceStatus,
  detail?: string,
  durationMs?: number,
): void {
  const list = traces.get(ticketId) ?? [];
  list.push({ node, status, at: Date.now(), detail, durationMs });
  traces.set(ticketId, list);
}

export function getTrace(ticketId: string): TraceEvent[] {
  return traces.get(ticketId) ?? [];
}
