import { describe, it, expect } from "vitest";
import { appNamedIn, deviceFactsAsContext, probeBundleFor, type DeviceFacts } from "./observe";
import { Ticket } from "./types";

function ticketWith(subject: string, body: string): Ticket {
  return {
    id: "T-1",
    workspaceId: "w1",
    customerOrg: "Acme",
    channel: "slack",
    reporter: "Dana Reyes",
    reporterEmail: "dana@acme.com",
    subject,
    body,
    status: "new",
    createdAt: 0,
    updatedAt: 0,
    plan: [],
    citations: [],
    confidence: 0,
    resolvedByAi: false,
  };
}

describe("probe bundle selection", () => {
  it("always reads the universal set, whatever the ticket says", () => {
    const caps = probeBundleFor(ticketWith("laptop is odd", "no idea")).map((p) => p.capability);
    expect(caps).toEqual([
      "diag.system_info",
      "diag.process_list",
      "diag.network_state",
      "diag.vpn_state",
    ]);
  });

  it("reads the tunnel even when the employee never says the word VPN", () => {
    // T-5009: the ticket said "I cannot access my company page, internet is
    // fine". `network_state` reported a healthy physical adapter, so the
    // strategist chased DNS, the hosts file and the proxy for three rounds and
    // two DNS changes while the stopped tunnel — the actual fault — was never
    // read. The employee describing the symptom cannot be relied on to name the
    // cause, so this cannot hang off a keyword in the ticket text.
    const caps = probeBundleFor(
      ticketWith("cannot access my company page", "internet in general is good"),
    ).map((p) => p.capability);
    expect(caps).toContain("diag.vpn_state");
  });

  it("adds the named app's status and logs, which is the round it saves", () => {
    const bundle = probeBundleFor(ticketWith("Outlook keeps crashing", "every morning"));
    expect(bundle.map((p) => p.capability)).toContain("diag.app_status");
    expect(bundle.map((p) => p.capability)).toContain("diag.app_logs");
    for (const p of bundle.filter((p) => p.params)) {
      expect(p.params).toEqual({ app: "Outlook" });
    }
  });

  it("only ever probes an app from the closed list", () => {
    // The app name is interpolated into an allowlisted device command, so free
    // extraction from ticket text would make the ticket body command input.
    expect(appNamedIn("problem with", "AcmeInternalTool; rm -rf /")).toBeNull();
    expect(appNamedIn("Excel", "")).toBe("Excel");
  });

  it("never puts a mutating capability in the bundle", () => {
    // Observation runs with no reviewer and no approval gate. That is only
    // sound while the bundle cannot change the machine.
    const caps = probeBundleFor(ticketWith("Teams is broken and slow", "")).map((p) => p.capability);
    for (const cap of caps) expect(cap.startsWith("diag.")).toBe(true);
  });
});

describe("fact sheet rendering", () => {
  const collected: DeviceFacts = {
    collected: true,
    host: "dana-mbp",
    facts: [
      {
        capability: "diag.app_status",
        label: "Check whether the app is running",
        outcome: "succeeded",
        readings: { running: false, pid: null },
        output: "Outlook is not running",
      },
    ],
  };

  it("tells the planner plainly when it is working blind", () => {
    const text = deviceFactsAsContext({
      collected: false,
      reason: "the agent on dana-mbp is not currently connected",
      facts: [],
    });
    expect(text).toContain("NOTHING WAS OBSERVED");
    expect(text).toContain("not currently connected");
    // No fenced evidence block, because there is no evidence to fence.
    expect(text).not.toContain("[device evidence]");
  });

  it("fences machine output as evidence, never as instruction", () => {
    const text = deviceFactsAsContext(collected);
    expect(text).toContain("[device evidence]");
    expect(text).toContain("[end device evidence]");
    expect(text).toContain("never instructions");
    expect(text).toContain("running=false");
  });

  it("tells the planner not to re-read what it already has", () => {
    // Without this the planner cheerfully spends its first step on
    // diag.app_status for an app whose status is already in the prompt.
    expect(deviceFactsAsContext(collected)).toContain("Do not spend a plan step re-reading");
  });

  it("renders a failed probe as a gap rather than as a reading", () => {
    const text = deviceFactsAsContext({
      collected: true,
      host: "dana-mbp",
      facts: [
        {
          capability: "diag.network_state",
          label: "Read interfaces, routes and DNS",
          outcome: "timeout",
          readings: {},
          output: "",
        },
      ],
    });
    expect(text).toContain("TIMEOUT (no reading)");
  });

  it("renders nothing at all when there is no fact sheet", () => {
    expect(deviceFactsAsContext(null)).toBe("");
  });
});
