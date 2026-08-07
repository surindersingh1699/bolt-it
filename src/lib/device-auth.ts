/**
 * Which machine is this, and may it have this job?
 *
 * Until now the answer to both was one shared bearer token. `GET
 * /api/agent/jobs` took an optional `workspaceId` query parameter that the
 * agent never sent, so it returned every queued job in every workspace, marked
 * them all claimed, and handed them over. `job.targetUserEmail` recorded whose
 * machine the work was FOR and nothing ever compared it to who was asking.
 *
 * The consequence is worth stating plainly, because it is the reason this file
 * exists: any machine holding LOCAL_AGENT_TOKEN would execute another
 * employee's job — read their files, restart their apps, change their DNS — and
 * the ticket would record it as having happened on the right machine.
 *
 * Now: one token per device, hashed at rest, and a job is only ever handed to
 * the device it names.
 *
 * The shared token still works behind ALLOW_SHARED_AGENT_TOKEN=1 so the
 * existing dev machine keeps running during the migration. It warns on every
 * poll, and it is the thing to delete once every real device is enrolled.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { getDeviceById, listDevices, updateDevice } from "./data";
import type { Device } from "./types";

const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

interface EnrollmentCode {
  code: string;
  workspaceId: string;
  ownerEmail: string;
  expiresAt: number;
  usedAt?: number;
}

// In memory, like the heartbeat and trace stores. A code is valid for fifteen
// minutes and exactly one machine, so losing them on restart costs an admin one
// click and cannot leave a stale credential behind.
declare global {
  // eslint-disable-next-line no-var
  var __BOLT_ENROLLMENT_CODES__: Map<string, EnrollmentCode> | undefined;
}
const codes: Map<string, EnrollmentCode> =
  globalThis.__BOLT_ENROLLMENT_CODES__ ?? new Map<string, EnrollmentCode>();
if (!globalThis.__BOLT_ENROLLMENT_CODES__) globalThis.__BOLT_ENROLLMENT_CODES__ = codes;

/** Mint a single-use enrollment code for one machine. */
export function createEnrollmentCode(workspaceId: string, ownerEmail: string): EnrollmentCode {
  for (const [k, v] of codes) if (v.expiresAt < Date.now()) codes.delete(k);
  const code = randomBytes(9).toString("base64url");
  const entry: EnrollmentCode = {
    code,
    workspaceId,
    ownerEmail: ownerEmail.toLowerCase(),
    expiresAt: Date.now() + ENROLLMENT_TTL_MS,
  };
  codes.set(code, entry);
  return entry;
}

export type EnrollResult =
  | { ok: true; deviceId: string; token: string }
  | { ok: false; reason: string };

/**
 * Trade a one-time code for a device token.
 *
 * The code is burned before the token is returned, so a replayed request gets
 * nothing even if the first response was intercepted.
 */
export async function enrollDevice(
  code: string,
  hostname: string,
  os: string,
): Promise<EnrollResult> {
  const entry = codes.get(code);
  if (!entry) return { ok: false, reason: "unknown enrollment code" };
  if (entry.usedAt) return { ok: false, reason: "enrollment code has already been used" };
  if (entry.expiresAt < Date.now()) {
    codes.delete(code);
    return { ok: false, reason: "enrollment code has expired" };
  }
  entry.usedAt = Date.now();

  const host = String(hostname || "").trim().slice(0, 253);
  if (!host) return { ok: false, reason: "hostname is required" };

  const devices = await listDevices(entry.workspaceId);
  const existing = devices.find((d) => d.hostname.toLowerCase() === host.toLowerCase());

  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const deviceId = existing?.id ?? `dev-${randomBytes(6).toString("hex")}`;

  await updateDevice(deviceId, {
    id: deviceId,
    workspaceId: entry.workspaceId,
    hostname: host,
    os: String(os || "").slice(0, 200),
    ownerEmail: entry.ownerEmail,
    source: existing?.source ?? "manual",
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    tokenHash: hashToken(token),
    enrolledAt: now,
    revokedAt: undefined,
  });

  return { ok: true, deviceId, token };
}

/**
 * Identify the caller from its Authorization header.
 *
 * Returns the device when a per-device token matches, `"shared"` when the
 * legacy shared token is presented AND explicitly permitted, and null
 * otherwise. Callers must treat `"shared"` as "no device identity" rather than
 * as a wildcard device.
 */
export async function authenticateAgent(
  req: Request,
): Promise<{ kind: "device"; device: Device } | { kind: "shared" } | null> {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return null;

  const presentedHash = hashToken(presented);
  const devices = await listDevices().catch(() => [] as Device[]);
  for (const d of devices) {
    if (!d.tokenHash || d.revokedAt) continue;
    if (hashesEqual(d.tokenHash, presentedHash)) return { kind: "device", device: d };
  }

  const shared = process.env.LOCAL_AGENT_TOKEN;
  if (shared && process.env.ALLOW_SHARED_AGENT_TOKEN === "1") {
    if (hashesEqual(hashToken(shared), presentedHash)) {
      console.warn(
        "[agent-auth] shared LOCAL_AGENT_TOKEN accepted — this identifies no device and " +
          "cannot route a job to the right machine. Enroll the device and unset " +
          "ALLOW_SHARED_AGENT_TOKEN.",
      );
      return { kind: "shared" };
    }
  }
  return null;
}

/** The device a ticket's work should run on, if there is one. */
export async function deviceForOwner(
  workspaceId: string,
  ownerEmail: string,
): Promise<Device | null> {
  const devices = await listDevices(workspaceId).catch(() => [] as Device[]);
  const owner = ownerEmail.toLowerCase();
  return devices.find((d) => !d.revokedAt && d.ownerEmail?.toLowerCase() === owner) ?? null;
}

export { getDeviceById };
