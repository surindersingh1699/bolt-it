export type TicketStatus =
  | "new"
  | "drafting"
  | "awaiting_approval"
  | "executing"
  | "awaiting_confirmation"
  | "resolved"
  | "escalated";

export type ActionStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

// device = runs on the user's machine via the local agent.
// backend = directory/account action in our own store.
// reply = message to the user.
export type ActionKind = "device" | "backend" | "knowledge" | "reply";

export type StepRisk = "low" | "medium" | "high";
export type StepApprovalMode = "auto" | "human";
export type RiskSource = "allowlist" | "judge" | "fallback";

/**
 * Why a step failed. `failed` alone tells an operator nothing actionable: a
 * refused step, an offline agent and a fix that landed on an unchanged machine
 * are three different problems with three different owners. Every path that
 * sets `status: "failed"` must also set one of these.
 */
export type StepFailureKind =
  /** The command did not complete — adapter returned not-ok, or threw. */
  | "execution"
  /** The device agent never reported back inside the job window. */
  | "timeout"
  /** Ran cleanly; the machine's before/after probes are identical. */
  | "no_effect"
  /** The safety reviewer refused the step outright. */
  | "policy_block"
  /** The step asserted a diagnosis nothing in the evidence supports. */
  | "unsupported_assumption"
  /** The fix needs a capability no tier holds. */
  | "capability_missing"
  /** A provider we depend on (gateway, reviewer, directory) was unavailable. */
  | "dependency_unavailable"
  /** Evidence gathered points two ways at once and cannot select a fix. */
  | "conflicting_evidence";

export interface StepFailure {
  kind: StepFailureKind;
  /** One concrete sentence naming what was observed, for the handoff artifact. */
  detail: string;
}

export interface Citation {
  source: "memory";
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
  governancePromoted?: boolean;
  /** Set on every step that reaches `status: "failed"`. */
  failure?: StepFailure;
}

export interface CapabilityPrecedent {
  workspaceId: string;
  capability: string;
  cleanExecutions: number;
  lastApprovedAt: number;
  lastApprovedBy?: string;
  promotedAt?: number;
}

export interface Workspace {
  id: string;
  displayName: string;
  createdAt: number;
  updatedAt: number;
}

export type AgentJobStatus =
  | "queued"
  | "claimed"
  | "succeeded"
  /** Ran cleanly, but the device's own state never moved — not a fix. */
  | "no_effect"
  | "failed";

/** One `Get-*`/`pgrep` style read of device state, taken around an action. */
export interface DeviceProbe {
  /** e.g. "process:Outlook (before)" */
  label: string;
  /** Exact command used to read the state, for audit. */
  command: string;
  exitCode: number;
  /** Stable, comparable facts — the things a diff is computed over. */
  facts: Record<string, string | number | boolean | null>;
}

/** One command the device agent actually executed, with its real result. */
export interface DeviceCommand {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface EffectDiff {
  field: string;
  before: string | number | boolean | null;
  after: string | number | boolean | null;
}

/**
 * The proof-of-effect record for a single device job: what the machine looked
 * like before, what was run, what it looked like after, and whether anything
 * actually changed. `effect.changed === false` on a job that was supposed to
 * change something is the signal that the agent left no fingerprint.
 */
export interface ExecutionEnvelope {
  jobId: string;
  command: string;
  host: string;
  os: string;
  agentVersion: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  /** Whether this command is a fix (must change state) or a read-only probe. */
  expectsChange: boolean;
  probes: DeviceProbe[];
  commands: DeviceCommand[];
  effect: { changed: boolean; diff: EffectDiff[]; summary: string };
  /** Where the append-only copy lives on the device itself. */
  journalPath?: string;
}

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
  envelope?: ExecutionEnvelope;
  /** Denormalized from the envelope so lists can filter without parsing it. */
  effectChanged?: boolean;
  effectSummary?: string;
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
  resolutionTimeMs?: number;
  /** What the agent tried and concluded across troubleshooting attempts. */
  troubleshootingSummary?: string;
  attempts?: number;
  /** Escalation depth reached: 1 service desk, 2 systems engineer, 3 escalation engineer. */
  tier?: import("./tiers").Tier;
  /** Populated by /api/state from the in-memory trace store (not persisted). */
  trace?: import("./trace").TraceEvent[];
  /** Populated by /api/state from the in-memory chat transcript (not persisted). */
  chat?: import("./chat").ChatMsg[];
  /** Populated by /api/state from the in-memory cost ledger (not persisted). */
  usage?: import("./usage").UsageTotals;
}

export interface UserContext {
  email: string;
  name: string;
  team: string;
  recentApps: string[];
  calendarBusyUntil?: number;
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

export type DeviceSource = "seed" | "heartbeat" | "manual";

export interface Device {
  id: string;
  workspaceId: string;
  hostname: string;
  os: string;
  ownerEmail?: string;
  source: DeviceSource;
  firstSeenAt: number;
  lastSeenAt: number;
  agentVersion?: string;
  claimedAt?: number;
  claimedBy?: string;
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
