import { PlanStep } from "../types";
import { getADAccount, getADUser, listADGroups, updateADAccount } from "../data";

export interface DirectoryResult {
  ok: boolean;
  log: string[];
  data?: Record<string, unknown>;
}

/**
 * Directory (AD) actions. Every branch here reads or writes real account state
 * in the database — there is no narrated flow. A capability with no real
 * backend does not belong in this file; it belongs nowhere.
 */
export async function directoryInvoke(step: PlanStep, userEmail: string): Promise<DirectoryResult> {
  const log: string[] = [];

  if (step.capability === "ad.lookup_user") {
    const user = await getADUser(userEmail);
    const acct = await getADAccount(userEmail);
    if (!user || !acct) {
      log.push(`[Directory] No AD record found for ${userEmail}`);
      return { ok: false, log };
    }
    const groups = await listADGroups();
    const userGroups = groups.filter((g) => g.members.includes(userEmail)).map((g) => g.id);
    log.push(`[Directory] ${user.name} (${user.title}, ${user.team})`);
    log.push(`[Directory] Account status: ${acct.status} · failed logins: ${acct.failedLoginCount}`);
    log.push(`[Directory] Groups: ${userGroups.join(", ")}`);
    return {
      ok: true,
      log,
      data: {
        name: user.name,
        team: user.team,
        title: user.title,
        manager: user.manager,
        status: acct.status,
        groups: userGroups,
        passwordExpiresAt: acct.passwordExpiresAt,
        kerberosTicketAt: acct.kerberosTicketAt,
      },
    };
  }

  if (step.capability === "ad.unlock_account") {
    const acct = await getADAccount(userEmail);
    if (!acct) {
      log.push(`[Directory] No AD account found for ${userEmail}`);
      return { ok: false, log };
    }
    if (acct.status !== "locked") {
      log.push(`[Directory] Account status is ${acct.status}; nothing to unlock. Idempotent OK.`);
      return { ok: true, log };
    }
    await updateADAccount(userEmail, { status: "active", failedLoginCount: 0, lockedAt: undefined });
    log.push(`[Directory] Account unlocked. Failed login counter reset to 0.`);
    return { ok: true, log };
  }

  if (step.capability === "ad.reset_password") {
    const acct = await getADAccount(userEmail);
    if (!acct) {
      log.push(`[Directory] No AD account found for ${userEmail}`);
      return { ok: false, log };
    }
    const now = Date.now();
    await updateADAccount(userEmail, {
      status: "active",
      failedLoginCount: 0,
      lockedAt: undefined,
      passwordChangedAt: now,
      passwordExpiresAt: now + 90 * 24 * 60 * 60 * 1000,
    });
    log.push(`[Directory] Password reset issued — user must change it at next logon.`);
    return { ok: true, log };
  }

  if (step.capability === "ad.refresh_kerberos") {
    const acct = await getADAccount(userEmail);
    if (!acct) {
      log.push(`[Directory] No AD account found for ${userEmail}`);
      return { ok: false, log };
    }
    await updateADAccount(userEmail, {
      status: acct.status === "stale_kerberos" ? "active" : acct.status,
      kerberosTicketAt: Date.now(),
    });
    log.push(`[Directory] New Kerberos TGT issued. Mapped drives should reauth automatically.`);
    return { ok: true, log };
  }

  log.push(`[Directory] Unknown capability: ${step.capability ?? "(none)"}`);
  return { ok: false, log };
}
