import { NextResponse } from "next/server";
import { claimAgentJob, listAgentJobs } from "@/lib/data";
import { authenticateAgent } from "@/lib/device-auth";
import { agentBuildId, DEV_BUILD } from "@/lib/agent-bundle";

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
/**
 * Which builds may be handed work.
 *
 * A device runs whatever `local-agent.mjs` someone left on it. Two agents on one
 * machine — the scheduled task on the current build, plus a copy started by hand
 * months ago — both authenticate with the same token, both poll, and the claim
 * is a race. The old one wins some jobs and answers `Command is not allowlisted`
 * for handlers it never had, so the same read succeeds and fails minutes apart
 * and the strategist burns its rounds theorising about an allowlist that is
 * fine. T-4935 is that ticket: `nslookup youtube.com` succeeded at step 10 and
 * the identical command failed at step 17.
 *
 * So identity is a precondition for work, not a diagnostic afterthought:
 *
 *  - `dev` — a hand-run copy of the current source (`pnpm agent`). Allowed: it
 *    is the developer's own machine and there is no build to converge on.
 *  - the current build id — allowed.
 *  - any other id — refused; it self-exits and the supervisor pulls the current
 *    bundle.
 *  - no id at all — refused. A build that predates this header predates the
 *    proof envelope and most of the handler table.
 *
 * Refusing is a 200 with `staleBuild`, not an error: the jobs stay queued for
 * the agent that can actually run them, which is the whole point.
 */
function buildVerdict(
  claimed: string | null,
  current: string | null,
): { ok: true } | { ok: false; reason: string } {
  if (!claimed) {
    return {
      ok: false,
      reason:
        "this agent does not report its build — it predates the proof protocol and is missing device handlers. " +
        "Stop it and let the scheduled task's agent run.",
    };
  }
  if (claimed === DEV_BUILD) return { ok: true };
  if (!current || claimed === current) return { ok: true };
  return { ok: false, reason: `this agent is build ${claimed}; the server is serving ${current}` };
}

export async function GET(req: Request) {
  const auth = await authenticateAgent(req);
  if (!auth) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // The current build, on the response the agent already polls for. An agent
  // whose own build differs from this steps aside so the supervisor pulls the
  // new one — this is the whole auto-update signal, and it costs no extra
  // request. See scripts/local-agent.mjs (poll) and agent-bundle.ts.
  const agentBuild = await agentBuildId();

  const verdict = buildVerdict(req.headers.get("x-agent-build"), agentBuild);
  if (!verdict.ok) {
    return NextResponse.json({ jobs: [], agentBuild, staleBuild: true, reason: verdict.reason });
  }

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
    return NextResponse.json({
      jobs: claimed,
      agentBuild,
      warning: "shared-token mode: jobs are not device-routed",
    });
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

  return NextResponse.json({ jobs: claimed, agentBuild, deviceId: device.id, hostname: device.hostname });
}
