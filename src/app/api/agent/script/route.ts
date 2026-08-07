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
 * Inline the agent's one local dependency so the served file stands alone.
 *
 * `local-agent.mjs` does `import { redactDeep, redactSecrets } from "./redact.mjs"`.
 * The self-updater on the VM (run-agent.ps1) pulls exactly one file from this
 * endpoint, so a bare relative import would leave `node local-agent.mjs`
 * crashing with ERR_MODULE_NOT_FOUND the instant the machine updated. Rather
 * than ship two files and change the pull, the endpoint bundles: the import line
 * is replaced with redact.mjs's own body, exports stripped. The source stays
 * split — the agent and the server share one pattern list, pinned by
 * redact.test.ts — but what goes over the wire is self-contained, exactly as it
 * was before redaction was factored out.
 *
 * redact.mjs has no imports of its own (asserted below by construction — a
 * remaining `import` would surface in the served file and fail on the VM), so a
 * single inlining pass is enough.
 */
const REDACT_IMPORT = /^import\s*\{[^}]*\}\s*from\s*["']\.\/redact\.mjs["'];?\s*$/m;

export async function bundleAgentScript(): Promise<string> {
  const dir = path.join(process.cwd(), "scripts");
  const agent = await readFile(path.join(dir, "local-agent.mjs"), "utf8");

  if (!REDACT_IMPORT.test(agent)) {
    // No local dependency to inline (or it was renamed). Serve as-is rather than
    // guess — a future refactor should not silently ship a broken bundle.
    return agent;
  }

  const redact = await readFile(path.join(dir, "redact.mjs"), "utf8");
  const inlined = redact.replace(/^export\s+/gm, "");
  const block = `// --- inlined from scripts/redact.mjs at serve time (see api/agent/script) ---\n${inlined}\n// --- end inlined redact.mjs ---`;
  return agent.replace(REDACT_IMPORT, block);
}

/**
 * Serves the local agent so a machine can pull the current version instead of
 * having the file copied in by hand after every edit.
 *
 * This is deliberately not the deleted `public/setup.ps1`: that was served
 * unauthenticated with the shared token baked into the file body.
 */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const source = await bundleAgentScript();
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
