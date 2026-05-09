import { NextRequest, NextResponse } from "next/server";
import { deleteExpiredDemoWorkspaces } from "@/lib/data";

export const dynamic = "force-dynamic";

const DEFAULT_TTL_HOURS = 24;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

async function run(req: NextRequest): Promise<NextResponse> {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const ttlHours = Number(req.nextUrl.searchParams.get("ttlHours") ?? DEFAULT_TTL_HOURS);
  const olderThanMs = Math.max(1, ttlHours) * 60 * 60 * 1000;
  const deleted = await deleteExpiredDemoWorkspaces(olderThanMs);
  return NextResponse.json({ deletedCount: deleted.length, deleted, ttlHours });
}

export async function GET(req: NextRequest) {
  return run(req);
}

export async function POST(req: NextRequest) {
  return run(req);
}
