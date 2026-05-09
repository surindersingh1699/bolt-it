import { NextResponse } from "next/server";
import { getAgentJob, updateAgentJob, updateStep } from "@/lib/data";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.LOCAL_AGENT_TOKEN;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

interface Params {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: Params) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    ok?: boolean;
    output?: string;
    error?: string;
    agentHost?: string;
    agentOs?: string;
  };
  const job = await getAgentJob(id);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const status = body.ok === false ? "failed" : "succeeded";
  const completedAt = Date.now();
  const output = String(body.output ?? "").slice(0, 8000);
  const error = body.error ? String(body.error).slice(0, 2000) : undefined;
  const agentHost = body.agentHost ? String(body.agentHost).slice(0, 200) : undefined;
  const agentOs = body.agentOs ? String(body.agentOs).slice(0, 200) : undefined;
  await updateAgentJob(id, { status, completedAt, output, error });

  if (job.stepId) {
    await updateStep(job.ticketId, job.stepId, {
      log: [
        ...(agentHost && agentOs ? [`[Local Agent] Job ran on ${agentHost} (${agentOs})`] : []),
        `[Local Agent] ${status}: ${id}`,
        `[Local Agent] Command: ${job.allowlistedCommand}`,
        ...(output ? output.split(/\r?\n/).slice(0, 16).map((line) => `[Local Agent] ${line}`) : []),
        ...(error ? [`[Local Agent] Error: ${error}`] : []),
      ],
    });
  }

  return NextResponse.json({ ok: true, id, status });
}
