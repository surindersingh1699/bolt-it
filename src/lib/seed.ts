import {
  insertADAccount,
  insertADGroup,
  insertADUser,
  insertDevice,
  listADUsers,
  listDevices,
} from "./data";
import { ADAccount, ADGroup, ADUser } from "./types";
import { hashPassword } from "./password";
import { inferOsFromHostname } from "./fleet";
import { ACME_WORKSPACE_ID, ensureWorkspace } from "./workspace";

let seeding: Promise<void> | null = null;

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

// One real account, no cast of fictional colleagues. Devices are deliberately
// not seeded either: the only machine that should ever appear in the fleet is
// one a local agent actually connected from.
const RAW_USERS: RawUser[] = [
  {
    email: process.env.SEED_ADMIN_EMAIL ?? "sabysurinder@gmail.com",
    name: process.env.SEED_ADMIN_NAME ?? "Surinder Singh",
    password: process.env.SEED_ADMIN_PASSWORD ?? "bolt-it",
    team: "IT",
    title: "IT support",
    groups: ["everyone", "it-staff"],
    isITStaff: true,
    account: {
      status: "active",
      failedLoginCount: 0,
      passwordChangedDaysAgo: 0,
      passwordExpiresInDays: 365,
      lastLoginHoursAgo: 0,
    },
  },
];

const SEED_GROUPS: Omit<ADGroup, "members" | "workspaceId">[] = [
  { id: "everyone", name: "Everyone", description: "All employees" },
  { id: "it-staff", name: "IT Staff", description: "IT operations & support — can approve agent plans" },
];

export async function ensureSeeded(): Promise<void> {
  if (seeding) return seeding;
  seeding = (async () => {
    await ensureWorkspace(ACME_WORKSPACE_ID, "Acme Corp");

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

    // Devices are in-memory-only (see data.ts) and therefore always start
    // empty on a fresh process, even when ADUser/ADAccount data survives via
    // InsForge — so this is gated on devices existing, independent of the
    // user-seeding gate above, using RAW_USERS directly rather than whatever
    // users happened to already exist.
    const existingDevices = await listDevices(ACME_WORKSPACE_ID);
    if (existingDevices.length === 0) {
      const now = Date.now();
      for (const raw of RAW_USERS) {
        if (!raw.account.lastLoginHost) continue;
        const lastSeenAt =
          raw.account.lastLoginHoursAgo !== undefined ? now - raw.account.lastLoginHoursAgo * HOUR : now;
        await insertDevice({
          id: `${ACME_WORKSPACE_ID}:${raw.account.lastLoginHost.toLowerCase()}`,
          workspaceId: ACME_WORKSPACE_ID,
          hostname: raw.account.lastLoginHost,
          os: inferOsFromHostname(raw.account.lastLoginHost),
          ownerEmail: raw.email,
          source: "seed",
          firstSeenAt: lastSeenAt,
          lastSeenAt,
        });
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
