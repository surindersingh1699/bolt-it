import {
  insertADAccount,
  insertADGroup,
  insertADUser,
  insertRunbook,
  listADUsers,
  listRunbooks,
} from "./data";
import { ADAccount, ADGroup, ADUser, Runbook } from "./types";
import { hashPassword } from "./password";
import { ACME_WORKSPACE_ID, ensureWorkspace } from "./workspace";

let seeding: Promise<void> | null = null;

const SEED_RUNBOOKS: Omit<Runbook, "createdAt" | "updatedAt" | "workspaceId">[] = [
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
  {
    id: "rb-ad-account-locked",
    title: "AD account locked after failed logins",
    tags: ["ad", "lockout", "password", "identity"],
    body: "Symptom: User cannot sign in; AD account shows status=locked after threshold of failed attempts. Resolution: verify identity via Hyperspell, inspect crash/auth logs in sandbox to confirm legitimate user, then call insforge ad.unlock_account capability. Notify user via Slack.",
    sourceTicketIds: [],
    successCount: 3,
    failureCount: 0,
  },
  {
    id: "rb-stale-kerberos",
    title: "Stale Kerberos ticket (Windows host won't auth)",
    tags: ["kerberos", "ad", "windows"],
    body: "Symptom: User logged in but mapped drives + intranet sites prompt for credentials. Cause: Kerberos TGT expired; clock skew or hibernated laptop. Resolution: read auth/system event logs in a read-only sandbox, then push klist purge + krenew via MDM. Confirm with user.",
    sourceTicketIds: [],
    successCount: 1,
    failureCount: 0,
  },
];

interface RawUser {
  email: string;
  name: string;
  password: string;
  team: string;
  title: string;
  manager?: string;
  groups: string[];
  isITStaff?: boolean;
  account: Pick<ADAccount, "status" | "failedLoginCount"> & {
    lockedDaysAgo?: number;
    passwordChangedDaysAgo: number;
    passwordExpiresInDays: number;
    lastLoginHoursAgo?: number;
    lastLoginHost?: string;
    kerberosTicketHoursAgo?: number;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const RAW_USERS: RawUser[] = [
  {
    email: "alice@acme.test",
    name: "Alice Nguyen",
    password: "demo-pass-1",
    team: "Design",
    title: "Senior Product Designer",
    manager: "priya@acme.test",
    groups: ["everyone", "designers", "figma-designers"],
    account: {
      status: "active",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 12,
      passwordExpiresInDays: 78,
      lastLoginHoursAgo: 3,
      lastLoginHost: "ALICE-MBP-2024",
    },
  },
  {
    email: "bob@acme.test",
    name: "Bob Martinez",
    password: "demo-pass-2",
    team: "Sales",
    title: "Account Executive",
    manager: "carol@acme.test",
    groups: ["everyone", "sales", "salesforce-users"],
    account: {
      status: "locked",
      failedLoginCount: 5,
      lockedDaysAgo: 0,
      passwordChangedDaysAgo: 60,
      passwordExpiresInDays: 30,
      lastLoginHoursAgo: 26,
      lastLoginHost: "BOB-WIN-DT",
    },
  },
  {
    email: "carol@acme.test",
    name: "Carol Park",
    password: "demo-pass-3",
    team: "Sales",
    title: "Director of Sales",
    groups: ["everyone", "sales", "managers"],
    account: {
      status: "active",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 25,
      passwordExpiresInDays: 65,
      lastLoginHoursAgo: 1,
      lastLoginHost: "CAROL-MBA",
    },
  },
  {
    email: "dan@acme.test",
    name: "Dan O'Connor",
    password: "demo-pass-4",
    team: "Engineering",
    title: "Staff Engineer",
    groups: ["everyone", "engineering", "github-org", "vpn-users"],
    account: {
      status: "active",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 5,
      passwordExpiresInDays: 85,
      lastLoginHoursAgo: 2,
      lastLoginHost: "DAN-MBP",
      kerberosTicketHoursAgo: 11,
    },
  },
  {
    email: "eve@acme.test",
    name: "Eve Tanaka",
    password: "demo-pass-5",
    team: "Engineering",
    title: "Software Engineer",
    manager: "dan@acme.test",
    groups: ["everyone", "engineering", "vpn-users"],
    account: {
      status: "stale_kerberos",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 18,
      passwordExpiresInDays: 72,
      lastLoginHoursAgo: 19,
      lastLoginHost: "EVE-WIN",
      kerberosTicketHoursAgo: 25,
    },
  },
  {
    email: "frank@acme.test",
    name: "Frank Adebayo",
    password: "demo-pass-6",
    team: "Finance",
    title: "Controller",
    groups: ["everyone", "finance", "managers"],
    account: {
      status: "password_expired",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 92,
      passwordExpiresInDays: -2,
      lastLoginHoursAgo: 50,
      lastLoginHost: "FRANK-WIN",
    },
  },
  {
    email: "priya@acme.test",
    name: "Priya Shah",
    password: "demo-pass-7",
    team: "Design",
    title: "Head of Design",
    groups: ["everyone", "designers", "managers"],
    account: {
      status: "active",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 30,
      passwordExpiresInDays: 60,
      lastLoginHoursAgo: 5,
      lastLoginHost: "PRIYA-MBP",
    },
  },
  {
    email: "morgan@acme.test",
    name: "Morgan Reilly",
    password: "demo-pass-it",
    team: "IT",
    title: "IT Operations Lead",
    groups: ["everyone", "it-staff", "managers"],
    isITStaff: true,
    account: {
      status: "active",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 8,
      passwordExpiresInDays: 82,
      lastLoginHoursAgo: 0,
      lastLoginHost: "MORGAN-MBP",
    },
  },
  {
    email: "sam@acme.test",
    name: "Sam Iverson",
    password: "demo-pass-it2",
    team: "IT",
    title: "IT Support Engineer",
    manager: "morgan@acme.test",
    groups: ["everyone", "it-staff"],
    isITStaff: true,
    account: {
      status: "active",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 15,
      passwordExpiresInDays: 75,
      lastLoginHoursAgo: 0,
      lastLoginHost: "SAM-MBP",
    },
  },
];

const SEED_GROUPS: Omit<ADGroup, "members" | "workspaceId">[] = [
  { id: "everyone", name: "Everyone", description: "All employees" },
  { id: "designers", name: "Designers", description: "Design team" },
  { id: "figma-designers", name: "Figma Designers", description: "SSO group for Figma Org" },
  { id: "sales", name: "Sales", description: "Sales org" },
  { id: "salesforce-users", name: "Salesforce Users", description: "Salesforce SSO" },
  { id: "engineering", name: "Engineering", description: "Engineering team" },
  { id: "github-org", name: "GitHub Org", description: "GitHub org members" },
  { id: "vpn-users", name: "VPN Users", description: "Allowed to dial corp VPN" },
  { id: "finance", name: "Finance", description: "Finance team" },
  { id: "managers", name: "Managers", description: "People managers" },
  { id: "it-staff", name: "IT Staff", description: "IT operations & support — can approve agent plans" },
];

export async function ensureSeeded(): Promise<void> {
  if (seeding) return seeding;
  seeding = (async () => {
    await ensureWorkspace(ACME_WORKSPACE_ID, "Acme Corp", false);

    const existingRunbooks = await listRunbooks(ACME_WORKSPACE_ID);
    if (existingRunbooks.length === 0) {
      const now = Date.now();
      for (const r of SEED_RUNBOOKS) {
        await insertRunbook({ ...r, workspaceId: ACME_WORKSPACE_ID, createdAt: now, updatedAt: now });
      }
    }

    const existingUsers = await listADUsers(ACME_WORKSPACE_ID);
    if (existingUsers.length === 0) {
      const now = Date.now();
      const groupMembers = new Map<string, string[]>();
      for (const raw of RAW_USERS) {
        const user: ADUser = {
          email: raw.email,
          workspaceId: ACME_WORKSPACE_ID,
          name: raw.name,
          passwordHash: await hashPassword(raw.password),
          team: raw.team,
          title: raw.title,
          manager: raw.manager,
          groups: raw.groups,
          isITStaff: raw.isITStaff ?? false,
          createdAt: now,
        };
        await insertADUser(user);
        for (const g of raw.groups) {
          const list = groupMembers.get(g) ?? [];
          list.push(raw.email);
          groupMembers.set(g, list);
        }
        const account: ADAccount = {
          email: raw.email,
          workspaceId: ACME_WORKSPACE_ID,
          status: raw.account.status,
          failedLoginCount: raw.account.failedLoginCount,
          lockedAt:
            raw.account.lockedDaysAgo !== undefined
              ? now - raw.account.lockedDaysAgo * DAY
              : undefined,
          passwordChangedAt: now - raw.account.passwordChangedDaysAgo * DAY,
          passwordExpiresAt: now + raw.account.passwordExpiresInDays * DAY,
          lastLoginAt:
            raw.account.lastLoginHoursAgo !== undefined
              ? now - raw.account.lastLoginHoursAgo * HOUR
              : undefined,
          lastLoginHost: raw.account.lastLoginHost,
          kerberosTicketAt:
            raw.account.kerberosTicketHoursAgo !== undefined
              ? now - raw.account.kerberosTicketHoursAgo * HOUR
              : undefined,
        };
        await insertADAccount(account);
      }
      for (const g of SEED_GROUPS) {
        await insertADGroup({ ...g, workspaceId: ACME_WORKSPACE_ID, members: groupMembers.get(g.id) ?? [] });
      }
    }
  })();
  try {
    await seeding;
  } catch (err) {
    seeding = null;
    throw err;
  }
}
