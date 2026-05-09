export type TicketStatus =
  | "new"
  | "drafting"
  | "awaiting_approval"
  | "executing"
  | "resolved"
  | "escalated";

export type ActionStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type ActionKind = "insforge" | "aside" | "tensorlake" | "slack_reply";

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
}

export interface Ticket {
  id: string;
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
