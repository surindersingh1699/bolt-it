import { describe, it, expect } from "vitest";
import { grantableBinaryFrom } from "./executors";

// The agent marks a refusal it would accept a grant for as GRANTABLE:<binary>:.
// Everything else is a refusal no approval can fix, and must stay a plain
// execution failure — otherwise every mistyped command would raise an approval
// prompt at a technician, which is how a gate gets clicked through by habit.
describe("grantable refusals", () => {
  it("recognises the agent's marker and pulls out the binary", () => {
    expect(grantableBinaryFrom('GRANTABLE:netsh:"netsh" is not enabled by default')).toBe("netsh");
    expect(grantableBinaryFrom("GRANTABLE:w32tm:needs approval")).toBe("w32tm");
  });

  it("does not treat an ordinary refusal as grantable", () => {
    expect(grantableBinaryFrom('"ping" is not on the read-only binary allowlist')).toBeNull();
    expect(grantableBinaryFrom("nslookup exited 1: server not found")).toBeNull();
    expect(grantableBinaryFrom(undefined)).toBeNull();
    expect(grantableBinaryFrom("")).toBeNull();
  });

  // The marker is only trusted at the very start of the error. A command whose
  // own output happens to contain the word would otherwise mint its own grant.
  it("only trusts the marker at the start of the message", () => {
    expect(grantableBinaryFrom("output was: GRANTABLE:netsh:something")).toBeNull();
    expect(grantableBinaryFrom(" GRANTABLE:netsh:leading space")).toBeNull();
  });

  it("refuses a binary name that is not allowlist-shaped", () => {
    expect(grantableBinaryFrom("GRANTABLE:rm -rf /:nope")).toBeNull();
    expect(grantableBinaryFrom("GRANTABLE::empty")).toBeNull();
  });
});
