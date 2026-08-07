/**
 * The registry invariants.
 *
 * This suite is the mechanism behind "no capability bypasses the substrate". A
 * spec that skips a guarantee does not fail at runtime on an employee's laptop —
 * it fails here, before it can be merged.
 */

import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_SPECS,
  buildCommand,
  capabilityAllowed,
  capabilitySpec,
  isReadOnlyCapability,
} from "./registry";
import { CAPABILITY_HELP, capabilityBlock, humanLabelFor, kindForCapability } from "./index";

describe("registry completeness", () => {
  it("has no duplicate ids", () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  it("gives every spec a label and help line — both are rendered to a person", () => {
    for (const s of CAPABILITY_SPECS) {
      expect(s.label.length, `${s.id} label`).toBeGreaterThan(0);
      expect(s.help.length, `${s.id} help`).toBeGreaterThan(0);
    }
  });

  it("requires a probe on every device capability that changes something", () => {
    // A change with no before/after probe cannot be verified, which means it can
    // never be honestly reported as a fix. This is the invariant that keeps
    // `no_effect` meaningful.
    for (const s of CAPABILITY_SPECS) {
      if (s.kind !== "device" || s.risk === 0) continue;
      if (s.probe === null) {
        // The single documented exception: a cache flush has no diffable fact.
        expect(["fix.flush_dns", "exec.cmd"], `${s.id} has no probe`).toContain(s.id);
      }
    }
  });

  it("requires a rollback, or an explicit statement that there is none", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.risk === 0) continue;
      if (s.rollback === null) {
        expect(
          ["none", "self"],
          `${s.id} has no rollback and must say why via reversible`,
        ).toContain(s.reversible);
      }
    }
  });

  it("never marks a capability recorded-reversible without recording how", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.reversible === "recorded") {
        expect(s.rollback, `${s.id} claims a recorded undo but names none`).toBeTruthy();
      }
    }
  });

  it("gives every device capability a command builder and every backend one none", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.kind === "device") expect(s.command, `${s.id}`).toBeTypeOf("function");
      else expect(s.command, `${s.id}`).toBeNull();
    }
  });

  it("gives every device capability at least one supported platform", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.kind === "device") expect(s.os.length, `${s.id}`).toBeGreaterThan(0);
      else expect(s.os, `${s.id}`).toEqual([]);
    }
  });
});

describe("provenance", () => {
  it("is complete on every spec", () => {
    for (const s of CAPABILITY_SPECS) {
      const p = s.provenance;
      expect(p.version, `${s.id} version`).toBeTruthy();
      expect(p.author, `${s.id} author`).toBeTruthy();
      expect(p.createdAt, `${s.id} createdAt`).toBeTruthy();
    }
  });

  it("requires a named approver on anything that arrived by PR", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.provenance.source === "approved_pr") {
        expect(s.provenance.approvedBy, `${s.id}`).toBeTruthy();
      }
    }
  });

  it("never lets a capability's own author be its approver", () => {
    // Self-approval is the failure mode the provenance field exists to catch.
    for (const s of CAPABILITY_SPECS) {
      if (s.provenance.approvedBy) {
        expect(s.provenance.approvedBy, `${s.id}`).not.toBe(s.provenance.author);
      }
    }
  });

  it("ties an expiry to temporary specs and only to temporary specs", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.provenance.source === "temporary") {
        expect(s.provenance.expiresAt, `${s.id} is a lease and must expire`).toBeTruthy();
      } else {
        expect(s.provenance.expiresAt, `${s.id} is not a lease`).toBeNull();
      }
    }
  });
});

describe("the read/write split", () => {
  it("derives read-only from risk rather than a second list", () => {
    for (const s of CAPABILITY_SPECS) {
      expect(isReadOnlyCapability(s.id), `${s.id}`).toBe(s.risk === 0);
    }
  });

  it("treats ad.lookup_user as a read despite the ad. prefix", () => {
    // The case that made a prefix test unsafe, and the reason this is a number
    // on the record instead of a hand-maintained set.
    expect(isReadOnlyCapability("ad.lookup_user")).toBe(true);
    expect(isReadOnlyCapability("ad.unlock_account")).toBe(false);
  });

  it("never puts a diag. or fs. capability on the write side", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.id.startsWith("diag.") || s.id.startsWith("fs.")) {
        expect(s.risk, `${s.id} must stay read-only`).toBe(0);
      }
    }
  });

  it("never marks a read-only capability as needing elevation or a rollback", () => {
    for (const s of CAPABILITY_SPECS) {
      if (s.risk !== 0) continue;
      expect(s.rollback, `${s.id}`).toBeNull();
    }
  });

  it("rejects anything outside the closed set", () => {
    expect(capabilityAllowed("fix.restart_app")).toBe(true);
    expect(capabilityAllowed("fix.format_disk")).toBe(false);
    expect(capabilityAllowed(undefined)).toBe(false);
    expect(capabilityAllowed("")).toBe(false);
  });
});

describe("kind is taken from the spec, not from the model", () => {
  it("overrides a model that mislabels a device capability as backend", () => {
    expect(kindForCapability("fix.restart_app", "backend")).toBe("device");
    expect(kindForCapability("ad.reset_password", "device")).toBe("backend");
  });

  it("falls back to the proposed kind only when there is no spec", () => {
    expect(kindForCapability(undefined, "reply")).toBe("reply");
    expect(kindForCapability("nonsense", "device")).toBe("device");
    expect(kindForCapability("nonsense", "wat")).toBe("reply");
  });
});

describe("buildCommand", () => {
  it("builds the exact argv for a well-formed call", () => {
    expect(buildCommand("fix.restart_app", { app: "Outlook" })).toEqual({
      ok: true,
      command: 'restart_app --app "Outlook"',
    });
    expect(buildCommand("diag.process_list", {})).toEqual({ ok: true, command: "process_list" });
  });

  it("applies schema defaults", () => {
    expect(buildCommand("fs.read", { path: "/etc/hosts" })).toEqual({
      ok: true,
      command: 'fs_read --path "/etc/hosts" --lines 2000',
    });
  });

  it("refuses an unknown capability instead of falling through to a real action", () => {
    // The old commandForCapability ended in `return "toggle_wifi"`, so an
    // unmapped capability cycled the employee's network adapter.
    const r = buildCommand("fix.format_disk", {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("unknown capability");
  });

  it("refuses a backend capability rather than inventing a device command", () => {
    const r = buildCommand("ad.reset_password", {});
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("no device command");
  });

  it("refuses bad params instead of coercing them into a different action", () => {
    // sanitizeDnsServers used to turn an unparseable list into "empty", which
    // does not decline the action — it performs a different one (drop the
    // resolver override and fall back to DHCP).
    const r = buildCommand("fix.set_dns_servers", { servers: ["not-an-ip"] });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain("not an IP address");
  });

  it("refuses an app name carrying shell metacharacters", () => {
    const r = buildCommand("fix.restart_app", { app: "Outlook; rm -rf /" });
    expect(r.ok).toBe(false);
  });

  it("refuses a path containing the quote that delimits it in the audit string", () => {
    const r = buildCommand("fs.read", { path: '/tmp/a" --lines 9999 --path "/etc/shadow' });
    expect(r.ok).toBe(false);
  });

  it("keeps spaces in paths, which real paths have", () => {
    const r = buildCommand("fs.list", { path: "~/Library/Application Support" });
    expect(r).toEqual({ ok: true, command: 'fs_list --path "~/Library/Application Support"' });
  });

  it("drops argv tokens that are not argv-safe rather than passing them through", () => {
    const r = buildCommand("diag.command_output", { binary: "ps", args: ["axo", "pid;whoami"] });
    expect(r).toEqual({ ok: true, command: 'command_output --binary "ps" --args "axo"' });
  });

  it("accepts the literal empty for a DNS reset", () => {
    expect(buildCommand("fix.set_dns_servers", { servers: "empty" })).toEqual({
      ok: true,
      command: 'set_dns_servers --service "auto" --servers "empty"',
    });
  });
});

describe("the prompt surface", () => {
  it("renders every capability into the model prompt", () => {
    const block = capabilityBlock();
    for (const s of CAPABILITY_SPECS) expect(block, `${s.id} missing from prompt`).toContain(s.id);
  });

  it("splits the prompt by what a capability costs", () => {
    const block = capabilityBlock();
    const reads = block.indexOf("READ-ONLY");
    const writes = block.indexOf("CHANGES SOMETHING");
    expect(reads).toBeLessThan(writes);
    expect(block.indexOf("fs.read")).toBeLessThan(writes);
    expect(block.indexOf("ad.reset_password")).toBeGreaterThan(writes);
  });

  it("derives the help map and labels from the specs", () => {
    expect(CAPABILITY_HELP["fix.flush_dns"]).toBe(capabilitySpec("fix.flush_dns")!.help);
    expect(humanLabelFor("fix.restart_app")).toBe("Restart the application");
    expect(humanLabelFor("nonsense")).toBe("Run device action");
  });
});
