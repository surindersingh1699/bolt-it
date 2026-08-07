/**
 * Every action this system can take, as data.
 *
 * A capability used to be a string that appeared in six places — the id list,
 * the help map, the read-only set, `humanLabelFor`, a branch in
 * `commandForCapability`, and a handler in the agent. Six places is five chances
 * to disagree, and the one that mattered was the read-only set: it was
 * maintained by hand next to the id list, and getting it wrong in the permissive
 * direction lets the cheap model author a mutation (CLAUDE.md rule 3).
 *
 * Here there is one record. `risk === 0` IS read-only — derived, not restated.
 *
 * Every field exists because the executor needs it:
 *
 *   risk / reversible / blastRadius / requiresElevation → policy.ts decides
 *   params (zod)                                        → a param that does not
 *       parse fails the step, instead of being coerced into a DIFFERENT action
 *       (the old sanitizeDnsServers turned garbage into "empty", which is a real
 *       instruction, not a no-op)
 *   command                                             → the audit string IS
 *       the argv, so what the ticket shows is what ran
 *   probe / rollback                                    → the device transaction
 *       (probe → act → probe → rollback if unverified)
 *   kind                                                → authoritative. The
 *       model proposes a kind; we ignore it and use this one.
 *   provenance                                          → who put this here and
 *       on whose authority
 *
 * `registry.test.ts` enforces that every record is complete. That test is the
 * mechanism behind "no capability bypasses the substrate" — a spec that skips a
 * guarantee does not fail at runtime on someone's laptop, it fails the suite.
 */

import { z } from "zod";
import type { ActionKind } from "../types";

/**
 * How much a capability can cost you if it is wrong.
 *
 * The old model was binary — read-only, or not. That could not express the
 * difference between flushing a DNS cache and resetting a password, so both
 * landed on the same side of the same gate.
 */
export type CapabilityRisk =
  /** Only looks. Free for the operator to run without authorisation. */
  | 0
  /** Temporary state: restart a service, cycle an adapter. Self-restoring. */
  | 1
  /** Configuration: DNS, proxy, cache. Survives a reboot; needs a real undo. */
  | 2
  /** Persistent OS or directory change: credentials, accounts, installs. */
  | 3
  /** Potentially destructive: disk, encryption, profile deletion. */
  | 4;

export type Reversibility =
  /** The machine returns to its prior state on its own. */
  | "self"
  /** The prior state is captured before the change and an exact undo recorded. */
  | "recorded"
  /** Cannot be undone. Allowed, but never auto-approved above risk 1. */
  | "none";

export type BlastRadius = "device" | "user-session" | "directory";

export type DevicePlatform = "darwin" | "win32";

/**
 * Where this capability came from, and who is accountable for it.
 *
 * `built-in` shipped with the system. `approved_pr` was proposed by the
 * strategist, critiqued, and merged by a named human — `approvedBy` carries the
 * PR. `temporary` is a lease: scoped, expiring, and capped at risk 1 by policy,
 * so an expiring grant can never be the thing that resets a password.
 */
export interface CapabilityProvenance {
  source: "built-in" | "approved_pr" | "temporary";
  version: string;
  author: string;
  /** Required for `approved_pr`. Must not be the author. */
  approvedBy: string | null;
  createdAt: string;
  /** Required for `temporary`, forbidden otherwise. Checked at dispatch. */
  expiresAt: string | null;
}

export interface CapabilitySpec {
  id: string;
  /**
   * Authoritative. The strategist also emits a `kind` on each step; that one is
   * a suggestion from a model reading an untrusted ticket, and is discarded in
   * favour of this.
   */
  kind: ActionKind;
  label: string;
  help: string;
  risk: CapabilityRisk;
  /** Empty for backend capabilities, which do not touch a machine. */
  os: DevicePlatform[];
  requiresElevation: boolean;
  params: z.ZodType;
  /**
   * Builds the allowlisted command string. Null for backend capabilities, which
   * are dispatched to the directory adapter rather than to a machine.
   *
   * Returns the exact argv the agent will run, so the string persisted on the
   * ticket for audit and the string that executes cannot drift apart.
   */
  command: ((params: never) => string) | null;
  /**
   * Name of the before/after probe the agent runs around this action. Null only
   * for reads. A change with no probe cannot be verified, which means it can
   * never be honestly reported as a fix.
   */
  probe: string | null;
  /** How the change is undone. Null only when `reversible` is "none". */
  rollback: string | null;
  reversible: Reversibility;
  blastRadius: BlastRadius;
  provenance: CapabilityProvenance;
}

/**
 * Definition-site helper: keeps `command` typed against its own `params` schema
 * while the registry stays a flat `CapabilitySpec[]`.
 */
function defineCapability<S extends z.ZodType>(
  def: Omit<CapabilitySpec, "params" | "command"> & {
    params: S;
    command: ((params: z.infer<S>) => string) | null;
  },
): CapabilitySpec {
  return def as unknown as CapabilitySpec;
}

const BUILT_IN = {
  source: "built-in",
  version: "1.0",
  author: "bolt-it",
  approvedBy: null,
  createdAt: "2026-08-07",
  expiresAt: null,
} as const satisfies CapabilityProvenance;

const BOTH: DevicePlatform[] = ["darwin", "win32"];

// Shared param shapes. These replace the old sanitize* helpers in agent-jobs.ts.
// The difference that matters: a sanitizer coerces, a schema refuses. Coercing
// an unparseable DNS server list into "empty" does not decline the action, it
// performs a different one.

/** An application name. Restricted to what a real name uses, because it is
 *  interpolated into a PowerShell string on the Windows side. */
const appName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9 _-]+$/, "app name may only contain letters, digits, space, underscore, hyphen");

/** A filesystem path. Unlike argv tokens these keep spaces ("Application
 *  Support"); the double quote that delimits the value is what is forbidden. */
const fsPath = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((s) => !/["\r\n\0]/.test(s), "path may not contain quotes, newlines or nulls");

const searchPattern = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/["\r\n\0]/.test(s), "pattern may not contain quotes, newlines or nulls");

/** A single argv token: no whitespace, so the audit string is unambiguously the
 *  argv, and no shell metacharacters. */
const argvToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._\-/:@=+,%[\]]+$/, "argument contains a character that is not argv-safe");

const emptyParams = z.object({}).strict();

export const CAPABILITY_SPECS: CapabilitySpec[] = [
  // ---------------------------------------------------------------- risk 0
  defineCapability({
    id: "diag.system_info",
    kind: "device",
    label: "Collect device hardware and OS info",
    help: "device hardware, OS, hostname, RAM, serial, uptime",
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ user: z.string().max(254).optional() }).strict(),
    command: (p) => `collect_system_info --user ${(p.user ?? "").replace(/[^a-zA-Z0-9@._-]/g, "")}`,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.app_status",
    kind: "device",
    label: "Check whether the app is running",
    help: 'is this app running right now — params {"app"}',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ app: appName }).strict(),
    command: (p) => `app_status --app "${p.app}"`,
    probe: "probeProcess",
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.app_logs",
    kind: "device",
    label: "Read the app's recent error events",
    help: 'this app\'s recent error events — params {"app"}',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ app: appName, limit: z.number().int().min(1).max(50).default(15) }).strict(),
    command: (p) => `app_event_logs --app "${p.app}" --limit ${p.limit}`,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.process_list",
    kind: "device",
    label: "List what's running on the machine",
    help: "everything running on the machine right now",
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: emptyParams,
    command: () => "process_list",
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.network_state",
    kind: "device",
    label: "Read interfaces, routes and DNS",
    help: "interfaces, routes, DNS resolvers, listening ports",
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: emptyParams,
    command: () => "network_state",
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.command_output",
    kind: "device",
    label: "Read device state with a read-only command",
    help: 'params {"binary", "args"} — any binary from the read-only allowlist',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z
      .object({
        binary: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_.-]+$/, "binary name is not allowlist-shaped"),
        args: z.union([z.string(), z.array(z.string())]).optional(),
      })
      .strict(),
    command: (p) => {
      const raw = Array.isArray(p.args) ? p.args : String(p.args ?? "").split(/\s+/);
      const args = raw.filter((t) => argvToken.safeParse(t).success).slice(0, 12);
      return `command_output --binary "${p.binary}" --args "${args.join(" ")}"`;
    },
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fs.list",
    kind: "device",
    label: "List a directory on the machine",
    help: 'params {"path"} — directory listing on the employee\'s machine',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ path: fsPath }).strict(),
    command: (p) => `fs_list --path "${p.path}"`,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fs.read",
    kind: "device",
    label: "Read a file on the machine",
    help: 'params {"path", "lines"?} — read a file; 256 KB cap, secrets redacted',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z
      .object({ path: fsPath, lines: z.number().int().min(1).max(5000).default(2000) })
      .strict(),
    command: (p) => `fs_read --path "${p.path}" --lines ${p.lines}`,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fs.grep",
    kind: "device",
    label: "Search file contents on the machine",
    help: 'params {"path", "pattern"} — search a file or directory; matched lines only',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ path: fsPath, pattern: searchPattern }).strict(),
    command: (p) => `fs_grep --path "${p.path}" --pattern "${p.pattern}"`,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "ad.lookup_user",
    kind: "backend",
    label: "Look up the directory record",
    help: "directory record for the employee",
    risk: 0,
    os: [],
    requiresElevation: false,
    params: emptyParams,
    command: null,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "directory",
    provenance: BUILT_IN,
  }),

  // ---------------------------------------------------------------- risk 1
  defineCapability({
    id: "fix.restart_app",
    kind: "device",
    label: "Restart the application",
    help: 'quit and relaunch the app — params {"app"}',
    risk: 1,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ app: appName }).strict(),
    command: (p) => `restart_app --app "${p.app}"`,
    probe: "probeProcess",
    rollback: "relaunch the app if it was left closed",
    reversible: "self",
    blastRadius: "user-session",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.toggle_wifi",
    kind: "device",
    label: "Cycle the network adapter",
    help: "cycles the adapter; briefly drops their connection",
    risk: 1,
    os: BOTH,
    // Windows Disable-NetAdapter requires Administrator.
    requiresElevation: true,
    params: emptyParams,
    command: () => "toggle_wifi",
    probe: "probeNetwork",
    rollback: "re-enable the adapter if it was left down",
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.flush_dns",
    kind: "device",
    label: "Flush the DNS resolver cache",
    help: "flush the OS DNS resolver cache; no params",
    risk: 1,
    os: BOTH,
    requiresElevation: true,
    params: emptyParams,
    command: () => "flush_dns",
    // A cache flush has no diffable before/after fact — the cache is supposed to
    // be empty afterwards and repopulates immediately. Declared expectsChange
    // false on the agent for the same reason.
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "ad.unlock_account",
    kind: "backend",
    label: "Clear a directory lockout",
    help: "clear a directory lockout",
    risk: 1,
    os: [],
    requiresElevation: false,
    params: emptyParams,
    command: null,
    probe: "directory account status",
    rollback: null,
    reversible: "none",
    blastRadius: "directory",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "ad.refresh_kerberos",
    kind: "backend",
    label: "Renew the domain ticket",
    help: "renew the domain ticket",
    risk: 1,
    os: [],
    requiresElevation: false,
    params: emptyParams,
    command: null,
    probe: "directory ticket timestamp",
    rollback: null,
    reversible: "self",
    blastRadius: "directory",
    provenance: BUILT_IN,
  }),

  // ---------------------------------------------------------------- risk 2
  defineCapability({
    id: "fix.clear_app_cache",
    kind: "device",
    label: "Clear application cache",
    help: 'params {"app"} — destroys the employee\'s local app state',
    risk: 2,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ app: appName }).strict(),
    command: (p) => `clear_app_cache --app "${p.app}"`,
    probe: "probeCacheDir",
    // Deleted local state is gone. This is why it is risk 2 and not risk 1,
    // despite looking like a smaller action than cycling an adapter.
    rollback: null,
    reversible: "none",
    blastRadius: "user-session",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.set_dns_servers",
    kind: "device",
    label: "Set the DNS resolvers",
    help:
      'params {"service"?, "servers"} — set the DNS resolvers on a network service; ' +
      'servers="empty" restores DHCP-assigned resolvers. Reversible: the prior list is recorded before the change',
    risk: 2,
    os: BOTH,
    requiresElevation: true,
    params: z
      .object({
        service: z
          .string()
          .trim()
          .max(48)
          .regex(/^[a-zA-Z0-9 _/-]*$/, "network service name contains unsupported characters")
          .default("auto"),
        servers: z.union([
          z.literal("empty"),
          z
            .array(z.string().regex(/^[0-9a-fA-F.:]{3,45}$/, "not an IP address"))
            .min(1)
            .max(4),
        ]),
      })
      .strict(),
    command: (p) => {
      const servers = p.servers === "empty" ? "empty" : p.servers.join(",");
      return `set_dns_servers --service "${p.service || "auto"}" --servers "${servers}"`;
    },
    probe: "probeDns",
    rollback: "re-apply the resolver list captured by the before-probe",
    reversible: "recorded",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),

  // ---------------------------------------------------------------- risk 3
  defineCapability({
    id: "ad.reset_password",
    kind: "backend",
    label: "Reset the directory password",
    help: "invalidates the employee's credential; always human-approved",
    risk: 3,
    os: [],
    requiresElevation: true,
    params: emptyParams,
    command: null,
    probe: "directory credential timestamp",
    rollback: null,
    reversible: "none",
    blastRadius: "directory",
    provenance: BUILT_IN,
  }),
];

const SPEC_BY_ID: ReadonlyMap<string, CapabilitySpec> = new Map(
  CAPABILITY_SPECS.map((s) => [s.id, s]),
);

export function capabilitySpec(id: string | undefined): CapabilitySpec | undefined {
  return typeof id === "string" ? SPEC_BY_ID.get(id) : undefined;
}

/** The closed set. Everything either model proposes is checked against this. */
export const CAPABILITIES: readonly string[] = CAPABILITY_SPECS.map((s) => s.id);

export function capabilityAllowed(capability: string | undefined): boolean {
  return capabilitySpec(capability) !== undefined;
}

/**
 * Read-only is derived, never restated.
 *
 * `ad.lookup_user` is a directory READ despite the `ad.` prefix, which is why
 * this was never safe as a prefix test — and why it is now a risk number on the
 * record rather than a second list somebody has to remember to update.
 */
export function isReadOnlyCapability(capability: string | undefined): boolean {
  return capabilitySpec(capability)?.risk === 0;
}

export type BuiltCommand =
  | { ok: true; command: string }
  | { ok: false; reason: string };

/**
 * Turn a capability plus model-supplied params into the exact command string.
 *
 * Returns a reason instead of a string when the params do not parse. The old
 * `commandForCapability` had no failure mode: it coerced, and its final line
 * was `return "toggle_wifi"`, so an unmapped capability cycled the network
 * adapter. A capability that cannot be built is `capability_missing`, and a
 * param that cannot be parsed is a refused step.
 */
export function buildCommand(
  capability: string | undefined,
  params: Record<string, unknown> | undefined,
): BuiltCommand {
  const spec = capabilitySpec(capability);
  if (!spec) return { ok: false, reason: `unknown capability "${capability ?? "(none)"}"` };
  if (!spec.command) {
    return { ok: false, reason: `${spec.id} is a ${spec.kind} capability and has no device command` };
  }
  const parsed = spec.params.safeParse(params ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "params";
    return { ok: false, reason: `${spec.id}: ${where} — ${first?.message ?? "invalid"}` };
  }
  return { ok: true, command: (spec.command as (p: unknown) => string)(parsed.data) };
}
