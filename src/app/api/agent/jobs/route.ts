import { NextResponse } from "next/server";
import { claimAgentJob, listAgentJobs } from "@/lib/data";
import { authenticateAgent } from "@/lib/device-auth";

export const dynamic = "force-dynamic";

/**
 * Hand a device its own queued work, and nothing else.
 *
 * What this used to do: read an optional `workspaceId` query parameter that the
 * agent never sent, list EVERY queued job in EVERY workspace, mark them all
 * claimed in a non-atomic loop, and return the lot. `job.targetUserEmail`
 * recorded whose machine the work was for and nothing compared it to the caller.
 * Any machine with the shared token executed other employees' jobs.
 *
 * Three things changed, and all three are needed:
 *   1. The caller is identified as a specific device, by its own token.
 *   2. A job is only returned to the device it names.
 *   3. The claim is a compare-and-swap, so two agents cannot both win one job.
 */
export async function GET(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  if (auth.kind === "shared") {
    // The legacy shared token identifies no machine, so it cannot be routed to.
    // It is allowed to drain jobs that were never bound to a device — which is
    // what keeps an un-enrolled dev machine working — and nothing else.
    const queued = await listAgentJobs(undefined, "queued");
    const claimed = [];
    for (const job of queued.filter((j) => !j.deviceId)) {
      const won = await claimAgentJob(job.id);
      if (won) claimed.push(won);
    }
    return NextResponse.json({ jobs: claimed, warning: "shared-token mode: jobs are not device-routed" });
  }

  const device = auth.device;
  const queued = await listAgentJobs(device.workspaceId, "queued");
  const claimed = [];
  for (const job of queued) {
    // Belt and braces with the check inside claimAgentJob: filtering here keeps
    // another device's job from even being looked at, and the CAS keeps it from
    // being taken if this filter is ever loosened.
    if (job.deviceId && job.deviceId !== device.id) continue;
    const won = await claimAgentJob(job.id, device.id);
    if (won) claimed.push(won);
  }

  return NextResponse.json({ jobs: claimed, deviceId: device.id, hostname: device.hostname });
}
