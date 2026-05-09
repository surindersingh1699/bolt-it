import { PlanStep } from "../types";

export interface AsideExecutionResult {
  ok: boolean;
  log: string[];
}

export async function asideExecute(step: PlanStep, userEmail: string): Promise<AsideExecutionResult> {
  const log: string[] = [];
  log.push(`[Aside] Opening user's authenticated browser session for ${userEmail}`);
  log.push(`[Aside] Capability: ${step.capability}`);
  log.push(`[Aside] Browser session token: <held by user, never by agent>`);
  await sleep(700);
  log.push(`[Aside] Navigating to target URL`);
  await sleep(400);

  if (step.capability === "okta.add_to_group") {
    const group = (step.params?.group as string) ?? "unknown";
    log.push(`[Aside] Located Okta admin > Groups > ${group}`);
    await sleep(500);
    log.push(`[Aside] Submitted "Add member" form for ${userEmail}`);
    await sleep(300);
    log.push(`[Aside] Confirmation: ${userEmail} added to ${group}`);
    return { ok: true, log };
  }

  if (step.capability === "okta.send_reset") {
    log.push(`[Aside] Located Okta admin > People > ${userEmail}`);
    await sleep(400);
    log.push(`[Aside] Triggered "More Actions > Reset Password"`);
    await sleep(300);
    log.push(`[Aside] Reset email dispatched`);
    return { ok: true, log };
  }

  log.push(`[Aside] Generic action completed via user browser`);
  return { ok: true, log };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
