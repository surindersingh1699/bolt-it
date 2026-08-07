/**
 * Bundling the agent, and giving each build an identity.
 *
 * Two jobs, one place:
 *
 *  1. Inline the agent's one local dependency (`./redact.mjs`) so the file the
 *     VM pulls stands alone — the self-updater fetches exactly one file, and a
 *     bare relative import would crash `node local-agent.mjs` with
 *     ERR_MODULE_NOT_FOUND. See the redact.test.ts drift guard.
 *
 *  2. Stamp the served file with a content hash — its BUILD ID. This is what
 *     makes auto-update possible: the running agent knows exactly which build it
 *     is, the poll response carries the current build, and an agent whose build
 *     no longer matches steps aside so the supervisor pulls the new one. It
 *     replaces the useless static `AGENT_VERSION = "0.6.0"`, which never changed
 *     and so could never tell two builds apart — which is precisely how a VM sat
 *     on a months-old agent without anyone seeing it.
 *
 * The hash is computed over the bundle BEFORE the id is injected, so it is
 * deterministic: the same source always yields the same id, and the id a running
 * agent reports is the id the server will compute for that same source.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const REDACT_IMPORT = /^import\s*\{[^}]*\}\s*from\s*["']\.\/redact\.mjs["'];?\s*$/m;

// The placeholder the agent ships with. Replaced with the real hash at serve
// time; left as "dev" when the file is run straight from disk (`pnpm agent`),
// where there is no server to update against and self-exit must never fire.
const BUILD_LINE = /^const AGENT_BUILD = "[^"]*";$/m;
export const DEV_BUILD = "dev";

/**
 * The agent source with its one local import inlined, but NOT yet stamped with a
 * build id. This is the canonical content the build id is a hash of.
 */
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

export function computeBuildId(bundle: string): string {
  return createHash("sha256").update(bundle).digest("hex").slice(0, 12);
}

/**
 * The bytes served to a machine, stamped so the running agent knows its own
 * build. If the agent has no `AGENT_BUILD` line to replace, the bundle is served
 * unstamped and the id still returned — the agent simply cannot self-check,
 * which is the pre-auto-update behaviour and safe.
 */
export async function servedAgentScript(): Promise<{ source: string; buildId: string }> {
  const bundle = await bundleAgentScript();
  const buildId = computeBuildId(bundle);
  const source = bundle.replace(BUILD_LINE, `const AGENT_BUILD = "${buildId}";`);
  return { source, buildId };
}

// The build id changes only when the source does, so recomputing it on every
// poll (every ~3s, per agent) is wasteful. Cache it briefly; a deploy is picked
// up within the TTL plus one poll interval, which is plenty fast for "the fleet
// converges on the new build in seconds".
let cache: { id: string; at: number } | null = null;
const BUILD_TTL_MS = 15_000;

export async function agentBuildId(): Promise<string | null> {
  if (cache && Date.now() - cache.at < BUILD_TTL_MS) return cache.id;
  try {
    const bundle = await bundleAgentScript();
    const id = computeBuildId(bundle);
    cache = { id, at: Date.now() };
    return id;
  } catch {
    // Never fail a poll because the build id could not be computed; the agent
    // just doesn't self-check that cycle.
    return null;
  }
}
