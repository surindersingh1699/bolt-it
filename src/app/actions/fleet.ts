"use server";

import { revalidatePath } from "next/cache";
import { insertDevice } from "@/lib/data";
import { requireITStaff } from "@/lib/auth";

export async function claimDevice(hostname: string, os: string, ownerEmail: string): Promise<void> {
  const requestingUser = await requireITStaff();
  const workspaceId = requestingUser.workspaceId;
  const now = Date.now();
  await insertDevice({
    id: `${workspaceId}:${hostname.toLowerCase()}`,
    workspaceId,
    hostname,
    os,
    ownerEmail,
    source: "heartbeat",
    firstSeenAt: now,
    lastSeenAt: now,
    claimedAt: now,
    claimedBy: requestingUser.email,
  });
  try {
    revalidatePath("/app");
  } catch {
    // revalidatePath throws if called during a render; the fleet tab polls anyway
  }
}
