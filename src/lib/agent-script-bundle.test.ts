/**
 * What the VM actually pulls has to stand alone, and has to be identifiable.
 *
 * The self-updater on the machine fetches ONE file from /api/agent/script and
 * runs `node local-agent.mjs`. Two things must hold:
 *
 *  - It must be self-contained. The agent's `import ... from "./redact.mjs"`
 *    would crash there with ERR_MODULE_NOT_FOUND, so the endpoint inlines it. If
 *    a future edit adds a second local import, or breaks the inlining, the file
 *    stops being self-contained and this fails here rather than in a crashloop
 *    on a locked-down Windows box nobody is watching.
 *  - It must carry a build id that changes when the source does, and that the
 *    server and the running agent agree on. That agreement is the whole
 *    auto-update mechanism.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  agentBuildId,
  bundleAgentScript,
  computeBuildId,
  servedAgentScript,
} from "./agent-bundle";

const tmp = mkdtempSync(path.join(tmpdir(), "agent-bundle-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the served agent bundle", () => {
  it("carries no local imports — only node builtins survive", async () => {
    const bundle = await bundleAgentScript();
    // A relative import is exactly what breaks on the VM. Node builtins
    // ("node:os" etc.) are fine; nothing with a leading ./ or ../ is.
    const localImports = bundle.match(/^import\b.*from\s*["']\.\.?\//gm) ?? [];
    expect(localImports, `un-inlined local imports: ${localImports.join(" | ")}`).toEqual([]);
    expect(bundle).not.toContain('from "./redact.mjs"');
  });

  it("actually inlined redact, rather than just deleting the import", async () => {
    const bundle = await bundleAgentScript();
    expect(bundle).toContain("inlined from scripts/redact.mjs");
    expect(bundle).toContain("function redactSecrets");
    expect(bundle).toContain("function redactDeep");
  });

  it("is a file node can load with nothing beside it — the VM condition", async () => {
    const { source } = await servedAgentScript();
    const file = path.join(tmp, "local-agent.mjs");
    writeFileSync(file, source);
    // node --check parses; a real import proves the inlined declarations
    // resolve. Neither needs redact.mjs to exist next to it, which is the point.
    execFileSync(process.execPath, ["--check", file]);
    const probe = path.join(tmp, "probe.mjs");
    writeFileSync(
      probe,
      `import * as m from "./local-agent.mjs"; if (!m.executeJob) { process.exit(3); }`,
    );
    execFileSync(process.execPath, [probe], { env: { ...process.env, LOCAL_AGENT_TOKEN: "x" } });
  });
});

describe("the build id", () => {
  it("is deterministic — the same source always hashes the same", async () => {
    const a = await bundleAgentScript();
    const b = await bundleAgentScript();
    expect(computeBuildId(a)).toBe(computeBuildId(b));
  });

  it("changes when the source changes", async () => {
    const base = await bundleAgentScript();
    expect(computeBuildId(base)).not.toBe(computeBuildId(base + "\n// a change\n"));
  });

  it("stamps the served file with the id the server reports for that source", async () => {
    // The load-bearing agreement: what the running agent reads as its own build
    // must equal what the poll response calls current, or it self-exits forever.
    const { source, buildId } = await servedAgentScript();
    expect(source).toContain(`const AGENT_BUILD = "${buildId}";`);
    expect(await agentBuildId()).toBe(buildId);
  });

  it("replaces the dev placeholder, so a served agent never thinks it is dev", async () => {
    const { source } = await servedAgentScript();
    expect(source).not.toContain('const AGENT_BUILD = "dev";');
  });
});
