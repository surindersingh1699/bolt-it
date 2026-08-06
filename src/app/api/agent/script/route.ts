import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

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
 * Serves scripts/local-agent.mjs so a machine can pull the current agent
 * instead of having the file copied in by hand after every edit.
 *
 * This is deliberately not the deleted `public/setup.ps1`: that was served
 * unauthenticated with the shared token baked into the file body.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const file = path.join(process.cwd(), "scripts", "local-agent.mjs");
    const source = await readFile(file, "utf8");
    return new NextResponse(source, {
      headers: {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("[agent/script] could not read local-agent.mjs:", (err as Error).message);
    return NextResponse.json({ error: "agent script unavailable" }, { status: 500 });
  }
}
