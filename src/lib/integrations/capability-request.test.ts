import { describe, expect, it } from "vitest";
import { parseCapabilityRequest } from "./ai-gateway";

// A capability request is the spec a human needs to add a handler. It is only
// useful if it names both the action and how anyone would verify the action
// landed — a fix whose effect cannot be observed can never support "resolved".
describe("parseCapabilityRequest", () => {
  it("parses a complete request", () => {
    const r = parseCapabilityRequest({
      name: "fix.reset_network_config",
      kind: "device",
      why: "would resolve the stale-resolver hypothesis",
      command: "networksetup -setdnsservers Wi-Fi empty",
      probe_fields: ["dns_resolvers", "ipv4"],
      expects_change: true,
      reversible: "re-apply the previous resolver list",
    });
    expect(r).not.toBeNull();
    expect(r?.name).toBe("fix.reset_network_config");
    expect(r?.probeFields).toEqual(["dns_resolvers", "ipv4"]);
    expect(r?.expectsChange).toBe(true);
  });

  it("rejects a request with nothing actionable in it", () => {
    expect(parseCapabilityRequest(null)).toBeNull();
    expect(parseCapabilityRequest("fix everything")).toBeNull();
    expect(parseCapabilityRequest({})).toBeNull();
    // A name with no command tells a technician nothing they could implement.
    expect(parseCapabilityRequest({ name: "fix.something" })).toBeNull();
    // A command with no name cannot be registered or referred to.
    expect(parseCapabilityRequest({ command: "rm -rf /" })).toBeNull();
  });

  it("defaults expects_change to true so an unstated write is not treated as a read", () => {
    const r = parseCapabilityRequest({ name: "fix.x", command: "do_x" });
    expect(r?.expectsChange).toBe(true);
  });

  it("keeps a request that omits its probe fields, but records the omission", () => {
    // Still worth surfacing to a human — they can supply the probe. It just
    // cannot be auto-registered, which is what the empty array signals.
    const r = parseCapabilityRequest({ name: "fix.x", command: "do_x" });
    expect(r?.probeFields).toEqual([]);
  });

  it("bounds untrusted strings", () => {
    const r = parseCapabilityRequest({
      name: "n".repeat(500),
      command: "c".repeat(900),
      why: "w".repeat(900),
    });
    expect(r?.name.length).toBeLessThanOrEqual(80);
    expect(r?.command.length).toBeLessThanOrEqual(300);
    expect(r?.why.length).toBeLessThanOrEqual(300);
  });
});
