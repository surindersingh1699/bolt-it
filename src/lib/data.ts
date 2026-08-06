import { db } from "./db";
import { getInsforge, isInsforgeEnabled } from "./insforge-client";
import {
  ADAccount,
  ADAccountStatus,
  ADGroup,
  ADUser,
  AgentJob,
  Citation,
  Device,
  PlanStep,
  Ticket,
  TicketStatus,
  Workspace,
} from "./types";
import {
  EMPTY_MEMORY,
  EPISODE_WINDOW,
  MemoryKind,
  UserMemory,
  isFactKey,
} from "./memory";
import { IncidentCategory, IncidentRecord } from "./incidents";

type DbRow = Record<string, unknown>;

// Short-TTL read cache for hot InsForge list queries. /api/state polls every
// 600ms and was issuing 3+ InsForge queries per tick — enough to trip their
// per-IP rate limit. 2s of staleness is invisible at UI polling cadence;
// writes invalidate immediately. On backend errors we serve the last good
// value instead of 500ing every page (same spirit as the auth cache).
const READ_CACHE_TTL_MS = 2_000;
const readCache = new Map<string, { value: unknown; expiresAt: number }>();
function cacheGet<T>(key: string): T | undefined {
  const hit = readCache.get(key);
  return hit && hit.expiresAt > Date.now() ? (hit.value as T) : undefined;
}
function cacheSet(key: string, value: unknown, ttlMs: number = READ_CACHE_TTL_MS): void {
  readCache.set(key, { value, expiresAt: Date.now() + ttlMs });
}
function cacheStale<T>(key: string): T | undefined {
  return readCache.get(key)?.value as T | undefined;
}
function cacheInvalidate(prefix: string): void {
  for (const k of readCache.keys()) if (k.startsWith(prefix)) readCache.delete(k);
}

function workspaceToRow(w: Workspace): DbRow {
  return {
    id: w.id,
    display_name: w.displayName,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
  };
}

function workspaceFromRow(r: DbRow): Workspace {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function ticketToRow(t: Ticket): DbRow {
  return {
    id: t.id,
    workspace_id: t.workspaceId,
    customer_org: t.customerOrg,
    channel: t.channel,
    reporter: t.reporter,
    reporter_email: t.reporterEmail,
    subject: t.subject,
    body: t.body,
    status: t.status,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    resolved_at: t.resolvedAt ?? null,
    draft_response: t.draftResponse ?? null,
    plan: t.plan,
    citations: t.citations,
    confidence: t.confidence,
    resolved_by_ai: t.resolvedByAi,
    resolution_time_ms: t.resolutionTimeMs ?? null,
    troubleshooting_summary: t.troubleshootingSummary ?? null,
    attempts: t.attempts ?? null,
    tier: t.tier ?? null,
  };
}

function ticketFromRow(r: DbRow): Ticket {
  return {
    id: r.id as string,
    workspaceId: (r.workspace_id as string) ?? "acme.test",
    customerOrg: r.customer_org as string,
    channel: r.channel as Ticket["channel"],
    reporter: r.reporter as string,
    reporterEmail: r.reporter_email as string,
    subject: r.subject as string,
    body: r.body as string,
    status: r.status as TicketStatus,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    resolvedAt: r.resolved_at == null ? undefined : Number(r.resolved_at),
    draftResponse: (r.draft_response as string | null) ?? undefined,
    plan: (r.plan as PlanStep[] | null) ?? [],
    citations: (r.citations as Citation[] | null) ?? [],
    confidence: Number(r.confidence ?? 0),
    resolvedByAi: Boolean(r.resolved_by_ai),
    resolutionTimeMs: r.resolution_time_ms == null ? undefined : Number(r.resolution_time_ms),
    troubleshootingSummary: (r.troubleshooting_summary as string) ?? undefined,
    attempts: r.attempts == null ? undefined : Number(r.attempts),
    tier: r.tier == null ? undefined : (Number(r.tier) as Ticket["tier"]),
  };
}

function ticketPatchToRow(patch: Partial<Ticket>): DbRow {
  const out: DbRow = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.draftResponse !== undefined) out.draft_response = patch.draftResponse;
  if (patch.plan !== undefined) out.plan = patch.plan;
  if (patch.citations !== undefined) out.citations = patch.citations;
  if (patch.confidence !== undefined) out.confidence = patch.confidence;
  if (patch.resolvedByAi !== undefined) out.resolved_by_ai = patch.resolvedByAi;
  if (patch.resolvedAt !== undefined) out.resolved_at = patch.resolvedAt;
  if (patch.resolutionTimeMs !== undefined) out.resolution_time_ms = patch.resolutionTimeMs;
  if (patch.troubleshootingSummary !== undefined) out.troubleshooting_summary = patch.troubleshootingSummary;
  if (patch.attempts !== undefined) out.attempts = patch.attempts;
  if (patch.tier !== undefined) out.tier = patch.tier;
  out.updated_at = Date.now();
  return out;
}

function adUserToRow(u: ADUser): DbRow {
  return {
    email: u.email,
    workspace_id: u.workspaceId,
    name: u.name,
    password_hash: u.passwordHash,
    team: u.team,
    title: u.title,
    manager: u.manager ?? null,
    groups: u.groups,
    is_it_staff: u.isITStaff,
    created_at: u.createdAt,
  };
}

function adUserFromRow(r: DbRow): ADUser {
  return {
    email: r.email as string,
    workspaceId: (r.workspace_id as string) ?? "acme.test",
    name: r.name as string,
    passwordHash: r.password_hash as string,
    team: r.team as string,
    title: r.title as string,
    manager: (r.manager as string | null) ?? undefined,
    groups: (r.groups as string[] | null) ?? [],
    isITStaff: Boolean(r.is_it_staff),
    createdAt: Number(r.created_at),
  };
}

function adUserPatchToRow(patch: Partial<ADUser>): DbRow {
  const out: DbRow = {};
  if (patch.name !== undefined) out.name = patch.name;
  if (patch.passwordHash !== undefined) out.password_hash = patch.passwordHash;
  if (patch.team !== undefined) out.team = patch.team;
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.manager !== undefined) out.manager = patch.manager;
  if (patch.groups !== undefined) out.groups = patch.groups;
  if (patch.isITStaff !== undefined) out.is_it_staff = patch.isITStaff;
  return out;
}

function adGroupToRow(g: ADGroup): DbRow {
  return {
    id: g.id,
    workspace_id: g.workspaceId,
    name: g.name,
    description: g.description,
    members: g.members,
  };
}

function adGroupFromRow(r: DbRow): ADGroup {
  return {
    id: r.id as string,
    workspaceId: (r.workspace_id as string) ?? "acme.test",
    name: r.name as string,
    description: r.description as string,
    members: (r.members as string[] | null) ?? [],
  };
}

function adAccountToRow(a: ADAccount): DbRow {
  return {
    email: a.email,
    workspace_id: a.workspaceId,
    status: a.status,
    failed_login_count: a.failedLoginCount,
    locked_at: a.lockedAt ?? null,
    password_changed_at: a.passwordChangedAt,
    password_expires_at: a.passwordExpiresAt,
    last_login_at: a.lastLoginAt ?? null,
    last_login_host: a.lastLoginHost ?? null,
    kerberos_ticket_at: a.kerberosTicketAt ?? null,
  };
}

function adAccountFromRow(r: DbRow): ADAccount {
  return {
    email: r.email as string,
    workspaceId: (r.workspace_id as string) ?? "acme.test",
    status: r.status as ADAccountStatus,
    failedLoginCount: Number(r.failed_login_count ?? 0),
    lockedAt: r.locked_at == null ? undefined : Number(r.locked_at),
    passwordChangedAt: Number(r.password_changed_at),
    passwordExpiresAt: Number(r.password_expires_at),
    lastLoginAt: r.last_login_at == null ? undefined : Number(r.last_login_at),
    lastLoginHost: (r.last_login_host as string | null) ?? undefined,
    kerberosTicketAt:
      r.kerberos_ticket_at == null ? undefined : Number(r.kerberos_ticket_at),
  };
}

function adAccountPatchToRow(patch: Partial<ADAccount>): DbRow {
  const out: DbRow = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.failedLoginCount !== undefined) out.failed_login_count = patch.failedLoginCount;
  if (patch.lockedAt !== undefined) out.locked_at = patch.lockedAt;
  if (patch.passwordChangedAt !== undefined) out.password_changed_at = patch.passwordChangedAt;
  if (patch.passwordExpiresAt !== undefined) out.password_expires_at = patch.passwordExpiresAt;
  if (patch.lastLoginAt !== undefined) out.last_login_at = patch.lastLoginAt;
  if (patch.lastLoginHost !== undefined) out.last_login_host = patch.lastLoginHost;
  if (patch.kerberosTicketAt !== undefined) out.kerberos_ticket_at = patch.kerberosTicketAt;
  return out;
}

function agentJobToRow(j: AgentJob): DbRow {
  return {
    id: j.id,
    workspace_id: j.workspaceId,
    ticket_id: j.ticketId,
    step_id: j.stepId ?? null,
    kind: j.kind,
    target_user_email: j.targetUserEmail,
    instructions: j.instructions,
    allowlisted_command: j.allowlistedCommand,
    status: j.status,
    created_at: j.createdAt,
    updated_at: j.updatedAt,
    claimed_at: j.claimedAt ?? null,
    completed_at: j.completedAt ?? null,
    output: j.output ?? null,
    error: j.error ?? null,
    envelope: j.envelope ?? null,
    effect_changed: j.effectChanged ?? null,
    effect_summary: j.effectSummary ?? null,
  };
}

function agentJobFromRow(r: DbRow): AgentJob {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    ticketId: r.ticket_id as string,
    stepId: (r.step_id as string | null) ?? undefined,
    kind: r.kind as AgentJob["kind"],
    targetUserEmail: r.target_user_email as string,
    instructions: r.instructions as string,
    allowlistedCommand: r.allowlisted_command as string,
    status: r.status as AgentJob["status"],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    claimedAt: r.claimed_at == null ? undefined : Number(r.claimed_at),
    completedAt: r.completed_at == null ? undefined : Number(r.completed_at),
    output: (r.output as string | null) ?? undefined,
    error: (r.error as string | null) ?? undefined,
    envelope: (r.envelope as AgentJob["envelope"] | null) ?? undefined,
    effectChanged: (r.effect_changed as boolean | null) ?? undefined,
    effectSummary: (r.effect_summary as string | null) ?? undefined,
  };
}

function agentJobPatchToRow(patch: Partial<AgentJob>): DbRow {
  const out: DbRow = {};
  if (patch.status !== undefined) out.status = patch.status;
  if (patch.claimedAt !== undefined) out.claimed_at = patch.claimedAt;
  if (patch.completedAt !== undefined) out.completed_at = patch.completedAt;
  if (patch.output !== undefined) out.output = patch.output;
  if (patch.error !== undefined) out.error = patch.error;
  if (patch.envelope !== undefined) out.envelope = patch.envelope;
  if (patch.effectChanged !== undefined) out.effect_changed = patch.effectChanged;
  if (patch.effectSummary !== undefined) out.effect_summary = patch.effectSummary;
  out.updated_at = Date.now();
  return out;
}

function ifErr(error: unknown, op: string): void {
  if (error) {
    const msg =
      (error as { message?: string }).message ??
      (typeof error === "object" ? JSON.stringify(error) : String(error));
    throw new Error(`[InsForge] ${op}: ${msg}`);
  }
}

function isMissingRelationError(error: unknown): boolean {
  if (!error) return false;
  const text =
    (error as { message?: string }).message ??
    (typeof error === "object" ? JSON.stringify(error) : String(error));
  return /agent_jobs|relation|does not exist|schema cache|not found/i.test(text);
}

// Workspace CRUD

export async function insertWorkspace(w: Workspace): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    try {
      const { error } = await ifg.database.from("workspaces").insert([workspaceToRow(w)]);
      if (!error) return;
      console.warn("[InsForge] insertWorkspace failed — falling back to in-memory:", JSON.stringify(error));
    } catch (err) {
      console.warn("[InsForge] insertWorkspace threw — falling back to in-memory:", (err as Error).message);
    }
  }
  db.insertWorkspace(w);
}

export async function getWorkspace(id: string): Promise<Workspace | undefined> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const key = `workspace:${id}`;
    const cached = cacheGet<Workspace | null>(key);
    if (cached !== undefined) return cached ?? db.getWorkspace(id);
    let data: unknown, error: unknown;
    try {
      ({ data, error } = await ifg.database.from("workspaces").select().eq("id", id).maybeSingle());
      ifErr(error, "getWorkspace");
    } catch (err) {
      const stale = cacheStale<Workspace | null>(key);
      if (stale !== undefined) return stale ?? db.getWorkspace(id);
      throw err;
    }
    cacheSet(key, data ? workspaceFromRow(data as DbRow) : null, 10_000);
    if (data) return workspaceFromRow(data as DbRow);
    // No row in InsForge — this workspace may only exist in the in-memory
    // fallback (e.g. its insertWorkspace() call itself fell back due to a
    // schema mismatch). Check there before giving up, same spirit as
    // insertWorkspace()'s own fallback.
    return db.getWorkspace(id);
  }
  return db.getWorkspace(id);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { data, error } = await ifg.database.from("workspaces").select();
    ifErr(error, "listWorkspaces");
    return ((data as DbRow[]) ?? []).map(workspaceFromRow);
  }
  return db.listWorkspaces();
}

export async function updateWorkspace(id: string, patch: Partial<Workspace>): Promise<void> {
  const row: DbRow = {};
  if (patch.displayName !== undefined) row.display_name = patch.displayName;
  row.updated_at = Date.now();
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("workspaces").update(row).eq("id", id);
    ifErr(error, "updateWorkspace");
    cacheInvalidate("workspace:");
  }
  // InsForge's update() succeeds silently even when zero rows match (e.g. this
  // workspace's insertWorkspace() call fell back to in-memory due to a schema
  // mismatch, so InsForge never had a row to update in the first place).
  // Mirror into the in-memory store whenever it already has this workspace,
  // so a workspace that lives there doesn't silently lose writes.
  if (!ifg || db.getWorkspace(id)) db.updateWorkspace(id, patch);
}

// Tickets

export async function insertTicket(t: Ticket): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("tickets").insert([ticketToRow(t)]);
    ifErr(error, "insertTicket");
    cacheInvalidate("tickets:");
    return;
  }
  db.insertTicket(t);
}

export async function updateTicket(id: string, patch: Partial<Ticket>): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const row = ticketPatchToRow(patch);
    if (Object.keys(row).length === 0) return;
    const { error } = await ifg.database.from("tickets").update(row).eq("id", id);
    ifErr(error, "updateTicket");
    cacheInvalidate("tickets:");
    return;
  }
  db.updateTicket(id, patch);
}

export async function updateStep(
  ticketId: string,
  stepId: string,
  patch: Partial<PlanStep>,
): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const ticket = await getTicket(ticketId);
    if (!ticket) return;
    const newPlan = ticket.plan.map((s) => (s.id === stepId ? { ...s, ...patch } : s));
    const { error } = await ifg.database
      .from("tickets")
      .update({ plan: newPlan, updated_at: Date.now() })
      .eq("id", ticketId);
    ifErr(error, "updateStep");
    cacheInvalidate("tickets:");
    return;
  }
  db.updateStep(ticketId, stepId, patch);
}

export async function listTickets(workspaceId?: string): Promise<Ticket[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const key = `tickets:${workspaceId ?? "*"}`;
    const cached = cacheGet<Ticket[]>(key);
    if (cached) return cached;
    try {
      let q = ifg.database.from("tickets").select();
      if (workspaceId) q = q.eq("workspace_id", workspaceId);
      const { data, error } = await q.order("created_at", { ascending: false });
      ifErr(error, "listTickets");
      const out = ((data as DbRow[]) ?? []).map(ticketFromRow);
      cacheSet(key, out);
      return out;
    } catch (err) {
      const stale = cacheStale<Ticket[]>(key);
      if (stale) {
        console.warn("[data] listTickets failed, serving stale cache:", (err as Error).message);
        return stale;
      }
      throw err;
    }
  }
  return db.listTickets(workspaceId);
}

export async function getTicket(id: string, workspaceId?: string): Promise<Ticket | undefined> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    let q = ifg.database.from("tickets").select().eq("id", id);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q.maybeSingle();
    ifErr(error, "getTicket");
    return data ? ticketFromRow(data as DbRow) : undefined;
  }
  return db.getTicket(id, workspaceId);
}

// AD users / groups / accounts

export async function insertADUser(u: ADUser): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("ad_users").insert([adUserToRow(u)]);
    ifErr(error, "insertADUser");
    cacheInvalidate("ad_users:");
    return;
  }
  db.insertADUser(u);
}

export async function getADUser(email: string, workspaceId?: string): Promise<ADUser | undefined> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    let q = ifg.database.from("ad_users").select().eq("email", email);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q.maybeSingle();
    ifErr(error, "getADUser");
    return data ? adUserFromRow(data as DbRow) : undefined;
  }
  return db.getADUser(email, workspaceId);
}

export async function listADUsers(workspaceId?: string): Promise<ADUser[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const key = `ad_users:${workspaceId ?? "*"}`;
    const cached = cacheGet<ADUser[]>(key);
    if (cached) return cached;
    try {
      let q = ifg.database.from("ad_users").select();
      if (workspaceId) q = q.eq("workspace_id", workspaceId);
      const { data, error } = await q;
      ifErr(error, "listADUsers");
      const out = ((data as DbRow[]) ?? []).map(adUserFromRow);
      cacheSet(key, out, 5_000);
      return out;
    } catch (err) {
      const stale = cacheStale<ADUser[]>(key);
      if (stale) return stale;
      throw err;
    }
  }
  return db.listADUsers(workspaceId);
}

export async function updateADUser(
  email: string,
  patch: Partial<ADUser>,
  workspaceId?: string,
): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const row = adUserPatchToRow(patch);
    if (Object.keys(row).length === 0) return;
    let q = ifg.database.from("ad_users").update(row).eq("email", email);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { error } = await q;
    ifErr(error, "updateADUser");
    cacheInvalidate("ad_users:");
    return;
  }
  db.updateADUser(email, patch, workspaceId);
}

export async function insertADGroup(g: ADGroup): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("ad_groups").insert([adGroupToRow(g)]);
    ifErr(error, "insertADGroup");
    return;
  }
  db.insertADGroup(g);
}

export async function listADGroups(workspaceId?: string): Promise<ADGroup[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    let q = ifg.database.from("ad_groups").select();
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q;
    ifErr(error, "listADGroups");
    return ((data as DbRow[]) ?? []).map(adGroupFromRow);
  }
  return db.listADGroups(workspaceId);
}

export async function insertADAccount(a: ADAccount): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("ad_accounts").insert([adAccountToRow(a)]);
    ifErr(error, "insertADAccount");
    cacheInvalidate("ad_accounts:");
    return;
  }
  db.insertADAccount(a);
}

export async function getADAccount(
  email: string,
  workspaceId?: string,
): Promise<ADAccount | undefined> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    let q = ifg.database.from("ad_accounts").select().eq("email", email);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q.maybeSingle();
    ifErr(error, "getADAccount");
    return data ? adAccountFromRow(data as DbRow) : undefined;
  }
  return db.getADAccount(email, workspaceId);
}

export async function listADAccounts(workspaceId?: string): Promise<ADAccount[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const key = `ad_accounts:${workspaceId ?? "*"}`;
    const cached = cacheGet<ADAccount[]>(key);
    if (cached) return cached;
    try {
      let q = ifg.database.from("ad_accounts").select();
      if (workspaceId) q = q.eq("workspace_id", workspaceId);
      const { data, error } = await q;
      ifErr(error, "listADAccounts");
      const out = ((data as DbRow[]) ?? []).map(adAccountFromRow);
      cacheSet(key, out, 5_000);
      return out;
    } catch (err) {
      const stale = cacheStale<ADAccount[]>(key);
      if (stale) return stale;
      throw err;
    }
  }
  return db.listADAccounts(workspaceId);
}

export async function updateADAccount(
  email: string,
  patch: Partial<ADAccount>,
  workspaceId?: string,
): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const row = adAccountPatchToRow(patch);
    if (Object.keys(row).length === 0) return;
    let q = ifg.database.from("ad_accounts").update(row).eq("email", email);
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { error } = await q;
    ifErr(error, "updateADAccount");
    cacheInvalidate("ad_accounts:");
    return;
  }
  db.updateADAccount(email, patch, workspaceId);
}

// Devices — in-memory only for now (no isInsforgeEnabled() branch).
// TODO(insforge): add an ifg branch once ad_* schema drift (nia_sources
// column missing) is resolved — no sense adding a new table to a backend
// that's already failing on an existing one.

export async function insertDevice(d: Device): Promise<void> {
  db.insertDevice(d);
}

export async function getDevice(hostname: string, workspaceId?: string): Promise<Device | undefined> {
  return db.getDevice(hostname, workspaceId);
}

export async function listDevices(workspaceId?: string): Promise<Device[]> {
  return db.listDevices(workspaceId);
}

export async function updateDevice(id: string, patch: Partial<Device>): Promise<void> {
  db.updateDevice(id, patch);
}

// Agent jobs

export async function insertAgentJob(job: AgentJob): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    try {
      const { error } = await ifg.database.from("agent_jobs").insert([agentJobToRow(job)]);
      if (!error) return;
      console.warn("[InsForge] insertAgentJob failed — falling back to in-memory queue:", JSON.stringify(error));
    } catch (err) {
      console.warn("[InsForge] insertAgentJob threw — falling back to in-memory queue:", (err as Error).message);
    }
  }
  cacheInvalidate("agentjobs:");
  db.insertAgentJob(job);
}

export async function getAgentJob(id: string): Promise<AgentJob | undefined> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    try {
      const { data, error } = await ifg.database
        .from("agent_jobs")
        .select()
        .eq("id", id)
        .maybeSingle();
      if (!error) return data ? agentJobFromRow(data as DbRow) : db.getAgentJob(id);
    } catch {
      /* fall through */
    }
  }
  return db.getAgentJob(id);
}

export async function listAgentJobs(
  workspaceId?: string,
  status?: AgentJob["status"],
): Promise<AgentJob[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const key = `agentjobs:${workspaceId ?? "*"}:${status ?? "*"}`;
    const cached = cacheGet<AgentJob[]>(key);
    if (cached && cached.length > 0) return cached;
    try {
      let q = ifg.database.from("agent_jobs").select();
      if (workspaceId) q = q.eq("workspace_id", workspaceId);
      if (status) q = q.eq("status", status);
      const { data, error } = await q.order("created_at", { ascending: true });
      if (!error) {
        const remote = ((data as DbRow[]) ?? []).map(agentJobFromRow);
        cacheSet(key, remote, 1_500);
        if (remote.length > 0) return remote;
      }
    } catch {
      /* fall through */
    }
  }
  return db.listAgentJobs(workspaceId, status);
}

export async function updateAgentJob(id: string, patch: Partial<AgentJob>): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    try {
      const { error } = await ifg.database.from("agent_jobs").update(agentJobPatchToRow(patch)).eq("id", id);
      if (!error) return;
    } catch {
      /* fall through */
    }
  }
  db.updateAgentJob(id, patch);
}

// Bulk re-tag — used by claimDemoWorkspace to migrate demo rows to a real workspace.
export async function reassignWorkspace(
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    for (const table of ["tickets", "ad_users", "ad_groups", "ad_accounts", "agent_jobs"] as const) {
      const { error } = await ifg.database
        .from(table)
        .update({ workspace_id: toWorkspaceId })
        .eq("workspace_id", fromWorkspaceId);
      // Agent jobs were added after the original demo schema. Demo claim should
      // not block signup when the optional local-agent table is not migrated yet.
      if (table === "agent_jobs" && isMissingRelationError(error)) continue;
      ifErr(error, `reassignWorkspace(${table})`);
    }
    return;
  }
  for (const t of db.listTickets(fromWorkspaceId)) t.workspaceId = toWorkspaceId;
  for (const u of db.listADUsers(fromWorkspaceId)) u.workspaceId = toWorkspaceId;
  for (const g of db.listADGroups(fromWorkspaceId)) g.workspaceId = toWorkspaceId;
  for (const a of db.listADAccounts(fromWorkspaceId)) a.workspaceId = toWorkspaceId;
  for (const j of db.listAgentJobs(fromWorkspaceId)) j.workspaceId = toWorkspaceId;
}

export async function clearTicketsAndJobsForWorkspace(
  workspaceId: string,
): Promise<{ tickets: number; agentJobs: number }> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const before = await listTickets(workspaceId);
    try {
      const { error } = await ifg.database.from("tickets").delete().eq("workspace_id", workspaceId);
      if (error) console.warn("[InsForge] clear tickets failed:", JSON.stringify(error));
    } catch (err) {
      console.warn("[InsForge] clear tickets threw:", (err as Error).message);
    }
    try {
      const { error } = await ifg.database.from("agent_jobs").delete().eq("workspace_id", workspaceId);
      if (error && !isMissingRelationError(error)) {
        console.warn("[InsForge] clear agent_jobs failed:", JSON.stringify(error));
      }
    } catch (err) {
      console.warn("[InsForge] clear agent_jobs threw:", (err as Error).message);
    }
    const inMem = db.clearTicketsForWorkspace(workspaceId);
    return {
      tickets: Math.max(before.length, inMem.tickets),
      agentJobs: inMem.agentJobs,
    };
  }
  return db.clearTicketsForWorkspace(workspaceId);
}

// ---- user memory -----------------------------------------------------------
// New in m12. InsForge-only: there is no in-memory mirror to keep in sync, and
// memory that vanishes on restart is worse than no memory at all.

function memoryRowId(workspaceId: string, email: string, kind: MemoryKind, key: string): string {
  return `${workspaceId}:${email.toLowerCase()}:${kind}:${key}`;
}

export async function getUserMemory(workspaceId: string, email: string): Promise<UserMemory> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (!ifg) return EMPTY_MEMORY;
  const key = `memory:${workspaceId}:${email.toLowerCase()}`;
  const cached = cacheGet<UserMemory>(key);
  if (cached) return cached;
  try {
    const { data, error } = await ifg.database
      .from("user_memory")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("user_email", email.toLowerCase())
      .order("updated_at", { ascending: false });
    if (error) throw new Error(JSON.stringify(error));
    const rows = (data as DbRow[]) ?? [];
    const memory: UserMemory = {
      facts: rows
        .filter((r) => r.kind === "fact")
        .map((r) => ({
          key: String(r.fact_key ?? ""),
          value: String(r.value ?? ""),
          updatedAt: Number(r.updated_at),
        })),
      episodes: rows
        .filter((r) => r.kind === "episode")
        .slice(0, EPISODE_WINDOW)
        .map((r) => ({
          ticketId: String(r.ticket_id ?? ""),
          summary: String(r.value ?? ""),
          at: Number(r.updated_at),
        })),
    };
    cacheSet(key, memory);
    return memory;
  } catch (err) {
    console.warn("[InsForge] getUserMemory failed:", (err as Error).message);
    return cacheStale<UserMemory>(key) ?? EMPTY_MEMORY;
  }
}

/** Upsert a keyed fact. Re-learning the same key overwrites, never duplicates. */
export async function rememberUserFact(
  workspaceId: string,
  email: string,
  factKey: string,
  value: string,
): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (!ifg || !isFactKey(factKey)) return;
  const now = Date.now();
  const row: DbRow = {
    id: memoryRowId(workspaceId, email, "fact", factKey),
    workspace_id: workspaceId,
    user_email: email.toLowerCase(),
    kind: "fact",
    fact_key: factKey,
    value: value.slice(0, 300),
    ticket_id: null,
    created_at: now,
    updated_at: now,
  };
  try {
    const existing = await ifg.database.from("user_memory").select().eq("id", row.id as string).maybeSingle();
    if (existing.data) {
      await ifg.database
        .from("user_memory")
        .update({ value: row.value, updated_at: now })
        .eq("id", row.id as string);
    } else {
      await ifg.database.from("user_memory").insert([row]);
    }
    cacheInvalidate(`memory:${workspaceId}:${email.toLowerCase()}`);
  } catch (err) {
    console.warn("[InsForge] rememberUserFact failed:", (err as Error).message);
  }
}

/** Append one line of history for a ticket. Idempotent per ticket. */
export async function rememberUserEpisode(
  workspaceId: string,
  email: string,
  ticketId: string,
  summary: string,
): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (!ifg) return;
  const now = Date.now();
  try {
    await ifg.database.from("user_memory").insert([
      {
        id: memoryRowId(workspaceId, email, "episode", ticketId),
        workspace_id: workspaceId,
        user_email: email.toLowerCase(),
        kind: "episode",
        fact_key: null,
        value: summary.slice(0, 500),
        ticket_id: ticketId,
        created_at: now,
        updated_at: now,
      },
    ]);
    cacheInvalidate(`memory:${workspaceId}:${email.toLowerCase()}`);
  } catch (err) {
    console.warn("[InsForge] rememberUserEpisode failed:", (err as Error).message);
  }
}

// ---- incident memory -------------------------------------------------------
// Cross-user history keyed by problem class, not by person. Same storage
// posture as user memory: InsForge-only, no in-memory mirror, and every failure
// degrades to "no history" rather than throwing — a ticket must never fail
// because we could not read what happened last time.

export async function listIncidents(
  workspaceId: string,
  category: IncidentCategory,
): Promise<IncidentRecord[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (!ifg) return [];
  const key = `incidents:${workspaceId}:${category}`;
  const cached = cacheGet<IncidentRecord[]>(key);
  if (cached) return cached;
  try {
    const { data, error } = await ifg.database
      .from("incident_memory")
      .select()
      .eq("workspace_id", workspaceId)
      .eq("category", category)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw new Error(JSON.stringify(error));
    const rows = ((data as DbRow[]) ?? []).map(rowToIncident);
    cacheSet(key, rows);
    return rows;
  } catch (err) {
    console.warn("[InsForge] listIncidents failed:", (err as Error).message);
    return cacheStale<IncidentRecord[]>(key) ?? [];
  }
}

function rowToIncident(r: DbRow): IncidentRecord {
  const raw = r.capabilities_used;
  return {
    id: String(r.id ?? ""),
    workspaceId: String(r.workspace_id ?? ""),
    ticketId: String(r.ticket_id ?? ""),
    category: String(r.category ?? "other") as IncidentCategory,
    symptom: String(r.symptom ?? ""),
    tier: Number(r.tier ?? 1),
    // Stored as a JSON array; tolerate a string in case a row was written by an
    // older writer, because a parse failure here would poison the whole bucket.
    capabilitiesUsed: Array.isArray(raw)
      ? raw.map(String)
      : typeof raw === "string"
        ? safeParseArray(raw)
        : [],
    resolvedBy: r.resolved_by ? String(r.resolved_by) : undefined,
    resolved: Boolean(r.resolved),
    failureKind: r.failure_kind ? String(r.failure_kind) : undefined,
    at: Number(r.created_at ?? 0),
  };
}

function safeParseArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** One row per ticket, written once at the end. Idempotent per ticket. */
export async function rememberIncident(record: Omit<IncidentRecord, "id">): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (!ifg) return;
  try {
    await ifg.database.from("incident_memory").insert([
      {
        id: `${record.workspaceId}:${record.ticketId}`,
        workspace_id: record.workspaceId,
        ticket_id: record.ticketId,
        category: record.category,
        symptom: record.symptom.slice(0, 300),
        tier: record.tier,
        capabilities_used: record.capabilitiesUsed,
        resolved_by: record.resolvedBy ?? null,
        resolved: record.resolved,
        failure_kind: record.failureKind ?? null,
        created_at: record.at,
      },
    ]);
    cacheInvalidate(`incidents:${record.workspaceId}:`);
  } catch (err) {
    console.warn("[InsForge] rememberIncident failed:", (err as Error).message);
  }
}
