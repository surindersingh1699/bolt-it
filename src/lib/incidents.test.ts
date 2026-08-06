import { describe, it, expect } from "vitest";
import {
  IncidentRecord,
  MIN_SAMPLES,
  classifyIncident,
  incidentsAsContext,
  summarizeIncidents,
} from "./incidents";

const incident = (over: Partial<IncidentRecord> = {}): IncidentRecord => ({
  id: "i-1",
  workspaceId: "acme.test",
  ticketId: "t-1",
  category: "app_crash",
  symptom: "Excel keeps freezing",
  tier: 2,
  capabilitiesUsed: ["diag.app_status", "fix.restart_app"],
  resolvedBy: "fix.restart_app",
  resolved: true,
  at: 1,
  ...over,
});

describe("classifyIncident", () => {
  it("is a pure function of the text, so write and read agree on the bucket", () => {
    // The whole retrieval scheme rests on this: the category assigned when a
    // ticket is filed must be the one the next ticket looks under.
    const a = classifyIncident("Printer offline", "The floor printer won't print.");
    const b = classifyIncident("Printer offline", "The floor printer won't print.");
    expect(a).toBe(b);
    expect(a).toBe("printing");
  });

  it("prefers the specific class when two could match", () => {
    // Printing beats VPN: it is the thing that is broken, not the transport.
    expect(classifyIncident("Cannot print", "Printing over the VPN fails.")).toBe("printing");
    // A crash beats email sync: Outlook stopping is a crash, not a sync fault.
    expect(classifyIncident("Outlook crashes", "Outlook crashes when syncing mail.")).toBe("app_crash");
  });

  it("buckets the common classes from natural phrasing", () => {
    expect(classifyIncident("Locked out", "Too many attempts and now I'm locked out.")).toBe("account_lockout");
    expect(classifyIncident("No wifi", "Laptop says no internet.")).toBe("network_connectivity");
    expect(classifyIncident("Disk full", "It says out of space when I save.")).toBe("storage_full");
    expect(classifyIncident("Teams is slow", "Everything lags all afternoon.")).toBe("app_slow");
  });

  it("falls back to other rather than guessing a bucket", () => {
    // A wrong bucket is worse than none: it pollutes another class's record.
    expect(classifyIncident("Question", "Who do I ask about the offsite?")).toBe("other");
  });
});

describe("summarizeIncidents", () => {
  it("credits only the capability that actually moved the machine", () => {
    // diag.app_status ran in both tickets but fixed neither. Crediting a probe
    // for a ticket that later resolved would score every diagnostic near 100%
    // and send the next planner straight at a step that changes nothing.
    const stats = summarizeIncidents("app_crash", [incident(), incident({ ticketId: "t-2" })]);
    const diag = stats.capabilities.find((c) => c.capability === "diag.app_status")!;
    const fix = stats.capabilities.find((c) => c.capability === "fix.restart_app")!;
    expect(diag.attempts).toBe(2);
    expect(diag.successes).toBe(0);
    expect(fix.successes).toBe(2);
    expect(fix.successRate).toBe(1);
  });

  it("counts a capability once per ticket even if it appears twice", () => {
    const stats = summarizeIncidents("app_crash", [
      incident({ capabilitiesUsed: ["fix.restart_app", "fix.restart_app"] }),
    ]);
    expect(stats.capabilities.find((c) => c.capability === "fix.restart_app")!.attempts).toBe(1);
  });

  it("does not credit a resolver on an unresolved ticket", () => {
    const stats = summarizeIncidents("app_crash", [
      incident({ resolved: false, resolvedBy: "fix.restart_app", failureKind: "no_effect" }),
    ]);
    expect(stats.resolved).toBe(0);
    expect(stats.capabilities.find((c) => c.capability === "fix.restart_app")!.successes).toBe(0);
  });

  it("ranks the best performer first", () => {
    const rows = [
      incident({ ticketId: "t-1", capabilitiesUsed: ["fix.a", "fix.b"], resolvedBy: "fix.a" }),
      incident({ ticketId: "t-2", capabilitiesUsed: ["fix.a", "fix.b"], resolvedBy: "fix.a" }),
      incident({ ticketId: "t-3", capabilitiesUsed: ["fix.b"], resolved: false, resolvedBy: undefined }),
    ];
    expect(summarizeIncidents("app_crash", rows).capabilities[0].capability).toBe("fix.a");
  });
});

describe("incidentsAsContext", () => {
  it("renders nothing at all when there is no history", () => {
    // An empty block of zeroes would read as evidence that nothing works.
    expect(incidentsAsContext(summarizeIncidents("vpn", []))).toBe("");
    expect(incidentsAsContext(null)).toBe("");
  });

  it("withholds a percentage until the sample supports one", () => {
    const stats = summarizeIncidents("vpn", [incident({ category: "vpn" })]);
    const text = incidentsAsContext(stats);
    expect(text).toContain("too few to rate");
    expect(text).not.toContain("100%");
  });

  it("shows a rate with its sample size once there is enough", () => {
    const rows = Array.from({ length: MIN_SAMPLES }, (_, i) =>
      incident({ ticketId: `t-${i}`, capabilitiesUsed: ["fix.restart_app"] }),
    );
    const text = incidentsAsContext(summarizeIncidents("app_crash", rows));
    expect(text).toContain(`100% (${MIN_SAMPLES}/${MIN_SAMPLES})`);
  });
});
