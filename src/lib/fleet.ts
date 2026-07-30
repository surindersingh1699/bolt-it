import { ADAccount, Device } from "./types";
import { AgentHeartbeat } from "./agent-heartbeat";

export type HealthTier = "healthy" | "attention" | "critical" | "unknown";

const STALE_DEVICE_DAYS = 14;

export function userHealth(account: ADAccount | undefined): HealthTier {
  if (!account) return "unknown";
  if (account.status === "active") return "healthy";
  if (account.status === "disabled") return "critical";
  return "attention"; // locked | password_expired | stale_kerberos
}

export function deviceHealth(
  device: Device,
  ownerAccount: ADAccount | undefined,
  isLiveNow: boolean,
): HealthTier {
  if (isLiveNow) return "healthy";
  if (ownerAccount && userHealth(ownerAccount) !== "healthy") return "attention";
  const staleDays = (Date.now() - device.lastSeenAt) / (24 * 60 * 60 * 1000);
  if (staleDays > STALE_DEVICE_DAYS) return "attention";
  return "unknown";
}

export function inferOsFromHostname(hostname: string): string {
  return /win/i.test(hostname) ? "Windows" : "macOS";
}

export interface UserView {
  email: string;
  name: string;
  team: string;
  title: string;
  manager?: string;
  groups: string[];
  isITStaff: boolean;
  accountStatus: ADAccount["status"] | null;
  lastLoginAt?: number;
  health: HealthTier;
}

export interface DeviceView {
  id: string;
  hostname: string;
  os: string;
  ownerEmail?: string;
  ownerName?: string;
  source: Device["source"];
  firstSeenAt: number;
  lastSeenAt: number;
  claimedAt?: number;
  claimedBy?: string;
  isLiveNow: boolean;
  health: HealthTier;
}

export interface UnclaimedDevice {
  hostname: string;
  os: string;
  lastPingAt: number;
}

export interface FleetView {
  users: UserView[];
  devices: DeviceView[];
  unclaimedDevice: UnclaimedDevice | null;
}

interface BuildFleetViewInput {
  users: Array<{
    email: string;
    name: string;
    team: string;
    title: string;
    manager?: string;
    groups: string[];
    isITStaff: boolean;
  }>;
  accounts: ADAccount[];
  devices: Device[];
  heartbeat: AgentHeartbeat | null;
  heartbeatConnected: boolean;
}

export function buildFleetView(input: BuildFleetViewInput): FleetView {
  const accountByEmail = new Map(input.accounts.map((a) => [a.email, a]));
  const nameByEmail = new Map(input.users.map((u) => [u.email, u.name]));

  const users: UserView[] = input.users.map((u) => {
    const account = accountByEmail.get(u.email);
    return {
      email: u.email,
      name: u.name,
      team: u.team,
      title: u.title,
      manager: u.manager,
      groups: u.groups,
      isITStaff: u.isITStaff,
      accountStatus: account?.status ?? null,
      lastLoginAt: account?.lastLoginAt,
      health: userHealth(account),
    };
  });

  const liveHostname = input.heartbeatConnected ? input.heartbeat?.hostname.toLowerCase() : undefined;

  const devices: DeviceView[] = input.devices.map((d) => {
    const isLiveNow = liveHostname !== undefined && d.hostname.toLowerCase() === liveHostname;
    const ownerAccount = d.ownerEmail ? accountByEmail.get(d.ownerEmail) : undefined;
    return {
      id: d.id,
      hostname: d.hostname,
      os: d.os,
      ownerEmail: d.ownerEmail,
      ownerName: d.ownerEmail ? nameByEmail.get(d.ownerEmail) : undefined,
      source: d.source,
      firstSeenAt: d.firstSeenAt,
      lastSeenAt: isLiveNow ? (input.heartbeat?.lastPingAt ?? d.lastSeenAt) : d.lastSeenAt,
      claimedAt: d.claimedAt,
      claimedBy: d.claimedBy,
      isLiveNow,
      health: deviceHealth(d, ownerAccount, isLiveNow),
    };
  });

  let unclaimedDevice: UnclaimedDevice | null = null;
  if (input.heartbeatConnected && input.heartbeat && liveHostname) {
    const known = input.devices.some((d) => d.hostname.toLowerCase() === liveHostname);
    if (!known) {
      unclaimedDevice = {
        hostname: input.heartbeat.hostname,
        os: input.heartbeat.os,
        lastPingAt: input.heartbeat.lastPingAt,
      };
    }
  }

  return { users, devices, unclaimedDevice };
}
