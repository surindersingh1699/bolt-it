/**
 * Does the machine actually do what the registry says it does?
 *
 * `registry.test.ts` checks that the registry is internally consistent — every
 * change names a probe, every "recorded" reversibility names an undo. But those
 * fields are strings. `probe: "probeDns"` is a claim about a DIFFERENT file, and
 * nothing has ever checked it. The registry could promise a before/after probe
 * and a recorded undo for a capability whose handler in the agent has neither,
 * and every test in the suite would stay green while the ticket told an employee
 * their DNS change was verified and reversible.
 *
 * That was not hypothetical. `fix.set_dns_servers` declared
 * `reversible: "recorded"` and named an undo; `HANDLERS.set_dns_servers` had no
 * `rollback`, and the transaction in `executeJob` is gated on `handler.rollback`
 * — so nothing was ever put back. `fix.restart_app` and `fix.toggle_wifi` named
 * undos that do not exist either. `ladder.ts` orders fixes by `reversible`, so
 * for as long as that was true the ladder was ranking a DNS change as cheap to
 * be wrong about on the strength of an undo the build could not perform.
 *
 * So this suite imports the REAL agent module and diffs the two records. It is
 * the mechanism behind "the probes are real": not a promise in a doc, a failing
 * test the moment the two disagree.
 *
 * Importing `scripts/local-agent.mjs` is safe because its runtime — the token
 * check and the poll loop — is behind `IS_ENTRYPOINT`. `device-surface.test.ts`
 * leans on the same guard.
 */

import { describe, expect, it } from "vitest";
// Plain ESM with no types, on purpose: the agent runs on an employee's machine
// with node and nothing else installed. Both imports are re-typed below.
import { HANDLERS, parseCommand } from "../../../scripts/local-agent.mjs";
import { CAPABILITY_SPECS, buildCommand, type CapabilitySpec } from "./registry";

interface AgentHandler {
  expectsChange: boolean;
  probe?: unknown;
  act?: unknown;
  collect?: unknown;
  rollback?: unknown;
  requires?: string[];
}

const handlers = HANDLERS as Record<string, AgentHandler>;

/**
 * The minimum well-formed params for each device capability.
 *
 * Deliberately routed through `buildCommand` and then through the AGENT's own
 * `parseCommand` rather than hardcoding a capability→handler map here. A map
 * would be a third statement of the binding that could drift from the other two;
 * this exercises the same two functions the runtime uses, so if the command
 * string and the parser ever stop agreeing, that fails here too.
 */
const SAMPLE_PARAMS: Record<string, Record<string, unknown>> = {
  "diag.system_info": {},
  "diag.app_status": { app: "Outlook" },
  "diag.app_logs": { app: "Outlook" },
  "diag.process_list": {},
  "diag.network_state": {},
  "diag.command_output": { binary: "ps", args: ["ax"] },
  "diag.http_check": { url: "http://portal.acme.internal/" },
  "diag.screenshot": {},
  "fs.list": { path: "/tmp" },
  "fs.read": { path: "/etc/hosts" },
  "fs.grep": { path: "/tmp", pattern: "error" },
  "fs.find": { path: "/tmp", glob: "*.log" },
  "fix.restart_app": { app: "Outlook" },
  "fix.toggle_wifi": {},
  "fix.flush_dns": {},
  "fix.restart_service": { service: "Spooler" },
  "fix.clear_print_queue": {},
  "fix.renew_dhcp_lease": {},
  "fix.gpupdate": {},
  "fix.set_proxy": {},
  "fix.reset_winsock": {},
  "fix.clear_app_cache": { app: "Outlook" },
  "fix.set_dns_servers": { servers: ["1.1.1.1"] },
  "diag.vpn_state": { name: "Acme VPN" },
  "diag.device_status": { device: "Integrated Camera" },
  "fix.restart_shell": {},
  "fix.reconnect_vpn": { name: "Acme VPN" },
  "fix.kill_process": { app: "Outlook" },
  "fix.set_taskbar_autohide": { autoHide: false },
  "fix.set_startup_item": { item: "OneDrive", enabled: false },
  "fix.enable_device": { device: "Integrated Camera" },
  "fix.install_package": { package: "Microsoft.VCRedist.2015+.x64" },
  "exec.cmd": { command: "echo hi" },
};

/**
 * The two capabilities that run a command without claiming a verified effect.
 *
 * A DNS cache flush has no stable before/after fact — the cache is meant to be
 * empty afterwards and repopulates immediately — so the agent declares
 * `expectsChange: false` and the registry declares `probe: null`. `exec.cmd` is
 * an escape hatch whose effect is unknowable by definition. Both are recorded as
 * actions that RAN, never as changes that were verified, which is the only
 * honest thing to do with an action you cannot diff.
 *
 * Same two ids `registry.test.ts` exempts from the probe rule. Kept in step
 * deliberately: a third exemption should have to be argued for twice.
 */
const UNVERIFIABLE = new Set(["fix.flush_dns", "exec.cmd"]);

const deviceSpecs = CAPABILITY_SPECS.filter((s) => s.kind === "device");

/** The handler key the runtime would reach for this capability. */
function handlerFor(spec: CapabilitySpec): { key: string; handler: AgentHandler } {
  const built = buildCommand(spec.id, SAMPLE_PARAMS[spec.id]);
  if (!built.ok) throw new Error(`${spec.id}: sample params rejected — ${built.reason}`);
  const { name } = parseCommand(built.command) as { name: string };
  const handler = handlers[name];
  if (!handler) throw new Error(`${spec.id} builds "${name}", which this agent build has no handler for`);
  return { key: name, handler };
}

describe("every device capability reaches a handler that exists", () => {
  it("covers the whole device registry with sample params", () => {
    // Guards the fixture above: a capability added without a sample here would
    // otherwise silently drop out of every assertion below.
    for (const s of deviceSpecs) {
      expect(SAMPLE_PARAMS[s.id], `${s.id} has no sample params in this test`).toBeDefined();
    }
  });

  it("builds a command the agent's own parser resolves to a real handler", () => {
    for (const s of deviceSpecs) {
      expect(() => handlerFor(s), `${s.id}`).not.toThrow();
    }
  });
});

describe("the registry's probe claim matches the agent's build", () => {
  it("names a probe exactly when the handler has one", () => {
    // The claim in CapabilitySpec.probe: "a change with no probe cannot be
    // verified, which means it can never be honestly reported as a fix". That
    // sentence is only true if the handler on the machine really has the probe.
    for (const s of deviceSpecs) {
      const { key, handler } = handlerFor(s);
      expect(
        typeof handler.probe === "function",
        `${s.id} declares probe ${JSON.stringify(s.probe)} but HANDLERS.${key} has ` +
          `${handler.probe === undefined ? "none" : typeof handler.probe}`,
      ).toBe(s.probe !== null);
    }
  });

  it("gives every change a probe, or says out loud that it cannot be verified", () => {
    for (const s of deviceSpecs) {
      if (s.risk === 0 || UNVERIFIABLE.has(s.id)) continue;
      const { key, handler } = handlerFor(s);
      expect(typeof handler.probe, `${s.id} changes state but HANDLERS.${key} cannot read it`).toBe("function");
    }
  });

  it("never lets a read-only capability be dispatched as a change", () => {
    // The permissive direction of CLAUDE.md rule 3, checked at the far end: a
    // risk-0 capability whose handler declares expectsChange would be diffed and
    // rolled back like a write.
    for (const s of deviceSpecs) {
      if (s.risk !== 0) continue;
      const { key, handler } = handlerFor(s);
      expect(handler.expectsChange, `${s.id} is read-only but HANDLERS.${key} expects a change`).toBe(false);
    }
  });

  it("marks every verifiable change as one the agent will diff", () => {
    for (const s of deviceSpecs) {
      if (s.risk === 0 || UNVERIFIABLE.has(s.id)) continue;
      const { key, handler } = handlerFor(s);
      expect(handler.expectsChange, `${s.id} is risk ${s.risk} but HANDLERS.${key} expects no change`).toBe(true);
    }
  });

  it("keeps the unverifiable pair honest about being unverifiable", () => {
    // If either of these ever gains a probe, it should stop being an exception
    // rather than keep an exemption it no longer needs.
    for (const id of UNVERIFIABLE) {
      const spec = deviceSpecs.find((s) => s.id === id);
      expect(spec, `${id} is exempted but no longer exists`).toBeDefined();
      expect(spec!.probe, `${id} has a probe now — drop it from UNVERIFIABLE`).toBeNull();
      expect(handlerFor(spec!).handler.expectsChange, `${id} must not claim a verifiable change`).toBe(false);
    }
  });
});

describe("the registry's rollback claim matches the agent's build", () => {
  it("names an undo exactly when the handler can perform one", () => {
    // The failure this caught: three capabilities named an undo the build did
    // not have, and `executeJob` gates its rollback transaction on
    // `handler.rollback` — so the machine was left wherever the failed change
    // put it, with the ticket saying it was reversible.
    for (const s of deviceSpecs) {
      const { key, handler } = handlerFor(s);
      expect(
        typeof handler.rollback === "function",
        `${s.id} declares rollback ${JSON.stringify(s.rollback)} but HANDLERS.${key} has none`,
      ).toBe(s.rollback !== null);
    }
  });

  it("backs every recorded-reversible capability with a real undo on the device", () => {
    // `reversible: "recorded"` is the strongest claim in the registry — the
    // prior state was captured and an exact undo exists — and ladder.ts orders
    // fixes by it. It may never rest on prose alone.
    for (const s of deviceSpecs) {
      if (s.reversible !== "recorded") continue;
      const { key, handler } = handlerFor(s);
      expect(typeof handler.rollback, `${s.id} claims a recorded undo; HANDLERS.${key} has none`).toBe("function");
    }
  });
});
