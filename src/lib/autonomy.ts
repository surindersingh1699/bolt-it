// One switch for how much the agent may do without a human in the loop.
//
//   full   — no approval gate. Every "ask_human" verdict runs unattended,
//            including the ALWAYS_ASK floor and the cross-account target bind.
//            For sandbox / disposable-VM testing.
//   gated  — high-risk steps stop at interrupt() and wait for a person.
//
// Autonomy decides whether anyone WAITS on a person. It does not widen what a
// tier can reach for: capability sets are fixed by tier in both modes (see
// capsFor in tiers.ts), because a tier that can reach for anything never
// reaches past its own depth and so never hands the ticket down.
//
// Default is "full" outside production, because that is what a prototype wants,
// and "gated" in production, because that is what a fleet wants. Override with
// AUTONOMY=full or AUTONOMY=gated.
//
// Risk classification runs in BOTH modes. Under "full" the log still records
// what each step would have been gated on and the UI still renders the badge —
// the gate is bypassed, not deleted. That is deliberate: turning the boundary
// back on is a flag flip rather than a rewrite, and while it is off you can
// still read back exactly which steps were running unsupervised.

export type AutonomyLevel = "full" | "gated";

// Read per call rather than cached at module load, so a test can pin a posture
// and so flipping the env var takes effect without a restart. It is one env
// lookup on a path that is already doing network I/O.
export function autonomyLevel(): AutonomyLevel {
  const raw = process.env.AUTONOMY;
  if (raw === "full" || raw === "gated") return raw;
  return process.env.NODE_ENV === "production" ? "gated" : "full";
}

export function isFullyAutonomous(): boolean {
  return autonomyLevel() === "full";
}

/** Banner for the trace, so an autonomous run is never mistaken for a gated one. */
export function autonomyNote(): string {
  return isFullyAutonomous()
    ? "AUTONOMY=full — approval gate bypassed, all capabilities unlocked"
    : "AUTONOMY=gated — high-risk steps require human approval";
}
