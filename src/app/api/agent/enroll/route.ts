import { NextResponse } from "next/server";
import { z } from "zod";
import { createEnrollmentCode, enrollDevice } from "@/lib/device-auth";
import { getCurrentSession, requireITStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

const enrollSchema = z.object({
  code: z.string().min(1).max(128),
  hostname: z.string().min(1).max(253),
  os: z.string().max(200).default(""),
});

const mintSchema = z.object({
  ownerEmail: z.string().email().max(254),
});

/**
 * Trade a one-time enrollment code for a device token.
 *
 * Deliberately unauthenticated in the bearer sense — the machine has no
 * credential yet, which is the entire point of enrolling. The code IS the
 * credential: single-use, fifteen-minute TTL, minted by a signed-in admin for
 * one named employee, and burned before the token is returned so a replayed
 * request gets nothing.
 *
 * The token is shown exactly once. Only its SHA-256 is stored, so a leak of the
 * device table is not a leak of every agent's credential.
 */
export async function POST(req: Request) {
  const raw = await req.json().catch(() => ({}));
  const parsed = enrollSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const result = await enrollDevice(parsed.data.code, parsed.data.hostname, parsed.data.os);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 403 });

  return NextResponse.json({
    deviceId: result.deviceId,
    token: result.token,
    note: "Store this in the agent's config. It is not recoverable — re-enroll to replace it.",
  });
}

/**
 * Mint an enrollment code. Signed-in IT staff only: this is the authority to
 * add a machine to the fleet, so it is not something a device may do for itself.
 */
export async function PUT(req: Request) {
  const session = await getCurrentSession().catch(() => null);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // requireITStaff throws. Left uncaught it becomes a 500 with an empty body,
  // which tells the caller nothing about why they were refused.
  try {
    await requireITStaff();
  } catch {
    return NextResponse.json(
      { error: "only IT staff can add a machine to the fleet" },
      { status: 403 },
    );
  }

  const parsed = mintSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const entry = createEnrollmentCode(session.workspaceId, parsed.data.ownerEmail);
  return NextResponse.json({
    code: entry.code,
    expiresAt: entry.expiresAt,
    ownerEmail: entry.ownerEmail,
  });
}
