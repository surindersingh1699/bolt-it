import { NextResponse } from "next/server";
import { servedAgentScript } from "@/lib/agent-bundle";

export const dynamic = "force-dynamic";

// Same bearer check as every other /api/agent/* route. The script itself holds
// no secret — the token lives in the machine's own environment — but gating it
// keeps the agent's command surface off the open internet, and the VM already
// has the token it needs to ask.
function authorized(req: Request): boolean {
  const expected = process.env.LOCAL_AGENT_TOKEN;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

/**
 * Serves the local agent so a machine can pull the current version instead of
 * having the file copied in by hand after every edit.
 *
 * The served file is bundled (its one local import inlined) and stamped with a
 * build id, so the running agent knows which build it is and can step aside for
 * a newer one — see agent-bundle.ts. The id also rides an `X-Agent-Build`
 * header, so the supervisor can log which build it just pulled.
 *
 * This is deliberately not the deleted `public/setup.ps1`: that was served
 * unauthenticated with the shared token baked into the file body.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const { source, buildId } = await servedAgentScript();
    return new NextResponse(source, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "x-agent-build": buildId,
      },
    });
  } catch (err) {
    console.error("[agent/script] could not read local-agent.mjs:", (err as Error).message);
    return NextResponse.json({ error: "agent script unavailable" }, { status: 500 });
  }
}
