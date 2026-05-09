import { PlanStep } from "../types";
import { sandboxReadLogs } from "./sandbox";

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

  if (step.capability === "sandbox.read_auth_logs") {
    log.push(`[Tensorlake] Delegating to Vercel Sandbox for read-only log access`);
    const result = await sandboxReadLogs({
      userEmail,
      paths: ["/var/log/auth.log"],
      reason: "Investigate failed-login pattern that may have triggered AD lockout",
    });
    log.push(...result.log);
    if (result.matches && result.matches.length > 0) {
      log.push(`[Tensorlake] Findings:`);
      for (const m of result.matches.slice(0, 8)) {
        log.push(`  ${m.path}:${m.line}  ${m.text}`);
      }
    }
    return { ok: result.ok, log };
  }

  if (step.capability === "sandbox.read_kerberos_logs") {
    log.push(`[Tensorlake] Delegating to Vercel Sandbox for read-only Kerberos log access`);
    const result = await sandboxReadLogs({
      userEmail,
      paths: ["/var/log/krb5/krb5kdc.log", "/var/log/system.log"],
      reason: "Investigate stale Kerberos ticket / mapped-drive prompt regression",
    });
    log.push(...result.log);
    if (result.matches && result.matches.length > 0) {
      log.push(`[Tensorlake] Findings:`);
      for (const m of result.matches.slice(0, 8)) {
        log.push(`  ${m.path}:${m.line}  ${m.text}`);
      }
    }
    return { ok: result.ok, log };
  }

  log.push(`[Tensorlake] Generic diagnostic finished`);
  return { ok: true, log };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
