import { PlanStep } from "../types";
import { getADAccount, getADUser, listADGroups, updateADAccount } from "../data";

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

  if (step.capability === "ad.lookup_user") {
    log.push(`[InsForge] Querying AD via scoped LDAP read service account`);
    await sleep(350);
    const user = await getADUser(userEmail);
    const acct = await getADAccount(userEmail);
    if (!user || !acct) {
      log.push(`[InsForge] No AD record found for ${userEmail}`);
      return { ok: false, log };
    }
    const groups = await listADGroups();
    const userGroups = groups.filter((g) => g.members.includes(userEmail)).map((g) => g.id);
    log.push(`[InsForge] ${user.name} (${user.title}, ${user.team})`);
    log.push(`[InsForge] Account status: ${acct.status} · failed logins: ${acct.failedLoginCount}`);
    log.push(`[InsForge] Groups: ${userGroups.join(", ")}`);
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
    log.push(`[InsForge] Unlock requires verified identity (verified earlier in plan)`);
    await sleep(350);
    const acct = await getADAccount(userEmail);
    if (!acct) {
      log.push(`[InsForge] No AD account found for ${userEmail}`);
      return { ok: false, log };
    }
    if (acct.status !== "locked") {
      log.push(`[InsForge] Account status is ${acct.status}; nothing to unlock. Idempotent OK.`);
      return { ok: true, log };
    }
    await updateADAccount(userEmail, {
      status: "active",
      failedLoginCount: 0,
      lockedAt: undefined,
    });
    log.push(`[InsForge] Account unlocked. Failed login counter reset to 0.`);
    return { ok: true, log };
  }

  if (step.capability === "ad.reset_password") {
    log.push(`[InsForge] Issuing AD password reset (forces change at next logon)`);
    await sleep(400);
    const acct = await getADAccount(userEmail);
    if (!acct) return { ok: false, log: [...log, "[InsForge] No AD account found"] };
    const now = Date.now();
    await updateADAccount(userEmail, {
      status: "active",
      failedLoginCount: 0,
      lockedAt: undefined,
      passwordChangedAt: now,
      passwordExpiresAt: now + 90 * 24 * 60 * 60 * 1000,
    });
    log.push(`[InsForge] Reset complete. Temporary credential email dispatched via Aside.`);
    return { ok: true, log };
  }

  if (step.capability === "ad.refresh_kerberos") {
    log.push(`[InsForge] Triggering MDM-side klist purge + krenew via management agent`);
    await sleep(450);
    const acct = await getADAccount(userEmail);
    if (acct) {
      await updateADAccount(userEmail, {
        status: acct.status === "stale_kerberos" ? "active" : acct.status,
        kerberosTicketAt: Date.now(),
      });
    }
    log.push(`[InsForge] New Kerberos TGT issued. Mapped drives & intranet should reauth automatically.`);
    return { ok: true, log };
  }

  log.push(`[InsForge] Generic capability completed`);
  return { ok: true, log };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
