import { db } from "./db";
import { getInsforge, isInsforgeEnabled } from "./insforge-client";
import {
  ADAccount,
  ADAccountStatus,
  ADGroup,
  ADUser,
  Citation,
  DeflectionStat,
  PlanStep,
  Runbook,
  Ticket,
  TicketStatus,
  Workspace,
} from "./types";

type DbRow = Record<string, unknown>;

function workspaceToRow(w: Workspace): DbRow {
  return {
    id: w.id,
    display_name: w.displayName,
    is_demo: w.isDemo,
    slack_team_id: w.slackTeamId ?? null,
    slack_team_name: w.slackTeamName ?? null,
    slack_access_token: w.slackAccessToken ?? null,
    slack_connected_at: w.slackConnectedAt ?? null,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
    last_used_at: w.lastUsedAt ?? w.updatedAt,
  };
}

function workspaceFromRow(r: DbRow): Workspace {
  return {
    id: r.id as string,
    displayName: r.display_name as string,
    isDemo: Boolean(r.is_demo),
    slackTeamId: (r.slack_team_id as string | null) ?? undefined,
    slackTeamName: (r.slack_team_name as string | null) ?? undefined,
    slackAccessToken: (r.slack_access_token as string | null) ?? undefined,
    slackConnectedAt: r.slack_connected_at == null ? undefined : Number(r.slack_connected_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastUsedAt: r.last_used_at == null ? undefined : Number(r.last_used_at),
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
    runbook_source_id: t.runbookSourceId ?? null,
    resolution_time_ms: t.resolutionTimeMs ?? null,
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
    runbookSourceId: (r.runbook_source_id as string | null) ?? undefined,
    resolutionTimeMs: r.resolution_time_ms == null ? undefined : Number(r.resolution_time_ms),
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
  if (patch.runbookSourceId !== undefined) out.runbook_source_id = patch.runbookSourceId;
  out.updated_at = Date.now();
  return out;
}

function runbookToRow(r: Runbook): DbRow {
  return {
    id: r.id,
    workspace_id: r.workspaceId,
    title: r.title,
    tags: r.tags,
    body: r.body,
    source_ticket_ids: r.sourceTicketIds,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    success_count: r.successCount,
    failure_count: r.failureCount,
  };
}

function runbookFromRow(r: DbRow): Runbook {
  return {
    id: r.id as string,
    workspaceId: (r.workspace_id as string) ?? "acme.test",
    title: r.title as string,
    tags: (r.tags as string[] | null) ?? [],
    body: r.body as string,
    sourceTicketIds: (r.source_ticket_ids as string[] | null) ?? [],
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    successCount: Number(r.success_count ?? 0),
    failureCount: Number(r.failure_count ?? 0),
  };
}

function runbookPatchToRow(patch: Partial<Runbook>): DbRow {
  const out: DbRow = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.tags !== undefined) out.tags = patch.tags;
  if (patch.body !== undefined) out.body = patch.body;
  if (patch.sourceTicketIds !== undefined) out.source_ticket_ids = patch.sourceTicketIds;
  if (patch.successCount !== undefined) out.success_count = patch.successCount;
  if (patch.failureCount !== undefined) out.failure_count = patch.failureCount;
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

function ifErr(error: unknown, op: string): void {
  if (error) {
    const msg = (error as { message?: string }).message ?? String(error);
    throw new Error(`[InsForge] ${op}: ${msg}`);
  }
}

// Workspace CRUD

export async function insertWorkspace(w: Workspace): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("workspaces").insert([workspaceToRow(w)]);
    ifErr(error, "insertWorkspace");
    return;
  }
  db.insertWorkspace(w);
}

export async function getWorkspace(id: string): Promise<Workspace | undefined> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { data, error } = await ifg.database
      .from("workspaces")
      .select()
      .eq("id", id)
      .maybeSingle();
    ifErr(error, "getWorkspace");
    return data ? workspaceFromRow(data as DbRow) : undefined;
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

export async function disconnectSlackOnWorkspace(id: string): Promise<void> {
  const row: DbRow = {
    slack_team_id: null,
    slack_team_name: null,
    slack_access_token: null,
    slack_connected_at: null,
    updated_at: Date.now(),
  };
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("workspaces").update(row).eq("id", id);
    ifErr(error, "disconnectSlackOnWorkspace");
    return;
  }
  db.updateWorkspace(id, {
    slackTeamId: undefined,
    slackTeamName: undefined,
    slackAccessToken: undefined,
    slackConnectedAt: undefined,
  });
}

export async function updateWorkspace(id: string, patch: Partial<Workspace>): Promise<void> {
  const row: DbRow = {};
  if (patch.displayName !== undefined) row.display_name = patch.displayName;
  if (patch.isDemo !== undefined) row.is_demo = patch.isDemo;
  if (patch.slackTeamId !== undefined) row.slack_team_id = patch.slackTeamId;
  if (patch.slackTeamName !== undefined) row.slack_team_name = patch.slackTeamName;
  if (patch.slackAccessToken !== undefined) row.slack_access_token = patch.slackAccessToken;
  if (patch.slackConnectedAt !== undefined) row.slack_connected_at = patch.slackConnectedAt;
  row.updated_at = Date.now();
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("workspaces").update(row).eq("id", id);
    ifErr(error, "updateWorkspace");
    return;
  }
  db.updateWorkspace(id, patch);
}

export async function touchWorkspace(id: string): Promise<void> {
  const now = Date.now();
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database
      .from("workspaces")
      .update({ last_used_at: now })
      .eq("id", id);
    ifErr(error, "touchWorkspace");
    return;
  }
  db.updateWorkspace(id, { lastUsedAt: now });
}

/**
 * Delete every demo workspace whose last_used_at is older than `olderThanMs`,
 * along with its tickets/runbooks/AD records. Returns deleted workspace ids.
 */
export async function deleteExpiredDemoWorkspaces(olderThanMs: number): Promise<string[]> {
  const cutoff = Date.now() - olderThanMs;
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { data, error } = await ifg.database
      .from("workspaces")
      .select("id")
      .eq("is_demo", true)
      .lt("last_used_at", cutoff);
    ifErr(error, "deleteExpiredDemoWorkspaces:list");
    const ids = ((data as { id: string }[] | null) ?? []).map((r) => r.id);
    for (const wsId of ids) {
      for (const table of ["tickets", "runbooks", "ad_users", "ad_groups", "ad_accounts"] as const) {
        const { error: delErr } = await ifg.database.from(table).delete().eq("workspace_id", wsId);
        ifErr(delErr, `deleteExpiredDemoWorkspaces:${table}`);
      }
      const { error: wsErr } = await ifg.database.from("workspaces").delete().eq("id", wsId);
      ifErr(wsErr, "deleteExpiredDemoWorkspaces:workspace");
    }
    return ids;
  }
  const expired = db.listWorkspaces().filter(
    (w) => w.isDemo && (w.lastUsedAt ?? w.updatedAt) < cutoff,
  );
  for (const w of expired) {
    for (const t of db.listTickets(w.id)) db.tickets.delete(t.id);
    for (const r of db.listRunbooks(w.id)) db.runbooks.delete(r.id);
    for (const u of db.listADUsers(w.id)) db.adUsers.delete(`${w.id}:${u.email}`);
    for (const g of db.listADGroups(w.id)) db.adGroups.delete(`${w.id}:${g.id}`);
    for (const a of db.listADAccounts(w.id)) db.adAccounts.delete(`${w.id}:${a.email}`);
    db.workspaces.delete(w.id);
  }
  return expired.map((w) => w.id);
}

// Tickets

export async function insertTicket(t: Ticket): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("tickets").insert([ticketToRow(t)]);
    ifErr(error, "insertTicket");
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
    return;
  }
  db.updateStep(ticketId, stepId, patch);
}

export async function listTickets(workspaceId?: string): Promise<Ticket[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    let q = ifg.database.from("tickets").select();
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q.order("created_at", { ascending: false });
    ifErr(error, "listTickets");
    return ((data as DbRow[]) ?? []).map(ticketFromRow);
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

// Runbooks

export async function insertRunbook(r: Runbook): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("runbooks").insert([runbookToRow(r)]);
    ifErr(error, "insertRunbook");
    return;
  }
  db.insertRunbook(r);
}

export async function updateRunbook(id: string, patch: Partial<Runbook>): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const row = runbookPatchToRow(patch);
    if (Object.keys(row).length === 0) return;
    const { error } = await ifg.database.from("runbooks").update(row).eq("id", id);
    ifErr(error, "updateRunbook");
    return;
  }
  db.updateRunbook(id, patch);
}

export async function listRunbooks(workspaceId?: string): Promise<Runbook[]> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    let q = ifg.database.from("runbooks").select();
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q.order("updated_at", { ascending: false });
    ifErr(error, "listRunbooks");
    return ((data as DbRow[]) ?? []).map(runbookFromRow);
  }
  return db.listRunbooks(workspaceId);
}

// AD users / groups / accounts

export async function insertADUser(u: ADUser): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    const { error } = await ifg.database.from("ad_users").insert([adUserToRow(u)]);
    ifErr(error, "insertADUser");
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
    let q = ifg.database.from("ad_users").select();
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q;
    ifErr(error, "listADUsers");
    return ((data as DbRow[]) ?? []).map(adUserFromRow);
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
    let q = ifg.database.from("ad_accounts").select();
    if (workspaceId) q = q.eq("workspace_id", workspaceId);
    const { data, error } = await q;
    ifErr(error, "listADAccounts");
    return ((data as DbRow[]) ?? []).map(adAccountFromRow);
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
    return;
  }
  db.updateADAccount(email, patch, workspaceId);
}

// Bulk re-tag — used by claimDemoWorkspace to migrate demo rows to a real workspace.
export async function reassignWorkspace(
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<void> {
  const ifg = isInsforgeEnabled() ? getInsforge() : null;
  if (ifg) {
    for (const table of ["tickets", "runbooks", "ad_users", "ad_groups", "ad_accounts"] as const) {
      const { error } = await ifg.database
        .from(table)
        .update({ workspace_id: toWorkspaceId })
        .eq("workspace_id", fromWorkspaceId);
      ifErr(error, `reassignWorkspace(${table})`);
    }
    return;
  }
  for (const t of db.listTickets(fromWorkspaceId)) t.workspaceId = toWorkspaceId;
  for (const r of db.listRunbooks(fromWorkspaceId)) r.workspaceId = toWorkspaceId;
  for (const u of db.listADUsers(fromWorkspaceId)) u.workspaceId = toWorkspaceId;
  for (const g of db.listADGroups(fromWorkspaceId)) g.workspaceId = toWorkspaceId;
  for (const a of db.listADAccounts(fromWorkspaceId)) a.workspaceId = toWorkspaceId;
}

export async function deflectionStats(workspaceId?: string): Promise<DeflectionStat> {
  const all = await listTickets(workspaceId);
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

export const isConvexEnabled = (): boolean => false;
