import { NextResponse } from "next/server";
import { ensureSeeded } from "@/lib/seed";
import { getOrMintDemoWorkspaceId } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  await ensureSeeded();
  await getOrMintDemoWorkspaceId();
  const url = new URL("/demo", req.url);
  return NextResponse.redirect(url);
}
