/**
 * What the VM actually pulls has to stand alone.
 *
 * The self-updater on the machine fetches ONE file from /api/agent/script and
 * runs `node local-agent.mjs`. The agent's `import ... from "./redact.mjs"`
 * would crash there with ERR_MODULE_NOT_FOUND, so the endpoint inlines it. This
 * pins that: if a future edit adds a second local import, or breaks the
 * inlining, the served file stops being self-contained and this fails here
 * rather than in a crashloop on a locked-down Windows box nobody is watching.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { bundleAgentScript } from "../app/api/agent/script/route";

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
    const bundle = await bundleAgentScript();
    const file = path.join(tmp, "local-agent.mjs");
    writeFileSync(file, bundle);
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
