import { Ticket, Runbook, PlanStep, DeflectionStat } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __ITDB__: ITDB | undefined;
}

class ITDB {
  tickets: Map<string, Ticket> = new Map();
  runbooks: Map<string, Runbook> = new Map();
  subscribers: Set<() => void> = new Set();

  emit() {
    this.subscribers.forEach((cb) => cb());
  }

  subscribe(cb: () => void) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  insertTicket(t: Ticket) {
    this.tickets.set(t.id, t);
    this.emit();
  }

  updateTicket(id: string, patch: Partial<Ticket>) {
    const existing = this.tickets.get(id);
    if (!existing) return;
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    this.tickets.set(id, updated);
    this.emit();
    return updated;
  }

  updateStep(ticketId: string, stepId: string, patch: Partial<PlanStep>) {
    const t = this.tickets.get(ticketId);
    if (!t) return;
    const plan = t.plan.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
    this.tickets.set(ticketId, { ...t, plan, updatedAt: Date.now() });
    this.emit();
  }

  listTickets(): Ticket[] {
    return Array.from(this.tickets.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getTicket(id: string) {
    return this.tickets.get(id);
  }

  insertRunbook(r: Runbook) {
    this.runbooks.set(r.id, r);
    this.emit();
  }

  updateRunbook(id: string, patch: Partial<Runbook>) {
    const existing = this.runbooks.get(id);
    if (!existing) return;
    this.runbooks.set(id, { ...existing, ...patch, updatedAt: Date.now() });
    this.emit();
  }

  listRunbooks(): Runbook[] {
    return Array.from(this.runbooks.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  deflectionStats(): DeflectionStat {
    const all = this.listTickets();
    const resolved = all.filter((t) => t.status === "resolved");
    const aiResolved = resolved.filter((t) => t.resolvedByAi);
    const escalated = all.filter((t) => t.status === "escalated");
    const totalTouched = resolved.length + escalated.length;
    const avgResolutionMs =
      resolved.length > 0
        ? resolved.reduce((acc, t) => acc + (t.resolutionTimeMs ?? 0), 0) / resolved.length
        : 0;
    return {
      totalTickets: all.length,
      aiResolved: aiResolved.length,
      escalated: escalated.length,
      avgResolutionMs,
      rate: totalTouched > 0 ? aiResolved.length / totalTouched : 0,
    };
  }
}

export const db: ITDB = globalThis.__ITDB__ ?? new ITDB();
if (!globalThis.__ITDB__) globalThis.__ITDB__ = db;
