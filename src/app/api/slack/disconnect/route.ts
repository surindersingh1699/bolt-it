import { NextRequest, NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/workspace";
import { disconnectSlackOnWorkspace } from "@/lib/data";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "no_workspace" }, { status: 401 });
  await disconnectSlackOnWorkspace(workspaceId);
  return NextResponse.redirect(new URL("/app?slack=disconnected", req.url));
}
