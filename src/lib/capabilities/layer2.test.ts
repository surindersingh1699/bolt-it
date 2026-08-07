/**
 * The four capability families, and the properties each one has to keep.
 *
 * The generic invariants (probe, rollback, provenance) are enforced for every
 * spec in registry.test.ts. These are the ones specific to what was just added.
 */

import { describe, expect, it } from "vitest";
import { buildCommand, capabilitySpec, isReadOnlyCapability } from "./registry";
import { decide } from "../policy";
import { screenForHarvest } from "../intent";
import type { ExecutionMode } from "../autonomy";
import type { PlanStep } from "../types";

const MODES: ExecutionMode[] = ["simulation", "shadow", "limited", "gated", "full"];

describe("fs.find", () => {
  it("is a read, and searches names rather than contents", () => {
    expect(isReadOnlyCapability("fs.find")).toBe(true);
    expect(capabilitySpec("fs.find")!.help).toContain("NAME");
  });

  it("builds a bounded command", () => {
    expect(buildCommand("fs.find", { path: "~/Library/Logs", glob: "*.log" })).toEqual({
      ok: true,
      command: 'fs_find --path "~/Library/Logs" --pattern "*.log"',
    });
  });

  it("refuses a glob carrying the quote that delimits it", () => {
    expect(buildCommand("fs.find", { path: "~", glob: '*" --path "/etc' }).ok).toBe(false);
  });

  it("is screened by the intent validator like any other search", () => {
    // The capability the validator was written for. A filename search for
    // credential material is the cheapest possible harvest.
    const step: PlanStep = {
      id: "s-1",
      kind: "device",
      capability: "fs.find",
      description: "find keys",
      params: { path: "~/Documents", glob: "*.pem" },
      status: "pending",
    };
    expect(screenForHarvest([step]).hits.map((h) => h.term)).toContain("cert-key");
  });
});

describe("diag.screenshot", () => {
  it("is risk 0 — the gate that matters for it is not the risk number", () => {
    // The consent prompt lives on the device, where no autonomy rung can reach
    // it. Rating it high would only add a second, weaker gate in the cloud.
    expect(capabilitySpec("diag.screenshot")!.risk).toBe(0);
    expect(isReadOnlyCapability("diag.screenshot")).toBe(true);
  });

  it("says in the prompt that the employee is asked and can refuse", () => {
    const help = capabilitySpec("diag.screenshot")!.help;
    expect(help).toContain("permission");
    expect(help).toContain("refuse");
  });

  it("takes no parameters — there is nothing to point it at", () => {
    expect(buildCommand("diag.screenshot", {})).toEqual({ ok: true, command: "screenshot" });
    expect(buildCommand("diag.screenshot", { path: "/etc" }).ok).toBe(false);
  });
});

describe("the new settings capabilities", () => {
  const added = [
    "fix.restart_service",
    "fix.clear_print_queue",
    "fix.renew_dhcp_lease",
    "fix.gpupdate",
    "fix.set_proxy",
    "fix.reset_winsock",
  ];

  it("all exist and all change something", () => {
    for (const id of added) {
      const spec = capabilitySpec(id);
      expect(spec, id).toBeDefined();
      expect(isReadOnlyCapability(id), id).toBe(false);
    }
  });

  it("all declare a probe, so their effect can actually be verified", () => {
    for (const id of added) {
      expect(capabilitySpec(id)!.probe, `${id} has no probe`).toBeTruthy();
    }
  });

  it("all require elevation, and say so", () => {
    for (const id of added) {
      expect(capabilitySpec(id)!.requiresElevation, id).toBe(true);
    }
  });

  it("keeps the batch to risk 1 and 2 — nothing persistent or destructive", () => {
    for (const id of added) {
      expect(capabilitySpec(id)!.risk, id).toBeLessThanOrEqual(2);
    }
  });

  it("scopes the Windows-only ones to Windows", () => {
    expect(capabilitySpec("fix.gpupdate")!.os).toEqual(["win32"]);
    expect(capabilitySpec("fix.reset_winsock")!.os).toEqual(["win32"]);
  });
});

describe("fix.set_proxy is genuinely reversible, not hopefully so", () => {
  const spec = capabilitySpec("fix.set_proxy")!;

  it("records the prior configuration rather than guessing at one", () => {
    expect(spec.reversible).toBe("recorded");
    expect(spec.rollback).toContain("before-probe");
  });

  it("clears the proxy when given no server", () => {
    expect(buildCommand("fix.set_proxy", {})).toEqual({
      ok: true,
      command: 'set_proxy --server "" --port 0',
    });
  });

  it("refuses a proxy host that is a URL rather than a hostname", () => {
    expect(buildCommand("fix.set_proxy", { server: "http://evil.test/x" }).ok).toBe(false);
  });

  it("refuses a port outside the valid range", () => {
    expect(buildCommand("fix.set_proxy", { server: "proxy.corp", port: 99999 }).ok).toBe(false);
  });
});

describe("fix.reset_winsock cannot run unattended on any rung", () => {
  const spec = capabilitySpec("fix.reset_winsock")!;

  it("is declared irreversible and elevated, which is what holds it", () => {
    expect(spec.reversible).toBe("none");
    expect(spec.requiresElevation).toBe(true);
  });

  it("is held for a person on every autonomy rung", () => {
    // Not because it is on ALWAYS_ASK — that floor is bypassable — but because
    // `requiresElevation && reversible === "none"` is a structural rule.
    for (const mode of MODES) {
      const outcome = decide({
        spec,
        kind: "device",
        score: {
          risk: "low",
          rollbackAvailable: true,
          verificationAvailable: true,
          leastPrivilege: true,
          blastRadius: "low",
          requiresHuman: false,
          reasoning: ["reviewer thought this was fine"],
        },
        refusal: null,
        floor: null,
        intent: "clear",
        intentUnexplained: false,
        mode,
      });
      expect(outcome.decision, mode).toBe("human");
      expect(outcome.rule).toBe("irreversible-elevated");
    }
  });

  it("warns in the prompt that it needs a reboot to take effect", () => {
    expect(spec.help).toContain("REBOOT");
  });
});

describe("the reversible settings changes can still run unattended", () => {
  it("clears fix.restart_service on the gated rung when the reviewer is happy", () => {
    const outcome = decide({
      spec: capabilitySpec("fix.restart_service"),
      kind: "device",
      score: {
        risk: "low",
        rollbackAvailable: true,
        verificationAvailable: true,
        leastPrivilege: true,
        blastRadius: "low",
        requiresHuman: false,
        reasoning: ["restarts the spooler, self-restoring"],
      },
      refusal: null,
      floor: null,
      intent: "clear",
      intentUnexplained: false,
      mode: "gated",
    });
    expect(outcome.decision).toBe("auto");
  });

  it("holds fix.set_proxy on the limited rung, because it survives a reboot", () => {
    const outcome = decide({
      spec: capabilitySpec("fix.set_proxy"),
      kind: "device",
      score: {
        risk: "low",
        rollbackAvailable: true,
        verificationAvailable: true,
        leastPrivilege: true,
        blastRadius: "low",
        requiresHuman: false,
        reasoning: ["reversible"],
      },
      refusal: null,
      floor: null,
      intent: "clear",
      intentUnexplained: false,
      mode: "limited",
    });
    expect(outcome.decision).toBe("human");
    expect(outcome.rule).toBe("over-mode-risk-cap");
  });
});
