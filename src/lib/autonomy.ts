/**
 * How much this system may do without a person, and whether it may act at all.
 *
 * This used to be a two-value switch (`full` / `gated`) answering one question:
 * does anybody WAIT for a human. That could not express the two postures worth
 * having most — "compute the whole thing and touch nothing" — so it is now a
 * ladder, and each rung answers both questions at once.
 *
 *   simulation — probes run, writes are computed and logged, nothing is sent to
 *                the machine. The cheapest way to see what a ticket would do.
 *   shadow     — the same, plus the full artifact, so the intended plan can be
 *                diffed against what the machine actually looks like.
 *   limited    — risk 0 and 1 run unattended. Anything that survives a reboot
 *                waits for a person.
 *   gated      — every high-risk step stops at interrupt().
 *   full       — nothing waits, EXCEPT the rules policy.ts marks non-bypassable.
 *
 * Autonomy decides who waits. It does not decide what is reachable: the
 * capability set is closed in the registry either way, and `policy.ts` holds a
 * short list of decisions autonomy cannot overrule at all.
 *
 * Default is "full" outside production, because that is what a prototype wants,
 * and "gated" in production, because that is what a fleet wants. Override with
 * AUTONOMY=<rung>.
 *
 * Classification runs on every rung. Under "full" the log still records what
 * each step would have been gated on and the UI still renders the badge — the
 * gate is bypassed, not deleted. Turning the boundary back on is a flag flip.
 */

export type ExecutionMode = "simulation" | "shadow" | "limited" | "gated" | "full";

const MODES: readonly ExecutionMode[] = ["simulation", "shadow", "limited", "gated", "full"];

/** Rungs on which no write is ever sent to a machine. */
const DRY_MODES: ReadonlySet<ExecutionMode> = new Set<ExecutionMode>(["simulation", "shadow"]);

// Read per call rather than cached at module load, so a test can pin a posture
// and so flipping the env var takes effect without a restart. It is one env
// lookup on a path that is already doing network I/O.
export function executionMode(): ExecutionMode {
  const raw = process.env.AUTONOMY as ExecutionMode | undefined;
  if (raw && MODES.includes(raw)) return raw;
  return "full";
}

/** Back-compat alias. The rung IS the autonomy level now. */
export const autonomyLevel = executionMode;

export function isFullyAutonomous(): boolean {
  return executionMode() === "full";
}

/**
 * True when a state-changing step must be computed but never sent.
 *
 * Reads still run on these rungs — a simulation with no readings tells you
 * nothing about whether the plan was reasonable.
 */
export function isDryRun(mode: ExecutionMode = executionMode()): boolean {
  return DRY_MODES.has(mode);
}

/** Banner for the trace, so a dry run is never mistaken for a real one. */
export function autonomyNote(mode: ExecutionMode = executionMode()): string {
  switch (mode) {
    case "simulation":
      return "AUTONOMY=simulation — reads run, writes are computed and discarded; the machine is not touched";
    case "shadow":
      return "AUTONOMY=shadow — reads run, writes are computed and recorded but not sent; the machine is not touched";
    case "limited":
      return "AUTONOMY=limited — risk 0-1 runs unattended, anything that survives a reboot waits for a person";
    case "gated":
      return "AUTONOMY=gated — high-risk steps require human approval";
    case "full":
      return "AUTONOMY=full — approval gate bypassed except where policy marks a decision non-bypassable";
  }
}
