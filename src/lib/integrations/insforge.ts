import { PlanStep } from "../types";

export interface InsforgeResult {
  ok: boolean;
  log: string[];
  data?: Record<string, unknown>;
}

export async function insforgeInvoke(step: PlanStep, userEmail: string): Promise<InsforgeResult> {
  const log: string[] = [];
  log.push(`[InsForge] Edge function invoked: ${step.capability}`);
  log.push(`[InsForge] Policy gate: checking customer-defined policy for capability`);
  await sleep(300);
  log.push(`[InsForge] Policy match: capability allowed for current ticket scope`);
  await sleep(200);

  if (step.capability === "okta.list_groups") {
    log.push(`[InsForge] Querying Okta API via scoped service account`);
    await sleep(500);
    const groups = ["everyone", "engineering"];
    log.push(`[InsForge] User ${userEmail} groups: ${groups.join(", ")}`);
    log.push(`[InsForge] Expected group "figma-designers" missing`);
    return { ok: true, log, data: { groups, missing: ["figma-designers"] } };
  }

  if (step.capability === "mdm.push_vpn_config") {
    log.push(`[InsForge] Looking up device serial via MDM API`);
    await sleep(400);
    log.push(`[InsForge] Pushing refreshed VPN profile`);
    await sleep(300);
    log.push(`[InsForge] Push acknowledged by device`);
    return { ok: true, log };
  }

  if (step.capability === "identity.verify") {
    log.push(`[InsForge] Cross-referencing Hyperspell user context`);
    await sleep(400);
    log.push(`[InsForge] Recent activity matches reported account; identity verified`);
    return { ok: true, log };
  }

  log.push(`[InsForge] Generic capability completed`);
  return { ok: true, log };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
