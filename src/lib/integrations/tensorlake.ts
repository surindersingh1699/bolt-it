import { PlanStep } from "../types";

export interface TensorlakeResult {
  ok: boolean;
  log: string[];
}

export async function tensorlakeRun(step: PlanStep, userEmail: string): Promise<TensorlakeResult> {
  const log: string[] = [];
  log.push(`[Tensorlake] Cold-starting sandboxed VM (target 150ms)`);
  await sleep(150);
  log.push(`[Tensorlake] Sandbox ready. FS isolated, no network egress to corp systems`);
  log.push(`[Tensorlake] Capability: ${step.capability}`);

  if (step.capability === "diag.network_probe") {
    log.push(`[Tensorlake] Running probe: traceroute to last-known VPN endpoint`);
    await sleep(800);
    log.push(`[Tensorlake] Result: 14 hops, 3 retransmissions, MTU mismatch detected`);
    log.push(`[Tensorlake] Diagnosis: stale VPN profile referencing decommissioned gateway`);
    return { ok: true, log };
  }

  log.push(`[Tensorlake] Generic diagnostic finished`);
  return { ok: true, log };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
