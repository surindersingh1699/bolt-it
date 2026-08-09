export type TicketStatus =
  | "new"
  | "drafting"
  | "awaiting_approval"
  | "executing"
  | "awaiting_confirmation"
  | "resolved"
  | "escalated";

/**
 * `simulated` is deliberately NOT a flavour of `succeeded`.
 *
 * On the simulation and shadow rungs a write is computed and never sent, so the
 * step "completed" in the sense that nothing went wrong and in no sense at all
 * regarding the employee's machine. Marking it succeeded would let
 * `resolutionSupported` — which counts succeeded steps — close a ticket on work
 * that never happened, which is the exact failure `no_effect` exists to prevent.
 */
export type ActionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "simulated";

// device = runs on the user's machine via the local agent.
// backend = directory/account action in our own store.
// reply = message to the user.
//
// There is no "knowledge" kind. External lookup is not an action taken on the
// company's behalf and never was — it touches no system, changes nothing, and
// needs no approval. It is a graph node now (research.ts), not a plan step.
export type ActionKind = "device" | "backend" | "reply";

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
  /**
   * Set only when the machine refused a read it WOULD run for this ticket if a
   * decision said so — the agent's `GRANTABLE:<binary>:` marker.
   *
   * It is the only thing that makes a step grantable. Inferring it from
   * `params.binary` instead would make every `capability_missing` on a command
   * step look grantable, including "this build has no such handler" — which a
   * grant cannot fix, so the retry would fail identically, forever.
   */
  grantableBinary?: string;
}

/**
 * A file the reporter attached — in practice, a screenshot of the thing that is
 * wrong. `key` is what Storage needs to fetch or delete it and cannot be derived
 * from `url`, so both are kept.
 */
export interface Attachment {
  key: string;
  url: string;
  mimeType: string;
  bytes: number;
  uploadedAt: number;
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
  /**
   * The strategist's belief, 0-1, that this fix is the answer to THIS ticket.
   *
   * The only ordering input a model contributes. Everything else about where a
   * fix sits in the ladder — how reversible it is, who it affects, whether it
   * can be verified at all — is derived from the capability registry in
   * ladder.ts, precisely so a ticket body cannot argue with it. Absent on the
   * operator's steps, which bind parameters rather than authorise.
   */
  likelihood?: number;
  /** Set on every step that reaches `status: "failed"`. */
  failure?: StepFailure;
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
  /** Computed on a dry-run rung and never sent to the machine. */
  | "simulated"
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
  /**
   * True when this was computed on a dry-run rung and never sent to the machine.
   *
   * Load-bearing rather than cosmetic: without it `deriveJobStatus` reaches its
   * `expectsChange && !changed` rule, which is true of EVERY simulated write, so
   * a whole simulation run would read as universal `no_effect` failure.
   */
  simulated?: boolean;
  /**
   * Steps whose before-probe could not be satisfied because an earlier write in
   * the same plan was simulated rather than performed. A known artifact of the
   * rung, not a defect in the plan — recorded as a warning so a healthy plan is
   * not routed to a human handoff by the act of dry-running it.
   */
  simulatedDependencyUnmet?: string[];
  probes: DeviceProbe[];
  commands: DeviceCommand[];
  effect: { changed: boolean; diff: EffectDiff[]; summary: string };
  /** Where the append-only copy lives on the device itself. */
  journalPath?: string;
  /** Where the human-readable change record (with the undo command) lives. */
  changeRecordPath?: string;
  /** The exact command a technician runs to reverse this change. */
  revertCommand?: string;
  /**
   * The change did not take and the agent put the machine back.
   *
   * Before this existed a write that failed verification reported `no_effect`
   * and left the machine wherever it landed — possibly half-applied, with
   * nobody told which half.
   */
  rolledBack?: boolean;
  rollbackOk?: boolean;
  /**
   * Set when the rollback itself failed. This is the one case a person must
   * see: the machine is now in a state neither the plan nor the undo accounted
   * for.
   */
  rollbackError?: string;
}

export interface AgentJob {
  id: string;
  workspaceId: string;
  ticketId: string;
  stepId?: string;
  kind: "collect_logs" | "network_probe" | "app_diagnostic" | "system_info";
  targetUserEmail: string;
  /**
   * Which machine this job is FOR. Enforced at claim time.
   *
   * Before this existed, `targetUserEmail` was the only statement of intent and
   * nothing checked it: the agent polled with no workspace filter and received
   * every queued job in every workspace, so any holder of the shared token
   * executed other employees' jobs on the wrong machine.
   */
  deviceId?: string;
  /** Denormalized for the audit log, so a job record names the host by itself. */
  deviceHostname?: string;
  /**
   * Read-only binaries a named technician approved for this ticket.
   *
   * Carried on the job rather than encoded in `allowlistedCommand`, so the thing
   * a model composed and the thing a person decided travel on separate rails and
   * no phrasing of the first can forge the second. The agent still refuses
   * anything outside its own curated grantable list.
   */
  grantedBinaries?: string[];
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
  /** Screenshots the reporter attached. Read by the strategist on its first look. */
  attachments?: Attachment[];
  confidence: number;
  resolvedByAi: boolean;
  resolutionTimeMs?: number;
  /** What the agent tried and concluded across troubleshooting attempts. */
  troubleshootingSummary?: string;
  attempts?: number;
  /**
   * Read-only binaries a technician switched on for THIS ticket, by name.
   *
   * Scoped to the ticket on purpose: a grant is a judgement about one problem
   * on one machine at one moment, and a grant that outlived its ticket would
   * quietly become a permanent widening of the read surface that nobody ever
   * decided to make.
   */
  grantedBinaries?: string[];
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
  /**
   * SHA-256 of this device's own agent token. The token itself is shown once at
   * enrollment and never stored — a leak of this table must not be a leak of
   * every agent's credential.
   */
  tokenHash?: string;
  enrolledAt?: number;
  /** Set to stop a machine being able to claim anything, without deleting it. */
  revokedAt?: number;
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
