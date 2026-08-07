import { describe, expect, it } from "vitest";
import { __testing } from "./knowledge";

const { hostAllowedForFetch } = __testing;

// fetchPageRaw pulls a whole page into the research distiller, whose output
// reaches the planner, whose output becomes commands on an employee's machine.
// The distiller is the semantic boundary; this is the network one.
describe("hostAllowedForFetch", () => {
  it("allows vendor documentation hosts", () => {
    for (const url of [
      "https://learn.microsoft.com/en-us/outlook/troubleshoot/error-0x8004010f",
      "https://support.apple.com/en-us/HT201541",
      "https://stackoverflow.com/questions/12345",
      "https://docs.jamf.com/whatever",
    ]) {
      expect(hostAllowedForFetch(url).ok, url).toBe(true);
    }
  });

  it("refuses hosts that are not on the allowlist", () => {
    const r = hostAllowedForFetch("https://attacker.example.com/payload");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allowlist/);
  });

  it("refuses loopback, private and link-local targets (SSRF)", () => {
    for (const url of [
      "http://localhost/admin",
      "http://127.0.0.1:8080/",
      "http://10.0.0.5/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://intranet.local/",
    ]) {
      expect(hostAllowedForFetch(url).ok, url).toBe(false);
    }
  });

  it("refuses non-http protocols", () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://x/"]) {
      expect(hostAllowedForFetch(url).ok, url).toBe(false);
    }
  });

  it("refuses a lookalike domain that merely contains an allowlisted one", () => {
    // microsoft.com.evil.tld must not pass by suffix confusion.
    expect(hostAllowedForFetch("https://microsoft.com.evil.tld/x").ok).toBe(false);
    expect(hostAllowedForFetch("https://notmicrosoft.com/x").ok).toBe(false);
  });

  it("refuses malformed input rather than throwing", () => {
    expect(hostAllowedForFetch("not a url").ok).toBe(false);
    expect(hostAllowedForFetch("").ok).toBe(false);
  });
});
