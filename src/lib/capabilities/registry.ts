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

/**
 * A single argv token.
 *
 * Backslashes and spaces are IN, and that is a fix rather than a loosening. The
 * old charset had neither, so `reg query "HKCU\...\Internet Settings" /v
 * ProxyServer` — the standard way to read a Windows proxy — lost its key to a
 * silent filter and reached the machine as `reg query /v ProxyServer`. The
 * device answered `ERROR: Invalid syntax`, the operator "corrected" the syntax
 * that was never wrong, and T-4935 burned three rounds on it. No spelling of
 * that command could have worked.
 *
 * Nothing is unsafe about either character here: the agent spawns argv directly
 * and never through a shell, so there is nothing for a metacharacter to act on,
 * and the quote/newline/null exclusions below are what keep the audit string
 * unambiguous. The binary allowlist, its subcommand filter and DENIED_ARG are
 * the actual boundary, and none of them moved.
 */
/**
 * `*` is IN, and the reason is the same one that added backslash and space.
 *
 * `Get-PnpDevice -FriendlyName *Camera*` is the standard way to ask Windows
 * about a device, and the wildcard was the only character stopping it. T-7621
 * failed on it four times and asked a technician to approve the identical
 * command each time. A glob cannot act on anything: the agent spawns argv
 * directly with no shell, so there is nothing to expand it but the binary that
 * was asked for.
 *
 * Quotes, `;`, `|`, `&`, `$`, `(` and `)` stay OUT. Those are the characters
 * that could turn one command into two if a binary ever re-parses its own
 * command line — which `powershell` does — and no read needs them.
 */
const ARGV_SAFE = /^[A-Za-z0-9._\-/:@=+,%*[\]\\ ]+$/;

const argvToken = z
  .string()
  .min(1)
  .max(256)
  .superRefine((s, ctx) => {
    if (ARGV_SAFE.test(s)) return;
    // Name the character. "contains a character that is not argv-safe" sent the
    // operator to re-spell a command that was spelled correctly; it cannot fix
    // what it cannot see.
    const bad = [...s].find((c) => !ARGV_SAFE.test(c));
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        `${JSON.stringify(bad ?? "")} is not allowed in an argument. ` +
        `Letters, digits and . _ - / : @ = + , % * [ ] \\ and space are. ` +
        `Drop the quotes — arguments are passed directly, never through a shell.`,
    });
  });

/**
 * A URL this machine may be asked to fetch.
 *
 * Bounded rather than open, because a step's params are composed by a model that
 * has just read an untrusted ticket body, and an arbitrary outbound GET from
 * inside the employee's machine is a channel out of it. The query string is the
 * obvious carrier, so there is none; userinfo is refused because it carries
 * credentials; the path is capped short. What is left is enough to ask "can you
 * reach the company portal" and too small to carry a file out.
 *
 * The other half of the containment is in the agent: the probe returns the
 * status and the resolved address and never a byte of the response body.
 */
const httpUrl = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => /^https?:\/\//i.test(s), "must be an http:// or https:// URL")
  .refine((s) => !/[?#]/.test(s), "a reachability check may not carry a query string or fragment")
  .refine((s) => !s.includes("@"), "credentials in a URL are not allowed")
  .refine((s) => !/["'\\\r\n\0<>|^`{}]/.test(s), "URL contains a character that is not safe to record")
  .refine((s) => {
    try {
      return new URL(s).pathname.length <= 128;
    } catch {
      return false;
    }
  }, "path is too long for a reachability check");

/** A winget package id — `Publisher.Product`, sometimes with a version suffix. */
const packageId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._+-]+$/, "package id may only contain letters, digits, dot, underscore, plus, hyphen");

/** A device's friendly name, as Device Manager shows it. */
const deviceName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9 ._()-]+$/, "device name contains unsupported characters");

/** The value name under the Run key — what Task Manager's Startup tab lists. */
const startupItem = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9 ._()-]+$/, "startup item name contains unsupported characters");

/** Optional: empty means "whichever tunnel this machine has". */
const vpnName = z
  .string()
  .trim()
  .max(64)
  .regex(/^[A-Za-z0-9 ._-]*$/, "VPN connection name contains unsupported characters")
  .default("");

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
    help:
      'params {"binary", "args"} — any binary from the read-only allowlist. Pass "args" as an ARRAY ' +
      'when any argument contains a space: ["query", "HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Internet Settings", "/v", "ProxyServer"]',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z
      .object({
        binary: z.string().min(1).max(32).regex(/^[a-zA-Z0-9_.-]+$/, "binary name is not allowlist-shaped"),
        // A token that is not argv-safe now FAILS the step instead of being
        // dropped from it. Silently shipping a command with an argument missing
        // is the worst of the three options: the machine's error is about the
        // mangled command, so it sends the operator to correct something that
        // was correct when it was written.
        args: z
          .union([
            z.string().transform((s) => (s.trim() ? s.trim().split(/\s+/) : [])),
            z.array(z.string()),
          ])
          .pipe(z.array(argvToken).max(12))
          .optional(),
      })
      .strict(),
    // JSON, so an argument containing a space survives the trip. The previous
    // wire format joined argv on spaces and the agent split it on spaces again,
    // which meant no argument could ever contain one — the second half of why
    // the registry read above was unfixable from the model's side.
    command: (p) => `command_output --binary "${p.binary}" --argv ${JSON.stringify(p.args ?? [])}`,
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
    id: "fs.find",
    kind: "device",
    label: "Find files by name on the machine",
    help:
      'params {"path", "glob"} — find files by NAME (not contents) under a directory. ' +
      "Bounded: depth 4, 100 results. Scope it to where the problem is; a search rooted at the " +
      "home directory needs a person and a search for credential material is refused outright",
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z
      .object({
        path: fsPath,
        glob: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .refine((s) => !/["\r\n\0]/.test(s), "glob may not contain quotes, newlines or nulls"),
      })
      .strict(),
    command: (p) => `fs_find --path "${p.path}" --pattern "${p.glob}"`,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.http_check",
    kind: "device",
    label: "Check whether the machine can reach a website",
    help:
      'params {"url"} — does THIS machine resolve and reach a URL. Reports the address the name ' +
      "resolved to, the HTTP status and the connection error as separate facts, so a resolver " +
      "problem and an unreachable server are told apart. Never returns page contents. No query strings",
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ url: httpUrl }).strict(),
    command: (p) => `http_check --url "${p.url}"`,
    probe: "probeHttp",
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.vpn_state",
    kind: "device",
    label: "Read the VPN tunnel state",
    help:
      'params {"name"?} — is the tunnel up, what address it holds, and which resolvers name ' +
      "lookups on it are using. Reports those as separate facts so a dead tunnel and a live tunnel " +
      'with the wrong DNS are told apart; "connected" on its own cannot',
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ name: vpnName }).strict(),
    command: (p) => `vpn_state --name "${p.name}"`,
    probe: "probeVpn",
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.device_status",
    kind: "device",
    label: "Check whether a hardware device is enabled",
    help:
      'params {"device"} — Windows only. Is this device present, enabled, or switched off in ' +
      'Device Manager. Matched on its friendly name, e.g. {"device": "Camera"}. Reports status, ' +
      "the Device Manager problem code, and the instance id",
    // The read half of fix.enable_device, and it exists so the planner never has
    // to compose `Get-PnpDevice -FriendlyName *Camera*` through
    // diag.command_output. T-7621 tried exactly that, the wildcard was refused
    // by the argv filter, and no rewording could have worked. The registry is
    // where "the system can read a device's status" belongs.
    risk: 0,
    os: ["win32"],
    requiresElevation: false,
    params: z.object({ device: deviceName }).strict(),
    command: (p) => `device_status --device "${p.device}"`,
    probe: "probePnpDevice",
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "diag.screenshot",
    kind: "device",
    label: "Ask the employee for a screenshot of their screen",
    help:
      "no params — asks the employee ON THEIR OWN MACHINE for permission, then captures one " +
      "screenshot. They see a dialog naming this ticket and can refuse. Use only when the problem " +
      "is visual and they have not already attached one",
    // Risk 0 by the ladder — it reads and changes nothing. The gate that matters
    // for this one is not the risk number, it is the consent prompt on the
    // device, which no autonomy rung can reach.
    risk: 0,
    os: BOTH,
    requiresElevation: false,
    params: emptyParams,
    command: () => "screenshot",
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "user-session",
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
    // No undo, and the honest reason: a restart that did not take left the app
    // exactly where it was, so there is nothing to put back. "Relaunch it if it
    // was left closed" — what this field used to say — describes recovery from a
    // half-finished action, not a state undo, and naming it here made the agent
    // look like it had a rollback it has never had.
    rollback: null,
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
    // Same as fix.restart_app: the adapter is cycled down and back up in one
    // action, so a run that changed nothing never brought it down and has
    // nothing to restore. `reversible: "self"` is the whole truth here.
    rollback: null,
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

  defineCapability({
    id: "fix.restart_service",
    kind: "device",
    label: "Restart a system service",
    help: 'params {"service"} — restart a named OS service (spooler, dns client, etc.)',
    risk: 1,
    os: BOTH,
    requiresElevation: true,
    params: z
      .object({
        service: z
          .string()
          .trim()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9 ._-]+$/, "service name contains unsupported characters"),
      })
      .strict(),
    command: (p) => `restart_service --service "${p.service}"`,
    probe: "probeService",
    rollback: "start the service again if it was left stopped",
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.clear_print_queue",
    kind: "device",
    label: "Clear the stuck print queue",
    help: "no params — stops the spooler, discards queued jobs, starts it again",
    risk: 1,
    os: BOTH,
    requiresElevation: true,
    params: emptyParams,
    command: () => "clear_print_queue",
    probe: "probePrintQueue",
    rollback: "start the spooler again if it was left stopped",
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.renew_dhcp_lease",
    kind: "device",
    label: "Release and renew the DHCP lease",
    help: "no params — drops the current address and asks for a new one; briefly interrupts the link",
    risk: 1,
    os: BOTH,
    requiresElevation: true,
    params: emptyParams,
    command: () => "renew_dhcp_lease",
    probe: "probeDhcp",
    rollback: "renew again if the interface was left without an address",
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.gpupdate",
    kind: "device",
    label: "Re-apply group policy",
    help: "Windows only, no params — forces a group policy refresh",
    risk: 1,
    os: ["win32"],
    requiresElevation: true,
    params: emptyParams,
    command: () => "gpupdate",
    probe: "probeGpo",
    // Re-applying policy is what the domain would do on its own schedule; there
    // is nothing to undo, and pretending otherwise would be worse than saying so.
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),

  defineCapability({
    id: "fix.restart_shell",
    kind: "device",
    label: "Restart the desktop shell",
    help:
      "no params — restarts Explorer on Windows (the Dock on macOS). For a missing taskbar, Start " +
      "menu or desktop icons when the setting behind them is already correct. Open windows survive",
    risk: 1,
    os: BOTH,
    requiresElevation: false,
    params: emptyParams,
    command: () => "restart_shell",
    probe: "probeProcess",
    // Same reasoning as fix.restart_app: the shell is stopped and started in one
    // action, so a run that changed nothing never stopped it and has nothing to
    // put back. The handler fails the step outright if the shell does not return.
    rollback: null,
    reversible: "self",
    blastRadius: "user-session",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.reconnect_vpn",
    kind: "device",
    label: "Reconnect the VPN",
    help:
      'params {"name"?} — drops and re-establishes the tunnel. Briefly interrupts anything running ' +
      "over it. Fixes a tunnel that is down; does nothing for a tunnel that is up but misrouted",
    risk: 1,
    os: BOTH,
    requiresElevation: true,
    params: z.object({ name: vpnName }).strict(),
    command: (p) => `reconnect_vpn --name "${p.name}"`,
    probe: "probeVpn",
    // Down-then-up in one action. Nothing to restore if it never came down.
    rollback: null,
    reversible: "self",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),

  // ---------------------------------------------------------------- risk 2
  defineCapability({
    id: "fix.set_proxy",
    kind: "device",
    label: "Set or clear the HTTP proxy",
    help:
      'params {"server"?, "port"?} — set the system HTTP/HTTPS proxy, or omit both to clear it. ' +
      "Reversible: the existing proxy configuration is captured before the change",
    risk: 2,
    os: BOTH,
    requiresElevation: true,
    params: z
      .object({
        server: z
          .string()
          .trim()
          .max(253)
          .regex(/^[a-zA-Z0-9.-]*$/, "proxy host must be a bare hostname or IP")
          .default(""),
        port: z.number().int().min(1).max(65535).optional(),
      })
      .strict(),
    command: (p) =>
      p.server
        ? `set_proxy --server "${p.server}" --port ${p.port ?? 8080}`
        : `set_proxy --server "" --port 0`,
    probe: "probeProxy",
    rollback: "re-apply the proxy configuration captured by the before-probe",
    reversible: "recorded",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.reset_winsock",
    kind: "device",
    label: "Reset the Windows network stack",
    help:
      "Windows only, no params — resets the Winsock catalog. Takes effect only after a REBOOT, " +
      "and cannot be undone without one. Always requires a person",
    risk: 2,
    os: ["win32"],
    requiresElevation: true,
    params: emptyParams,
    command: () => "reset_winsock",
    probe: "probeWinsock",
    // No undo that does not itself require a reboot. Declared honestly, which is
    // what makes policy hold it for a person.
    rollback: null,
    reversible: "none",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
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

  defineCapability({
    id: "fix.kill_process",
    kind: "device",
    label: "Force-quit an application",
    help:
      'params {"app"} — ends a hung or runaway process. Anything unsaved in that app is LOST and ' +
      "there is no undo, which is why this is risk 2 and not a restart. System processes are refused",
    // Risk 2 rather than 1 for one reason: a restart hands the app a chance to
    // save and this does not. The cost of being wrong is the employee's
    // unwritten work, so it sits above "temporary state" on the ladder.
    risk: 2,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ app: appName }).strict(),
    command: (p) => `kill_process --app "${p.app}"`,
    probe: "probeProcess",
    rollback: null,
    reversible: "none",
    blastRadius: "user-session",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.set_taskbar_autohide",
    kind: "device",
    label: "Turn taskbar auto-hide on or off",
    help:
      'params {"autoHide"} — the usual cause of "my taskbar disappeared" when the shell is still ' +
      "running. Restarts the shell so the setting takes effect. Reversible: the prior setting is " +
      "captured before the change",
    // Risk 2, not 1: it is written to the registry and survives a reboot, which
    // is the line between "temporary state" and "configuration".
    risk: 2,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ autoHide: z.boolean() }).strict(),
    command: (p) => `set_taskbar_autohide --autohide ${p.autoHide}`,
    probe: "probeTaskbar",
    rollback: "re-apply the auto-hide setting captured by the before-probe",
    reversible: "recorded",
    blastRadius: "user-session",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.set_startup_item",
    kind: "device",
    label: "Enable or disable a startup item",
    help:
      'params {"item", "enabled"} — Windows only. Flips whether a Run-key entry launches at logon, ' +
      "the same switch as Task Manager's Startup tab. The entry itself is never deleted. " +
      "Reversible: the prior state is captured before the change",
    risk: 2,
    os: ["win32"],
    requiresElevation: false,
    params: z.object({ item: startupItem, enabled: z.boolean() }).strict(),
    command: (p) => `set_startup_item --item "${p.item}" --enabled ${p.enabled}`,
    probe: "probeStartupItems",
    rollback: "re-apply the startup approval byte captured by the before-probe",
    reversible: "recorded",
    blastRadius: "user-session",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "fix.enable_device",
    kind: "device",
    label: "Enable a disabled hardware device",
    help:
      'params {"device"} — Windows only. Enables hardware switched off in Device Manager (camera, ' +
      "microphone, adapter), matched on its friendly name. Reversible: disabled again if the change " +
      "does not verify",
    risk: 2,
    os: ["win32"],
    requiresElevation: true,
    params: z.object({ device: deviceName }).strict(),
    command: (p) => `enable_device --device "${p.device}"`,
    probe: "probePnpDevice",
    rollback: "disable the device again using the instance id captured by the before-probe",
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
  defineCapability({
    id: "fix.install_package",
    kind: "device",
    label: "Install an application or runtime",
    help:
      'params {"package"} — Windows only, a winget package id such as ' +
      '"Microsoft.VCRedist.2015+.x64". Installs software on the machine, so it is always ' +
      "human-approved. Reversible: uninstalled again if the install does not verify",
    risk: 3,
    os: ["win32"],
    requiresElevation: true,
    params: z.object({ package: packageId }).strict(),
    command: (p) => `install_package --package "${p.package}"`,
    probe: "probePackage",
    // The undo only fires when the before-probe found the package ABSENT.
    // Uninstalling something the employee already had would be a second fault
    // dressed as a recovery.
    rollback: "winget uninstall the package, but only when the before-probe found it absent",
    reversible: "recorded",
    blastRadius: "device",
    provenance: BUILT_IN,
  }),
  defineCapability({
    id: "exec.cmd",
    kind: "device",
    label: "Run command or PowerShell script on VM",
    help: 'params {"command"} — execute command or script directly on the target VM',
    risk: 1,
    os: BOTH,
    requiresElevation: false,
    params: z.object({ command: z.string().trim().min(1).max(4096) }).strict(),
    command: (p) => `exec_cmd --command "${p.command.replace(/"/g, '\\"')}"`,
    probe: null,
    rollback: null,
    reversible: "self",
    blastRadius: "device",
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
