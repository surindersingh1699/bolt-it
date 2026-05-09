import { NextResponse } from "next/server";
import { listAgentJobs, updateAgentJob } from "@/lib/data";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.LOCAL_AGENT_TOKEN;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
  const jobs = await listAgentJobs(workspaceId, "queued");
  const now = Date.now();
  for (const job of jobs) {
    await updateAgentJob(job.id, { status: "claimed", claimedAt: now });
  }
  return NextResponse.json({
    jobs: jobs.map((job) => ({
      ...job,
      status: "claimed",
      claimedAt: now,
    })),
  });
}
