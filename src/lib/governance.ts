import { db } from "./db";
import { CapabilityPrecedent } from "./types";

export const PROMOTION_THRESHOLD = 3;

// Hard floor: capabilities listed here can NEVER be auto-promoted, no matter
// how many clean approvals accumulate. Checked before the precedent counter,
// so it can't be bypassed by volume. Intentionally empty today — populate
// only with real capability strings that must always require a human.
export const NEVER_AUTO_PROMOTE: ReadonlySet<string> = new Set([]);

export function getPrecedent(workspaceId: string, capability: string): CapabilityPrecedent | undefined {
  return db.getCapabilityPrecedent(workspaceId, capability);
}

export function isAutoPromoted(workspaceId: string, capability: string): boolean {
  if (NEVER_AUTO_PROMOTE.has(capability)) return false;
  const precedent = getPrecedent(workspaceId, capability);
  return Boolean(precedent?.promotedAt);
}

export function recordCleanExecution(
  workspaceId: string,
  capability: string,
  approver: { name: string; email: string },
): CapabilityPrecedent {
  const existing = getPrecedent(workspaceId, capability);
  const cleanExecutions = (existing?.cleanExecutions ?? 0) + 1;
  const updated: CapabilityPrecedent = {
    workspaceId,
    capability,
    cleanExecutions,
    lastApprovedAt: Date.now(),
    lastApprovedBy: approver.email,
    promotedAt:
      existing?.promotedAt ??
      (cleanExecutions >= PROMOTION_THRESHOLD && !NEVER_AUTO_PROMOTE.has(capability)
        ? Date.now()
        : undefined),
  };
  db.upsertCapabilityPrecedent(updated);
  return updated;
}
