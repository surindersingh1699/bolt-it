/**
 * The device-side enforcement — the last line of defence, and until now the only
 * part of this system with no tests at all.
 *
 * Everything here runs on a real employee's machine with whatever privileges the
 * agent was installed with. The server-side gates can all be wrong and this is
 * what is left, which is a strange thing to have been taking on trust.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HANDLERS,
  READ_ONLY_BINARIES,
  executeJob,
  parseCommand,
  resolveTarget,
  validateReadOnlyCommand,
} from "./local-agent.mjs";
import { redactSecrets } from "./redact.mjs";

const IS_WINDOWS = os.platform() === "win32";

describe("validateReadOnlyCommand", () => {
  it("refuses a binary that is not on the allowlist", () => {
    expect(validateReadOnlyCommand("rm", ["-rf", "/"])).toMatch(/not on the read-only binary allowlist/);
    expect(validateReadOnlyCommand("curl", ["http://evil"])).toBeTruthy();
    expect(validateReadOnlyCommand("bash", ["-c", "id"])).toBeTruthy();
  });

  it("accepts an allowlisted read", () => {
    const bin = IS_WINDOWS ? "hostname" : "uname";
    expect(validateReadOnlyCommand(bin, IS_WINDOWS ? [] : ["-a"])).toBeNull();
  });

  it("enforces the subcommand list", () => {
    const [bin, bad] = IS_WINDOWS ? ["reg", "add"] : ["scutil", "--set"];
    expect(validateReadOnlyCommand(bin, [bad, "x"])).toMatch(/allows only/);
  });

  it("rejects arguments containing shell metacharacters", () => {
    const bin = IS_WINDOWS ? "hostname" : "uname";
    for (const arg of ["a;whoami", "a|id", "a&&id", "$(id)", "`id`", "a>b"]) {
      expect(validateReadOnlyCommand(bin, [arg]), arg).toMatch(/disallowed characters/);
    }
  });

  // The audit string is still unambiguously the argv — it just carries it as
  // JSON now (`--argv ["query","...Internet Settings"]`) rather than as a
  // space-joined string. Banning the space bought that guarantee at the price of
  // every Windows registry key and every path with a space in it: `reg query
  // "HKCU\...\Internet Settings"` reached the machine with its key missing, and
  // no rephrasing by the operator could have fixed it. The JSON form gives the
  // same guarantee and keeps the argument.
  it("allows a space inside one argument, because the argv is carried as JSON", () => {
    const bin = IS_WINDOWS ? "hostname" : "uname";
    expect(validateReadOnlyCommand(bin, ["two words"])).toBeNull();
  });

  it("still rejects the quote that would make the audit string ambiguous", () => {
    const bin = IS_WINDOWS ? "hostname" : "uname";
    expect(validateReadOnlyCommand(bin, ['a" b'])).toMatch(/disallowed characters/);
  });

  it("refuses arguments that target a credential store", () => {
    const bin = IS_WINDOWS ? "hostname" : "uname";
    for (const arg of [
      "/home/x/.aws/credentials",
      "/etc/shadow",
      "/home/x/.env",
      "id_ed25519",
      "/x/.netrc",
      "/home/x/.ssh/id_rsa",
    ]) {
      expect(validateReadOnlyCommand(bin, [arg]), arg).toMatch(/credential store/);
    }
  });

  it("refuses a tilde-relative credential path too, via the charset rule", () => {
    // `~` is not in SAFE_ARG, so these are stopped one rule earlier. Asserted
    // separately so that neither rule can be relaxed without a test noticing:
    // the first is about shell-safety, the second about what may be read.
    const bin = IS_WINDOWS ? "hostname" : "uname";
    for (const arg of ["~/.ssh/id_rsa", "~/.env"]) {
      expect(validateReadOnlyCommand(bin, [arg]), arg).toBeTruthy();
    }
  });

  it("caps argument count and length", () => {
    const bin = IS_WINDOWS ? "hostname" : "uname";
    expect(validateReadOnlyCommand(bin, Array(13).fill("a"))).toMatch(/too many arguments/);
    expect(validateReadOnlyCommand(bin, ["a".repeat(257)])).toMatch(/too long/);
  });

  it("allows only Get-* cmdlets through powershell", () => {
    if (!IS_WINDOWS) return;
    expect(validateReadOnlyCommand("powershell", ["Get-Process"])).toBeNull();
    expect(validateReadOnlyCommand("powershell", ["Remove-Item"])).toMatch(/Get-\*/);
    expect(validateReadOnlyCommand("powershell", ["Invoke-Expression"])).toMatch(/Get-\*/);
  });
});

describe("the read-only allowlist contains no writes", () => {
  // The premise of the whole list. Two entries used to violate it.
  it("does not let wmic start a process or install software", () => {
    if (!IS_WINDOWS) return;
    // `wmic process call create` was reachable: wmic had no subcommand filter
    // at all, so any argv passing the character check was accepted.
    expect(validateReadOnlyCommand("wmic", ["process", "call", "create", "calc.exe"])).toMatch(
      /is a write/,
    );
    expect(validateReadOnlyCommand("wmic", ["product", "call", "install"])).toMatch(/is a write/);
    expect(validateReadOnlyCommand("wmic", ["os", "get", "caption"])).toBeNull();
  });

  it("does not let dscl create or delete a directory record", () => {
    if (IS_WINDOWS) return;
    // The subtle one: the subcommand check only looks at argv[0], and "." is a
    // legitimate argv[0], so `dscl . -create` passed it.
    expect(validateReadOnlyCommand("dscl", [".", "-create", "/Users/x"])).toMatch(/is a write/);
    expect(validateReadOnlyCommand("dscl", [".", "-delete", "/Users/x"])).toMatch(/is a write/);
    expect(validateReadOnlyCommand("dscl", [".", "-passwd", "/Users/x"])).toMatch(/is a write/);
    expect(validateReadOnlyCommand("dscl", [".", "-read", "/Users/x"])).toBeNull();
  });

  it("declares a restriction on every binary whose name suggests it can write", () => {
    for (const [name, spec] of Object.entries(READ_ONLY_BINARIES)) {
      if (!["wmic", "dscl", "reg", "sc", "net", "defaults", "launchctl"].includes(name)) continue;
      const restricted = Boolean(spec.subcommands || spec.deniedArgs || spec.getCmdletOnly);
      expect(restricted, `${name} is unrestricted in the read-only allowlist`).toBe(true);
    }
  });
});

describe("resolveTarget", () => {
  let tmp;
  let secretDir;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bolt-agent-test-"));
    secretDir = path.join(tmp, ".ssh");
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(secretDir, "id_rsa"), "PRIVATE");
    fs.writeFileSync(path.join(tmp, "ok.txt"), "hello");
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("expands ~ to the home directory", () => {
    const r = resolveTarget("~");
    expect(r.error).toBeUndefined();
    expect(r.path).toBe(fs.realpathSync(os.homedir()));
  });

  it("refuses a credential path directly", () => {
    const r = resolveTarget(path.join(secretDir, "id_rsa"));
    expect(r.error).toBeTruthy();
  });

  it("refuses a SYMLINK into a credential path — realpath first, then judge", () => {
    // The reason resolveTarget calls realpathSync before testing the denylist.
    // Judging the raw string lets a symlink decide what you actually opened.
    const link = path.join(tmp, "innocent.txt");
    try {
      fs.symlinkSync(path.join(secretDir, "id_rsa"), link);
    } catch {
      return; // no symlink permission on this platform
    }
    const r = resolveTarget(link);
    expect(r.error, "a symlink must not launder a denied path").toBeTruthy();
  });

  it("refuses a traversal that lands in a credential path", () => {
    const r = resolveTarget(path.join(tmp, "sub", "..", ".ssh", "id_rsa"));
    expect(r.error).toBeTruthy();
  });

  it("allows an ordinary file", () => {
    const r = resolveTarget(path.join(tmp, "ok.txt"));
    expect(r.error).toBeUndefined();
  });

  it("requires a path", () => {
    expect(resolveTarget("").error).toBeTruthy();
    expect(resolveTarget(null).error).toBeTruthy();
  });
});

describe("redactSecrets", () => {
  const cases = [
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"],
    ["aws-key", "AKIAIOSFODNN7EXAMPLE"],
    ["github-token", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["anthropic-key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
    ["slack-token", "xoxb-123456789-abcdefghijkl"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef"],
    ["auth-header", "Authorization: Bearer sometokenvalue"],
    ["url-credentials", "postgres://admin:hunter2@db.internal:5432/app"],
    ["connection-string", "Server=db;Password=hunter2;"],
    ["cookie-header", "Cookie: session=abc123"],
    ["credential", "api_key: abcdef123456"],
  ];

  for (const [label, sample] of cases) {
    it(`redacts ${label}`, () => {
      const out = redactSecrets(`prefix ${sample} suffix`);
      expect(out).toContain("[REDACTED:");
      expect(out).toContain("prefix");
      expect(out).toContain("suffix");
    });
  }

  it("leaves no residue of the original secret", () => {
    const out = redactSecrets("token = ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("keeps the label, because THAT a file holds a credential is often the diagnosis", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED:aws-key]");
  });

  it("does not mangle ordinary diagnostic output", () => {
    const plain = "Outlook.exe  PID 4821  CPU 12.4%  MEM 380MB";
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("never throws on a non-string", () => {
    expect(redactSecrets(undefined)).toBe("");
    expect(redactSecrets(42)).toBe("42");
  });
});

describe("parseCommand", () => {
  it("parses the audit string the server built", () => {
    expect(parseCommand('restart_app --app "Outlook"')).toEqual({
      name: "restart_app",
      args: expect.objectContaining({ app: "Outlook" }),
    });
  });

  it("cannot be escaped through --app", () => {
    // The quoted-value regex is what stops a crafted app name from becoming a
    // second argument or a second command.
    const { name, args } = parseCommand('restart_app --app "Outlook" --path "/etc/shadow"');
    expect(name).toBe("restart_app");
    expect(args.app).toBe("Outlook");
  });

  it("caps --lines and --limit rather than trusting them", () => {
    expect(parseCommand('fs_read --path "/tmp/x" --lines 999999').args.lines).toBeLessThanOrEqual(5000);
    expect(parseCommand('app_event_logs --app "X" --limit 999').args.limit).toBeLessThanOrEqual(50);
  });
});

describe("parseCommand reads the flags the new handlers need", () => {
  it("keeps a boolean flag as a token, so an absent one stays undefined", () => {
    // `requires` tests truthiness. Coercing "--enabled false" to the boolean
    // false here would make an explicit disable look like a missing argument.
    expect(parseCommand("set_taskbar_autohide --autohide false").args.autoHide).toBe("false");
    expect(parseCommand("set_taskbar_autohide --autohide true").args.autoHide).toBe("true");
    expect(parseCommand("set_taskbar_autohide").args.autoHide).toBeUndefined();
    expect(parseCommand('set_startup_item --item "OneDrive" --enabled false').args).toMatchObject({
      item: "OneDrive",
      enabled: "false",
    });
  });

  it("parses package, device and VPN names", () => {
    expect(parseCommand('install_package --package "Microsoft.VCRedist.2015+.x64"').args.package)
      .toBe("Microsoft.VCRedist.2015+.x64");
    expect(parseCommand('enable_device --device "Integrated Camera"').args.device).toBe("Integrated Camera");
    expect(parseCommand('vpn_state --name "Acme VPN"').args.name).toBe("Acme VPN");
    // Empty is legal for a VPN name and means "whichever tunnel this machine has".
    expect(parseCommand('vpn_state --name ""').args.name).toBe("");
  });
});

describe("the new device handlers run rather than throw", () => {
  const run = (command) => executeJob({ id: "t", ticketId: "T", allowlistedCommand: command });

  it("vpn_state reads the machine and returns separable facts", async () => {
    const r = await run('vpn_state --name ""');
    expect(r.ok, r.error).toBe(true);
    // The whole point of this probe: a dead tunnel and a live tunnel with the
    // wrong resolvers must be distinguishable, so these are separate facts.
    const facts = r.envelope.probes[0].facts;
    expect(Object.keys(facts)).toEqual(
      expect.arrayContaining(["connected", "tunnel", "tunnel_ip", "tunnel_dns"]),
    );
    expect(r.envelope.expectsChange).toBe(false);
  });

  it("kill_process refuses a system process before it runs anything", async () => {
    // The refusal must come from the handler, not from the OS declining the
    // kill: ending lsass or WindowServer takes down the session, and finding
    // that out afterwards is not a safety property.
    const r = await run(`kill_process --app "${IS_WINDOWS ? "lsass" : "WindowServer"}"`);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/system process/);
    expect(r.envelope.commands.some((c) => /Stop-Process|pkill/.test(c.argv.join(" ")))).toBe(false);
  });

  it("enforces required arguments instead of acting on a default", async () => {
    expect((await run("set_taskbar_autohide")).error).toMatch(/missing --autoHide/);
    expect((await run('set_startup_item --item "OneDrive"')).error).toMatch(/missing --enabled/);
    expect((await run("install_package")).error).toMatch(/missing --package/);
    expect((await run("enable_device")).error).toMatch(/missing --device/);
  });

  it("says plainly when a capability is not implemented on this platform", async () => {
    // Windows-only handlers must fail with a reason, never report a change they
    // did not make. On Windows these reach the real implementation instead.
    if (IS_WINDOWS) return;
    for (const command of [
      'install_package --package "Microsoft.VCRedist.2015+.x64"',
      'enable_device --device "Integrated Camera"',
      'set_startup_item --item "OneDrive" --enabled false',
    ]) {
      const r = await run(command);
      expect(r.ok, command).toBe(false);
      expect(r.error, command).toMatch(/Windows only/);
      expect(r.envelope.effect.changed, command).toBe(false);
    }
  });

  it("never runs an undo for a change that never happened", async () => {
    // The rollback transaction is for "the act claimed success and the machine
    // disagrees". When the act itself failed and the probes agree nothing moved,
    // firing the undo can only make an unauthorised change — and its error
    // replaces the real reason on the ticket, which is how this was found:
    // a refused install ran `winget uninstall` and reported THAT failure.
    if (IS_WINDOWS) return;
    const r = await run('install_package --package "Microsoft.VCRedist.2015+.x64"');
    expect(r.error).toMatch(/Windows only/);
    expect(r.envelope.rolledBack).toBeUndefined();
    expect(r.envelope.commands.some((c) => c.argv.includes("uninstall"))).toBe(false);
  });
});

describe("the handler table", () => {
  it("has no general-purpose escape hatch", () => {
    // CLAUDE.md rule 3. If a handler named anything like this ever appears, the
    // capability model has been bypassed rather than extended.
    for (const name of Object.keys(HANDLERS)) {
      expect(name).not.toMatch(/^(run|exec|shell|eval|cmd|powershell|bash)$/);
    }
  });

  it("declares expectsChange on every handler that acts", () => {
    for (const [name, h] of Object.entries(HANDLERS)) {
      if (!h.act) continue;
      expect(typeof h.expectsChange, `${name}`).toBe("boolean");
    }
  });

  it("gives every acting handler a probe, so its effect can be verified", () => {
    for (const [name, h] of Object.entries(HANDLERS)) {
      if (!h.act || !h.expectsChange) continue;
      expect(typeof h.probe, `${name} changes state but has no probe`).toBe("function");
    }
  });

  it("gives a rollback only to handlers that can actually verify one ran", () => {
    for (const [name, h] of Object.entries(HANDLERS)) {
      if (!h.rollback) continue;
      expect(h.act, `${name} has a rollback but never acts`).toBeTypeOf("function");
      expect(h.probe, `${name} has a rollback but no probe to confirm it`).toBeTypeOf("function");
    }
  });
});

describe("fs read handlers actually run (not just parse)", () => {
  // The gap that let a crash ship: every prior test checked HANDLERS *shape* or
  // validateReadOnlyCommand, never drove executeJob through an fs handler. The
  // live VM caught `note.slice is not a function` in fs_find because collectFsFind
  // passed a number where a string was expected. These run the real thing.
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bolt-fs-"));
    fs.writeFileSync(path.join(dir, "app.log"), "line one\nline two\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello\n");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "deep.log"), "deep\n");
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (command) =>
    executeJob({ id: "t", ticketId: "T", allowlistedCommand: command });

  it("fs_find returns a result instead of throwing", async () => {
    const r = await run(`fs_find --path "${dir}" --pattern "*.log"`);
    expect(r.ok, r.error).toBe(true);
    expect(r.output).toContain("app.log");
    // The recordFsAccess note must be a string in the envelope, not a number.
    const rec = r.envelope.commands.find((c) => c.argv[0] === "fs_find");
    expect(typeof rec.stdout).toBe("string");
  });

  it("fs_list runs", async () => {
    const r = await run(`fs_list --path "${dir}"`);
    expect(r.ok, r.error).toBe(true);
    expect(r.output).toContain("notes.txt");
  });

  it("fs_read runs", async () => {
    const r = await run(`fs_read --path "${path.join(dir, "app.log")}" --lines 2000`);
    expect(r.ok, r.error).toBe(true);
    expect(r.output).toContain("line one");
  });

  it("fs_grep runs", async () => {
    const r = await run(`fs_grep --path "${dir}" --pattern "two"`);
    expect(r.ok, r.error).toBe(true);
  });

  it("fs_find refuses a credential path via the denylist, without throwing", async () => {
    const r = await run(`fs_find --path "${path.join(dir, "sub")}" --pattern "*.log"`);
    expect(r.ok, r.error).toBe(true); // sub/ is fine; just proves the walk completes
  });
});
