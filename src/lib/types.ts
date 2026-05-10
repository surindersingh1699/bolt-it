export type TicketStatus =
  | "new"
  | "drafting"
  | "awaiting_approval"
  | "executing"
  | "awaiting_confirmation"
  | "resolved"
  | "escalated";

export type ActionStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type ActionKind = "insforge" | "aside" | "tensorlake" | "slack_reply";

export type StepRisk = "low" | "medium" | "high";
export type StepApprovalMode = "auto" | "human";
export type RiskSource = "allowlist" | "judge" | "fallback";

export interface Citation {
  source: "nia" | "hyperspell";
  title: string;
  snippet: string;
  ref: string;
}

export interface PlanStep {
  id: string;
  kind: ActionKind;
  description: string;
  capability?: string;
  params?: Record<string, unknown>;
  status: ActionStatus;
  log?: string[];
  startedAt?: number;
  finishedAt?: number;
  risk?: StepRisk;
  approvalMode?: StepApprovalMode;
  riskReason?: string;
  riskSource?: RiskSource;
}

export type NiaSourceType = "repository" | "documentation";
export type NiaSourceStatus = "indexing" | "ready" | "failed";

export interface NiaSource {
  id: string;
  identifier: string;
  displayName: string;
  type: NiaSourceType;
  status: NiaSourceStatus;
  url: string;
  addedAt: number;
  updatedAt: number;
  errorMessage?: string;
}

export interface Workspace {
  id: string;
  displayName: string;
  isDemo: boolean;
  slackTeamId?: string;
  slackTeamName?: string;
  slackAccessToken?: string;
  slackConnectedAt?: number;
  niaSources?: NiaSource[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export type AgentJobStatus = "queued" | "claimed" | "succeeded" | "failed";

export interface AgentJob {
  id: string;
  workspaceId: string;
  ticketId: string;
  stepId?: string;
  kind: "collect_logs" | "network_probe" | "app_diagnostic" | "system_info";
  targetUserEmail: string;
  instructions: string;
  allowlistedCommand: string;
  status: AgentJobStatus;
  createdAt: number;
  updatedAt: number;
  claimedAt?: number;
  completedAt?: number;
  output?: string;
  error?: string;
}

export interface Ticket {
  id: string;
  workspaceId: string;
  customerOrg: string;
  channel: "slack" | "email" | "portal";
  reporter: string;
  reporterEmail: string;
  subject: string;
  body: string;
  status: TicketStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
  draftResponse?: string;
  plan: PlanStep[];
  citations: Citation[];
  confidence: number;
  resolvedByAi: boolean;
  runbookSourceId?: string;
  resolutionTimeMs?: number;
}

export interface Runbook {
  id: string;
  workspaceId: string;
  title: string;
  tags: string[];
  body: string;
  sourceTicketIds: string[];
  createdAt: number;
  updatedAt: number;
  successCount: number;
  failureCount: number;
}

export interface UserContext {
  email: string;
  name: string;
  team: string;
  recentApps: string[];
  calendarBusyUntil?: number;
}

export interface DeflectionStat {
  totalTickets: number;
  aiResolved: number;
  escalated: number;
  avgResolutionMs: number;
  rate: number;
}

export type ADAccountStatus = "active" | "locked" | "disabled" | "password_expired" | "stale_kerberos";

export interface ADUser {
  email: string;
  workspaceId: string;
  name: string;
  passwordHash: string;
  team: string;
  title: string;
  manager?: string;
  groups: string[];
  isITStaff: boolean;
  createdAt: number;
}

export interface ADGroup {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  members: string[];
}

export interface ADAccount {
  email: string;
  workspaceId: string;
  status: ADAccountStatus;
  failedLoginCount: number;
  lockedAt?: number;
  passwordChangedAt: number;
  passwordExpiresAt: number;
  lastLoginAt?: number;
  lastLoginHost?: string;
  kerberosTicketAt?: number;
}

export interface Session {
  userEmail: string;
  workspaceId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface PublicUser {
  email: string;
  workspaceId: string;
  name: string;
  team: string;
  title: string;
  isITStaff: boolean;
}
