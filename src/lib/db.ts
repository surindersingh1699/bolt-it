import { Ticket, Runbook, PlanStep, DeflectionStat, ADUser, ADGroup, ADAccount, Workspace, AgentJob } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __ITDB__: ITDB | undefined;
}

class ITDB {
  workspaces: Map<string, Workspace> = new Map();
  tickets: Map<string, Ticket> = new Map();
  runbooks: Map<string, Runbook> = new Map();
  adUsers: Map<string, ADUser> = new Map();
  adGroups: Map<string, ADGroup> = new Map();
  adAccounts: Map<string, ADAccount> = new Map();
  agentJobs: Map<string, AgentJob> = new Map();
  subscribers: Set<() => void> = new Set();

  insertWorkspace(w: Workspace) {
    this.workspaces.set(w.id, w);
    this.emit();
  }

  getWorkspace(id: string) {
    return this.workspaces.get(id);
  }

  listWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  updateWorkspace(id: string, patch: Partial<Workspace>) {
    const existing = this.workspaces.get(id);
    if (!existing) return;
    this.workspaces.set(id, { ...existing, ...patch, updatedAt: Date.now() });
    this.emit();
  }

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

  listTickets(workspaceId?: string): Ticket[] {
    const all = Array.from(this.tickets.values());
    const scoped = workspaceId ? all.filter((t) => t.workspaceId === workspaceId) : all;
    return scoped.sort((a, b) => b.createdAt - a.createdAt);
  }

  getTicket(id: string, workspaceId?: string) {
    const t = this.tickets.get(id);
    if (!t) return undefined;
    if (workspaceId && t.workspaceId !== workspaceId) return undefined;
    return t;
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

  listRunbooks(workspaceId?: string): Runbook[] {
    const all = Array.from(this.runbooks.values());
    const scoped = workspaceId ? all.filter((r) => r.workspaceId === workspaceId) : all;
    return scoped.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  insertADUser(u: ADUser) {
    this.adUsers.set(`${u.workspaceId}:${u.email}`, u);
    this.emit();
  }

  getADUser(email: string, workspaceId?: string) {
    if (workspaceId) return this.adUsers.get(`${workspaceId}:${email}`);
    for (const u of this.adUsers.values()) {
      if (u.email === email) return u;
    }
    return undefined;
  }

  listADUsers(workspaceId?: string): ADUser[] {
    const all = Array.from(this.adUsers.values());
    const scoped = workspaceId ? all.filter((u) => u.workspaceId === workspaceId) : all;
    return scoped.sort((a, b) => a.name.localeCompare(b.name));
  }

  updateADUser(email: string, patch: Partial<ADUser>, workspaceId?: string) {
    const existing = this.getADUser(email, workspaceId);
    if (!existing) return;
    this.adUsers.set(`${existing.workspaceId}:${existing.email}`, { ...existing, ...patch });
    this.emit();
  }

  insertADGroup(g: ADGroup) {
    this.adGroups.set(`${g.workspaceId}:${g.id}`, g);
    this.emit();
  }

  listADGroups(workspaceId?: string): ADGroup[] {
    const all = Array.from(this.adGroups.values());
    return workspaceId ? all.filter((g) => g.workspaceId === workspaceId) : all;
  }

  insertADAccount(a: ADAccount) {
    this.adAccounts.set(`${a.workspaceId}:${a.email}`, a);
    this.emit();
  }

  getADAccount(email: string, workspaceId?: string) {
    if (workspaceId) return this.adAccounts.get(`${workspaceId}:${email}`);
    for (const a of this.adAccounts.values()) {
      if (a.email === email) return a;
    }
    return undefined;
  }

  listADAccounts(workspaceId?: string): ADAccount[] {
    const all = Array.from(this.adAccounts.values());
    return workspaceId ? all.filter((a) => a.workspaceId === workspaceId) : all;
  }

  updateADAccount(email: string, patch: Partial<ADAccount>, workspaceId?: string) {
    const existing = this.getADAccount(email, workspaceId);
    if (!existing) return;
    this.adAccounts.set(`${existing.workspaceId}:${existing.email}`, { ...existing, ...patch });
    this.emit();
  }

  insertAgentJob(job: AgentJob) {
    this.agentJobs.set(job.id, job);
    this.emit();
  }

  getAgentJob(id: string) {
    return this.agentJobs.get(id);
  }

  listAgentJobs(workspaceId?: string, status?: AgentJob["status"]): AgentJob[] {
    const all = Array.from(this.agentJobs.values());
    return all
      .filter((j) => (!workspaceId || j.workspaceId === workspaceId) && (!status || j.status === status))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  updateAgentJob(id: string, patch: Partial<AgentJob>) {
    const existing = this.agentJobs.get(id);
    if (!existing) return;
    this.agentJobs.set(id, { ...existing, ...patch, updatedAt: Date.now() });
    this.emit();
  }

  clearTicketsForWorkspace(workspaceId: string): { tickets: number; agentJobs: number } {
    let tickets = 0;
    for (const [id, t] of this.tickets) {
      if (t.workspaceId === workspaceId) {
        this.tickets.delete(id);
        tickets++;
      }
    }
    let agentJobs = 0;
    for (const [id, j] of this.agentJobs) {
      if (j.workspaceId === workspaceId) {
        this.agentJobs.delete(id);
        agentJobs++;
      }
    }
    if (tickets > 0 || agentJobs > 0) this.emit();
    return { tickets, agentJobs };
  }

  deflectionStats(workspaceId?: string): DeflectionStat {
    const all = this.listTickets(workspaceId);
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
