/**
 * Redaction runs in two places — in the agent before upload, and on the server
 * after parsing. Two copies of a pattern list is the price of one side being
 * .mjs that ships to a laptop and the other being TypeScript that runs in the
 * app. Two copies that can DRIFT is not a price worth paying, so this asserts
 * they have not.
 */

import { describe, expect, it } from "vitest";
import { SECRET_PATTERNS, redactDeep, redactSecrets } from "./redact";
import { SECRET_PATTERNS as AGENT_PATTERNS, redactSecrets as agentRedact } from "../../scripts/redact.mjs";

describe("the two copies stay identical", () => {
  it("has the same number of patterns on both sides", () => {
    expect(SECRET_PATTERNS.length).toBe(AGENT_PATTERNS.length);
  });

  it("has the same pattern source and label, in the same order", () => {
    // Order matters as well as content: the generic `credential` rule is last on
    // purpose, so a more specific label wins when both would match.
    for (let i = 0; i < SECRET_PATTERNS.length; i++) {
      const [serverRe, serverLabel] = SECRET_PATTERNS[i];
      const [agentRe, agentLabel] = AGENT_PATTERNS[i];
      expect(serverLabel, `pattern ${i} label`).toBe(agentLabel);
      expect(serverRe.source, `pattern ${i} (${serverLabel}) source`).toBe(agentRe.source);
      expect(serverRe.flags, `pattern ${i} (${serverLabel}) flags`).toBe(agentRe.flags);
    }
  });

  it("produces byte-identical output on the same input", () => {
    const sample = [
      "AKIAIOSFODNN7EXAMPLE",
      "Authorization: Bearer abc.def.ghi",
      "postgres://admin:hunter2@db:5432/app",
      "api_key: zzzz1111",
      "Outlook.exe PID 4821",
    ].join("\n");
    expect(redactSecrets(sample)).toBe(agentRedact(sample));
  });
});

describe("redactDeep", () => {
  it("reaches every string in a nested structure", () => {
    // The point of doing this to the whole envelope rather than to chosen
    // fields: redaction used to cover two read paths out of ten because
    // somebody had to remember each one.
    const out = redactDeep({
      output: "AKIAIOSFODNN7EXAMPLE",
      envelope: {
        commands: [{ stdout: "token: ghp_abcdefghijklmnopqrstuvwxyz0123", exitCode: 0 }],
        probes: [{ facts: { resolver: "Authorization: Bearer xyz" } }],
      },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(text).toContain("[REDACTED:aws-key]");
    expect(text).toContain("[REDACTED:github-token]");
  });

  it("leaves non-strings alone", () => {
    expect(redactDeep({ exitCode: 0, ok: true, missing: null })).toEqual({
      exitCode: 0,
      ok: true,
      missing: null,
    });
  });

  it("does not recurse without bound", () => {
    const cyclic: Record<string, unknown> = { a: "AKIAIOSFODNN7EXAMPLE" };
    cyclic.self = cyclic;
    expect(() => redactDeep(cyclic)).not.toThrow();
  });
});
