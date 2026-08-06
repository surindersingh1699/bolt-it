/**
 * Incident memory: what happened the last time this KIND of problem came in,
 * across everyone.
 *
 * [memory.ts](./memory.ts) answers "what do we know about this person". This
 * answers "what do we know about this problem". They are different questions
 * and they want different keys — a printer fault is a printer fault whether it
 * is Dana's or Sam's, and the fix that worked on Dana's is the single most
 * useful thing to know when Sam files.
 *
 * Deliberate design choices, both inherited from user memory:
 *
 *  - **Closed category set, not a vector index.** Retrieval is an equality
 *    match on `IncidentCategory`. A closed set keeps this from becoming a junk
 *    drawer of near-duplicate strings, it is explainable ("we looked at 27 past
 *    VPN tickets"), and it costs no embedding call. The categories are coarse on
 *    purpose: a bucket with 40 tickets in it is useful, a bucket with 1 is not.
 *
 *  - **Outcomes only.** An incident row records what was TRIED and whether the
 *    machine actually changed. It never stores the reasoning that led there.
 *    Success rates computed from this are grounded in device evidence, which is
 *    the whole reason they can be trusted more than a model's own estimate.
 */

/**
 * Coarse problem classes. Assigned by the same extractor pass that writes user
 * memory, constrained to this list. Keep it short — the value is in the bucket
 * being big enough to have a track record.
 */
export const INCIDENT_CATEGORIES = [
  "app_crash",
  "app_slow",
  "login_failure",
  "account_lockout",
  "password_credential",
  "network_connectivity",
  "vpn",
  "printing",
  "email_sync",
  "storage_full",
  "peripheral_hardware",
  "software_install",
  "performance",
  "other",
] as const;

export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export function isIncidentCategory(c: string): c is IncidentCategory {
  return (INCIDENT_CATEGORIES as readonly string[]).includes(c);
}

/**
 * Ordered keyword rules. First match wins, so the specific classes are listed
 * before the general ones — "cannot print over VPN" is a printing problem, and
 * "Outlook crashes" is a crash rather than an email-sync fault.
 *
 * This is deliberately not an LLM call. The category is needed *before* drafting
 * in order to retrieve history, and it is needed again at write time; running a
 * model twice would put latency on the critical path and could still assign two
 * different buckets to the same ticket, which silently breaks retrieval. A pure
 * function cannot disagree with itself.
 */
const CATEGORY_RULES: ReadonlyArray<[IncidentCategory, RegExp]> = [
  ["printing", /\bprint(er|ing|s)?\b|\bspool|\btoner|\bpaper jam/i],
  ["vpn", /\bvpn\b|\banyconnect\b|\bglobalprotect\b|\btunnel\b/i],
  ["account_lockout", /\block(ed|out)\b|\btoo many attempts\b|\bdisabled account\b/i],
  ["password_credential", /\bpassword\b|\bcredential|\bmfa\b|\b2fa\b|\bkerberos\b|\bexpired\b/i],
  ["login_failure", /\b(can.?t|cannot|unable to) (log ?in|sign ?in)\b|\blogin fail|\bauth(entication)? (fail|error)/i],
  ["storage_full", /\bdisk (is )?full\b|\bout of (disk )?space\b|\bstorage full\b|\bno space left\b/i],
  // A crash outranks a sync fault: an app that stops is a crash, whatever it
  // was doing at the time. "Outlook crashes when syncing" is the crash.
  ["app_crash", /\bcrash(es|ed|ing)?\b|\bquit unexpectedly\b|\bnot responding\b|\bfroze|\bfreez(e|es|ing)\b/i],
  ["email_sync", /\b(outlook|email|mailbox|inbox)\b.*\b(sync|not receiving|stuck|delay)/i],
  ["network_connectivity", /\bwi-?fi\b|\bnetwork\b|\bno internet\b|\boffline\b|\bdns\b|\bethernet\b/i],
  ["software_install", /\binstall(ation|ing)?\b|\bupdate fail|\bupgrade fail|\blicen[cs]e\b/i],
  ["peripheral_hardware", /\bmonitor\b|\bkeyboard\b|\bmouse\b|\bheadset\b|\bwebcam\b|\bdock(ing)?\b|\bbattery\b/i],
  ["app_slow", /\bslow\b|\blag(gy|ging)?\b|\btakes (ages|forever)\b|\bhang(s|ing)?\b/i],
  ["performance", /\bcpu\b|\bmemory\b|\bram\b|\bfan\b|\boverheat/i],
];

/**
 * Bucket a ticket by symptom. Same input always yields the same bucket, so the
 * category written at the end of a ticket is the one the next ticket retrieves.
 * Unmatched text is "other" rather than a guess — a wrong bucket is worse than
 * no bucket, because it pollutes another class's track record.
 */
export function classifyIncident(subject: string, body: string): IncidentCategory {
  const text = `${subject}\n${body}`;
  for (const [category, pattern] of CATEGORY_RULES) {
    if (pattern.test(text)) return category;
  }
  return "other";
}

/** One past ticket, reduced to the parts that predict the next one. */
export interface IncidentRecord {
  id: string;
  workspaceId: string;
  ticketId: string;
  category: IncidentCategory;
  /** One line naming the symptom as reported, for the planner to pattern-match. */
  symptom: string;
  /** Deepest tier that worked it. */
  tier: number;
  /** Capabilities that ran, in order. */
  capabilitiesUsed: string[];
  /**
   * The capability that actually moved the machine, when there was one. This is
   * the payload — "what fixed it last time".
   */
  resolvedBy?: string;
  resolved: boolean;
  /** Set when unresolved: the taxonomy kind that ended it. */
  failureKind?: string;
  at: number;
}

/** Track record for one capability within one problem class. */
export interface CapabilityOutcome {
  capability: string;
  attempts: number;
  successes: number;
  /** successes / attempts. Only meaningful once attempts clears MIN_SAMPLES. */
  successRate: number;
}

export interface IncidentStats {
  category: IncidentCategory;
  total: number;
  resolved: number;
  /** Best-performing capabilities first. */
  capabilities: CapabilityOutcome[];
  /** Most recent matching incidents, newest first. */
  recent: IncidentRecord[];
}

/**
 * Below this many attempts a success rate is noise, and presenting it as a
 * number invites the planner to treat one lucky run as a law. Rates under this
 * threshold are rendered as raw counts instead.
 */
export const MIN_SAMPLES = 3;

/** How many past incidents in a category the planner sees. */
export const INCIDENT_WINDOW = 5;

export const EMPTY_STATS = (category: IncidentCategory): IncidentStats => ({
  category,
  total: 0,
  resolved: 0,
  capabilities: [],
  recent: [],
});

/**
 * Reduce raw incident rows to a per-capability track record.
 *
 * A capability counts as a success only where it is the `resolvedBy` — the one
 * that moved the machine. Merely having run in a ticket that later resolved is
 * not evidence it helped, and counting it that way would inflate every
 * diagnostic in the set to a near-perfect score.
 */
export function summarizeIncidents(
  category: IncidentCategory,
  rows: IncidentRecord[],
): IncidentStats {
  const attempts = new Map<string, number>();
  const successes = new Map<string, number>();

  for (const row of rows) {
    for (const cap of new Set(row.capabilitiesUsed)) {
      attempts.set(cap, (attempts.get(cap) ?? 0) + 1);
    }
    if (row.resolved && row.resolvedBy) {
      successes.set(row.resolvedBy, (successes.get(row.resolvedBy) ?? 0) + 1);
    }
  }

  const capabilities: CapabilityOutcome[] = [...attempts.entries()]
    .map(([capability, n]) => ({
      capability,
      attempts: n,
      successes: successes.get(capability) ?? 0,
      successRate: n > 0 ? (successes.get(capability) ?? 0) / n : 0,
    }))
    .sort((a, b) => b.successRate - a.successRate || b.attempts - a.attempts);

  return {
    category,
    total: rows.length,
    resolved: rows.filter((r) => r.resolved).length,
    capabilities,
    recent: [...rows].sort((a, b) => b.at - a.at).slice(0, INCIDENT_WINDOW),
  };
}

/**
 * Renders incident history for a tier prompt.
 *
 * The honesty rule here matters as much as the numbers: a rate is only shown
 * once the sample supports it, and the sample size is always shown alongside,
 * so the planner can tell "3 of 4" from "31 of 40". Empty history renders as
 * nothing at all rather than as a discouraging block of zeroes.
 */
export function incidentsAsContext(stats: IncidentStats | null): string {
  if (!stats || stats.total === 0) return "";

  const parts: string[] = [
    `${stats.total} past ticket(s) in this workspace were classed as "${stats.category}"; ` +
      `${stats.resolved} of them ended resolved.`,
  ];

  if (stats.capabilities.length > 0) {
    const lines = stats.capabilities.map((c) => {
      const record =
        c.attempts >= MIN_SAMPLES
          ? `${Math.round(c.successRate * 100)}% (${c.successes}/${c.attempts})`
          : `${c.successes}/${c.attempts} — too few to rate`;
      return `- ${c.capability}: fixed it ${record}`;
    });
    parts.push(`What has actually worked on this class of problem:\n${lines.join("\n")}`);
  }

  if (stats.recent.length > 0) {
    const lines = stats.recent.map((r) => {
      const outcome = r.resolved
        ? `resolved at tier ${r.tier}${r.resolvedBy ? ` by ${r.resolvedBy}` : ""}`
        : `NOT resolved${r.failureKind ? ` (${r.failureKind})` : ""}`;
      return `- ${new Date(r.at).toISOString().slice(0, 10)} (${r.ticketId}): ${r.symptom} → ${outcome}`;
    });
    parts.push(`Most recent of them:\n${lines.join("\n")}`);
  }

  parts.push(
    "These rates are computed from before/after device evidence, not from anyone's estimate. " +
      "A capability with a strong record on this problem class is the one to reach for first. " +
      "A capability that has repeatedly failed here is not worth a second attempt unless you can " +
      "state what is different this time.",
  );

  return `\n\n## What has worked on this kind of problem\n${parts.join("\n\n")}\n`;
}
