import { PlanStep, StepRisk, StepApprovalMode, Ticket, RiskSource } from "./types";
import { NEVER_AUTO_PROMOTE, PROMOTION_THRESHOLD, getPrecedent, isAutoPromoted } from "./governance";

interface ClassifyResult {
  risk: StepRisk;
  reason: string;
  source: RiskSource;
}

// The capability set is small and every entry is real, so risk is a lookup —
// no LLM judge to be wrong, prompt-injected, or unavailable.
const ALLOWLIST_LOW = new Set([
  "ad.lookup_user",
  "diag.system_info",
  "diag.app_status",
  "diag.app_logs",
  // Open read surface: observation only, no path that changes the machine.
  "diag.process_list",
  "diag.network_state",
  "diag.command_output",
]);

// Changes the user's machine, but only their own session, and reversibly.
const ALLOWLIST_MEDIUM = new Set(["fix.restart_app", "fix.clear_app_cache"]);

// Touches credentials, account state, or the machine's network link.
const ALLOWLIST_HIGH = new Set([
  "ad.unlock_account",
  "ad.reset_password",
  "ad.refresh_kerberos",
  "fix.toggle_wifi",
]);

function classify(step: PlanStep): ClassifyResult {
  if (step.kind === "reply") {
    return { risk: "low", reason: "reply: user-visible message only", source: "allowlist" };
  }
  const cap = step.capability;
  if (cap && ALLOWLIST_LOW.has(cap)) {
    return { risk: "low", reason: `${cap}: read-only or notification`, source: "allowlist" };
  }
  if (cap && ALLOWLIST_MEDIUM.has(cap)) {
    return { risk: "medium", reason: `${cap}: reversible change to the user's own machine`, source: "allowlist" };
  }
  if (cap && ALLOWLIST_HIGH.has(cap)) {
    return { risk: "high", reason: `${cap}: writes to identity or device state`, source: "allowlist" };
  }
  // Anything unlisted is unknown, and unknown is high — a human decides.
  return {
    risk: "high",
    reason: `${cap ?? "unlisted step"} is not an allowlisted capability — human approval required`,
    source: "fallback",
  };
}

function resolveApprovalMode(
  risk: StepRisk,
  workspaceId: string,
  capability: string | undefined,
): StepApprovalMode {
  if (risk !== "high") return "auto";
  if (!capability || NEVER_AUTO_PROMOTE.has(capability)) return "human";
  return isAutoPromoted(workspaceId, capability) ? "auto" : "human";
}

export async function classifyPlan(plan: PlanStep[], ticket: Ticket): Promise<PlanStep[]> {
  return plan.map((step) => {
    const result = classify(step);
    const approvalMode = resolveApprovalMode(result.risk, ticket.workspaceId, step.capability);
    const governancePromoted = approvalMode === "auto" && result.risk === "high";
    const policyLog = governancePromoted
      ? `[Policy] step ${step.id}: high risk but auto-promoted after ${
          getPrecedent(ticket.workspaceId, step.capability!)?.cleanExecutions ?? PROMOTION_THRESHOLD
        } clean approvals of ${step.capability} — running without human gate`
      : `[Policy] step ${step.id}: ${result.risk} (${result.source}) — ${result.reason}`;
    return {
      ...step,
      risk: result.risk,
      approvalMode,
      riskReason: result.reason,
      riskSource: result.source,
      governancePromoted: governancePromoted || undefined,
      log: [...(step.log ?? []), policyLog],
    };
  });
}
