import { db } from "./db";
import { Runbook } from "./types";

let seeded = false;

const SEED_RUNBOOKS: Omit<Runbook, "createdAt" | "updatedAt">[] = [
  {
    id: "rb-figma-sso",
    title: "Figma access lost after team change (SSO group drift)",
    tags: ["figma", "sso", "okta", "access"],
    body: "Symptom: User can't open Figma after switching teams. Root cause: Okta group membership for figma-designers was stripped during the team-change automation. Resolution: re-add the user to figma-designers in Okta. Verify via okta.list_groups, then okta.add_to_group. Confirm with user in Slack.",
    sourceTicketIds: [],
    successCount: 4,
    failureCount: 0,
  },
  {
    id: "rb-vpn-slow",
    title: "VPN slow / dropping connections (stale config)",
    tags: ["vpn", "network", "mdm"],
    body: "Symptom: VPN performance degraded; intermittent drops. Common cause: client config still references the decommissioned us-west-1 gateway. Resolution: run a sandboxed network probe to confirm MTU mismatch, then push refreshed VPN profile via MDM (mdm.push_vpn_config). Ask user to reconnect.",
    sourceTicketIds: [],
    successCount: 2,
    failureCount: 0,
  },
  {
    id: "rb-password-reset",
    title: "Password reset (verified user)",
    tags: ["password", "reset", "okta", "identity"],
    body: "Symptom: User locked out or forgot password. Resolution: verify identity via Hyperspell context (recent activity match), then trigger Okta password reset in the user's authenticated browser via Aside. Reset email is dispatched by Okta. Notify user via Slack.",
    sourceTicketIds: [],
    successCount: 7,
    failureCount: 1,
  },
  {
    id: "rb-laptop-onboard",
    title: "New hire laptop onboarding (Day 0)",
    tags: ["laptop", "onboarding", "mdm", "new hire"],
    body: "On a new hire's first day, MDM enrollment + initial app provisioning. Push baseline profile, enroll device, install Slack/Notion/Google Workspace, add to default Okta groups. If the user is engineering, also add to github-org and add an SSH key request to their first PR.",
    sourceTicketIds: [],
    successCount: 1,
    failureCount: 0,
  },
];

export function ensureSeeded() {
  if (seeded) return;
  if (db.listRunbooks().length === 0) {
    const now = Date.now();
    for (const r of SEED_RUNBOOKS) {
      db.insertRunbook({ ...r, createdAt: now, updatedAt: now });
    }
  }
  seeded = true;
}
