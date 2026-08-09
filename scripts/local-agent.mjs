#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import dnsp from "node:dns/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactDeep, redactSecrets } from "./redact.mjs";

const appUrl = process.env.IT_SUPPORT_APP_URL || "http://localhost:3000";
// A per-device token, minted by POST /api/agent/enroll and stored in the
// machine's own ACL-protected config. Falls back to the shared token, which the
// server only accepts when ALLOW_SHARED_AGENT_TOKEN=1 and which cannot be
// routed to a specific machine — enroll properly and drop it.
const token = process.env.LOCAL_AGENT_DEVICE_TOKEN || process.env.LOCAL_AGENT_TOKEN;
const intervalMs = Number(process.env.LOCAL_AGENT_POLL_MS || 3000);
const speak = process.env.LOCAL_AGENT_SPEAK === "1";

// True only when run as the CLI (`pnpm agent`), false when imported by a test
// harness. Guards the token requirement and the poll loop so `executeJob` can be
// exercised directly without a token or a running server.
const IS_ENTRYPOINT = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_ENTRYPOINT && !token) {
  console.error("LOCAL_AGENT_TOKEN is required.");
  process.exit(1);
}

const AGENT_HOSTNAME = os.hostname();
const AGENT_OS = `${os.platform()} ${os.release()} (${os.arch()})`;
const AGENT_VERSION = "local-agent/0.6.0";
// Replaced with a content hash of the bundle when served by /api/agent/script.
// Stays "dev" when the file is run straight from disk (`pnpm agent`), where
// there is no build to update against and the self-exit below must never fire.
const AGENT_BUILD = "dev";
const IS_MAC = os.platform() === "darwin";
const IS_WINDOWS = os.platform() === "win32";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgGreen: "\x1b[42m\x1b[30m",
  bgYellow: "\x1b[43m\x1b[30m",
  bgRed: "\x1b[41m\x1b[97m",
};

let currentJob = null;

function humanLabel(command) {
  const c = String(command || "");
  if (c.startsWith("restart_app ")) {
    const m = c.match(/--app "([^"]+)"/);
    return `Restarting ${m?.[1] || "app"}`;
  }
  if (c.startsWith("clear_app_cache ")) {
    const m = c.match(/--app "([^"]+)"/);
    return `Clearing ${m?.[1] || "app"} cache`;
  }
  if (c.startsWith("toggle_wifi")) return "Cycling the network adapter";
  if (c.startsWith("set_dns_servers")) {
    const m = c.match(/--servers "([^"]*)"/);
    return `Setting DNS resolvers to ${m?.[1] === "empty" || !m?.[1] ? "DHCP" : m[1]}`;
  }
  if (c.startsWith("flush_dns")) return "Flushing the DNS resolver cache";
  if (c.startsWith("collect_system_info")) return "Collecting computer hardware/OS info";
  if (c.startsWith("app_status ")) return "Checking whether the app is running";
  if (c.startsWith("app_event_logs ")) return "Reading the app's recent error events";
  if (c.startsWith("process_list")) return "Listing what's running on the machine";
  if (c.startsWith("network_state")) return "Reading interfaces, routes and DNS";
  if (c.startsWith("command_output ")) {
    const m = c.match(/--binary "([^"]+)"/);
    return `Reading device state via ${m?.[1] || "a read-only command"}`;
  }
  if (c.startsWith("restart_shell")) return "Restarting the desktop shell";
  if (c.startsWith("set_taskbar_autohide")) {
    const m = c.match(/--autohide (true|false)/);
    return `Turning taskbar auto-hide ${m?.[1] === "true" ? "on" : "off"}`;
  }
  if (c.startsWith("kill_process ")) {
    const m = c.match(/--app "([^"]+)"/);
    return `Ending ${m?.[1] || "a process"}`;
  }
  if (c.startsWith("set_startup_item ")) {
    const m = c.match(/--item "([^"]+)"/);
    const on = c.match(/--enabled (true|false)/)?.[1] === "true";
    return `${on ? "Enabling" : "Disabling"} ${m?.[1] || "a startup item"} at startup`;
  }
  if (c.startsWith("install_package ")) {
    const m = c.match(/--package "([^"]+)"/);
    return `Installing ${m?.[1] || "a package"}`;
  }
  if (c.startsWith("enable_device ")) {
    const m = c.match(/--device "([^"]+)"/);
    return `Enabling ${m?.[1] || "a device"}`;
  }
  if (c.startsWith("device_status ")) {
    const m = c.match(/--device "([^"]+)"/);
    return `Checking whether ${m?.[1] || "a device"} is enabled`;
  }
  if (c.startsWith("vpn_state")) return "Reading the VPN tunnel state";
  if (c.startsWith("reconnect_vpn")) return "Reconnecting the VPN";
  if (c.startsWith("exec_cmd")) return "Executing command on VM";
  return "Running sandboxed diagnostic";
}

// ---- command execution, recorded -------------------------------------------
// Nothing runs on this machine except through runRecorded, so every job's
// envelope carries the real argv, the real exit code and the real stderr.
// Fire-and-forget shell calls are what let "nothing happened" look like
// success, so there are none left.

function runShell(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    p.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

function psArgs(script) {
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

async function runRecorded(ctx, cmd, args) {
  const startedAt = Date.now();
  const res = await runShell(cmd, args);
  ctx.commands.push({
    argv: [cmd, ...args],
    exitCode: res.code,
    stdout: res.stdout.slice(0, 4000),
    stderr: res.stderr.slice(0, 2000),
    durationMs: Date.now() - startedAt,
  });
  return res;
}

function runRecordedPs(ctx, script) {
  return runRecorded(ctx, "powershell", psArgs(script));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function psEscape(s) {
  return String(s).replace(/[`"$]/g, "");
}

function appNameCandidates(appName) {
  const safe = psEscape(appName);
  return [...new Set([
    safe,
    safe.replace(/^Microsoft\s+/i, ""),
    safe.split(/\s+/).pop(),
    safe.replace(/\s+/g, "").toLowerCase(),
  ])].filter(Boolean);
}

// ---- probes ----------------------------------------------------------------
// A probe reads device state and returns comparable `facts`. The difference
// between the probe taken before an action and the one taken after IS the
// proof that the action landed. Facts deliberately exclude noisy values
// (memory usage, timestamps that drift on their own) so a diff means a real
// change, not measurement jitter.

async function probeProcess(ctx, label, appName) {
  const candidates = appNameCandidates(appName);
  if (IS_WINDOWS) {
    const nameList = candidates.map((c) => `'${c}'`).join(",");
    const script =
      `$p = Get-Process -Name ${nameList} -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; ` +
      `if ($p) { [PSCustomObject]@{ running=$true; pid=$p.Id; process_name=$p.ProcessName; ` +
      `started_at=$p.StartTime.ToString('o'); responding=$p.Responding } | ConvertTo-Json -Compress } ` +
      `else { '{"running":false}' }`;
    const res = await runRecorded(ctx, "powershell", psArgs(script));
    let facts = { running: false, pid: null, started_at: null };
    try {
      const parsed = JSON.parse(res.stdout.trim() || "{}");
      facts = {
        running: parsed.running === true,
        pid: parsed.pid ?? null,
        process_name: parsed.process_name ?? null,
        started_at: parsed.started_at ?? null,
        responding: parsed.responding ?? null,
      };
    } catch {
      // Leave the default "not running" facts; the raw stdout is on the command record.
    }
    return { label, command: `Get-Process -Name ${nameList}`, exitCode: res.code, facts };
  }

  const res = await runRecorded(ctx, "pgrep", ["-ix", candidates[0]]);
  const pids = res.stdout.trim().split(/\s+/).filter(Boolean);
  return {
    label,
    command: `pgrep -ix ${candidates[0]}`,
    exitCode: res.code,
    facts: { running: pids.length > 0, pid: pids[0] ?? null, process_count: pids.length },
  };
}

function cacheTargetFor(appName) {
  const safeName = String(appName).replace(/[^a-zA-Z0-9 _-]/g, "");
  if (!IS_WINDOWS) return `${os.homedir()}/Library/Caches/${safeName}`;
  const localAppData = process.env.LOCALAPPDATA || `${os.homedir()}\\AppData\\Local`;
  // Browsers keep their cache under User Data profiles, not <app>\Cache.
  const BROWSER_CACHES = {
    edge: `${localAppData}\\Microsoft\\Edge\\User Data\\Default\\Cache`,
    "microsoft edge": `${localAppData}\\Microsoft\\Edge\\User Data\\Default\\Cache`,
    chrome: `${localAppData}\\Google\\Chrome\\User Data\\Default\\Cache`,
    "google chrome": `${localAppData}\\Google\\Chrome\\User Data\\Default\\Cache`,
  };
  return BROWSER_CACHES[safeName.toLowerCase()] ?? `${localAppData}\\${safeName}\\Cache`;
}

// Measured with node's own fs so the numbers are the agent's own reading of
// the disk, not a shell string we have to trust and parse.
function measureDir(target) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // File vanished mid-walk (a cache being written) — skip it.
        }
      }
    }
  };
  if (!fs.existsSync(target)) return { exists: false, files: 0, bytes: 0 };
  walk(target);
  return { exists: true, files, bytes };
}

async function probeCacheDir(_ctx, label, appName) {
  const target = cacheTargetFor(appName);
  const m = measureDir(target);
  return {
    label,
    command: `node:fs measure "${target}"`,
    exitCode: 0,
    facts: {
      path: target,
      exists: m.exists,
      files: m.files,
      size_mb: Number((m.bytes / 1024 ** 2).toFixed(2)),
    },
  };
}

async function probeNetwork(ctx, label) {
  if (IS_WINDOWS) {
    const script =
      `$a = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ` +
      `Sort-Object -Property @{Expression={$_.Status -eq 'Up'}; Descending=$true} | Select-Object -First 1; ` +
      `$cfg = if ($a) { Get-NetIPConfiguration -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue } else { $null }; ` +
      `[PSCustomObject]@{ adapter=$a.Name; status=[string]$a.Status; mac=$a.MacAddress; ` +
      `ipv4=($cfg.IPv4Address.IPAddress -join ','); gateway=($cfg.IPv4DefaultGateway.NextHop -join ',') } | ConvertTo-Json -Compress`;
    const res = await runRecorded(ctx, "powershell", psArgs(script));
    let facts = { adapter: null, status: null, ipv4: null, gateway: null };
    try {
      const parsed = JSON.parse(res.stdout.trim() || "{}");
      facts = {
        adapter: parsed.adapter ?? null,
        status: parsed.status ?? null,
        ipv4: parsed.ipv4 || null,
        gateway: parsed.gateway || null,
      };
    } catch {
      // Fall through with null facts; raw output stays on the command record.
    }
    return { label, command: "Get-NetAdapter + Get-NetIPConfiguration", exitCode: res.code, facts };
  }

  const power = await runRecorded(ctx, "networksetup", ["-getairportpower", "en0"]);
  const addr = await runRecorded(ctx, "ipconfig", ["getifaddr", "en0"]);
  return {
    label,
    command: "networksetup -getairportpower en0 + ipconfig getifaddr en0",
    exitCode: power.code,
    facts: {
      adapter: "en0",
      status: /\bOn\b/i.test(power.stdout) ? "On" : "Off",
      ipv4: addr.stdout.trim() || null,
    },
  };
}

// The resolver configuration is the fact a DNS fix is judged on. `resolvers` is
// the ordered override list (empty when the service is on DHCP-assigned DNS),
// which is exactly what set_dns_servers moves — so the before/after diff of this
// probe IS the proof the fix landed.
async function probeDns(ctx, label, service) {
  if (IS_WINDOWS) {
    const svc = await winDnsService(ctx, service);
    const res = await runRecorded(ctx, "netsh", ["interface", "ipv4", "show", "dnsservers", svc]);
    const addrs = (res.stdout.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).join(",");
    const dhcp = /DHCP/i.test(res.stdout) && !addrs;
    return {
      label,
      command: `netsh interface ipv4 show dnsservers "${svc}"`,
      exitCode: res.code,
      facts: { service: svc, resolvers: dhcp ? "" : addrs, mode: dhcp ? "dhcp" : "static" },
    };
  }
  const svc = await macDnsService(ctx, service);
  const res = await runRecorded(ctx, "networksetup", ["-getdnsservers", svc]);
  // networksetup prints "There aren't any DNS Servers set on <svc>." when the
  // service is back on DHCP-assigned resolvers — that string means empty.
  const isEmpty = /aren't any DNS Servers/i.test(res.stdout);
  const resolvers = isEmpty
    ? ""
    : (res.stdout.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []).join(",");
  return {
    label,
    command: `networksetup -getdnsservers "${svc}"`,
    exitCode: res.code,
    facts: { service: svc, resolvers, mode: isEmpty ? "dhcp" : "static" },
  };
}

// The employee names a symptom, not a network service. Resolve the service the
// fix should act on: the first Wi-Fi/Ethernet service that is actually up, or a
// name the caller passed explicitly.
async function macDnsService(ctx, requested) {
  if (requested && requested !== "auto") return requested;
  const list = await runRecorded(ctx, "networksetup", ["-listallnetworkservices"]);
  const services = list.stdout
    .split(/\r?\n/)
    .slice(1) // first line is an explanatory header
    .map((s) => s.replace(/^\*/, "").trim())
    .filter(Boolean);
  const preferred = services.find((s) => /wi-?fi|airport/i.test(s)) || services.find((s) => /ethernet|lan/i.test(s));
  return preferred || services[0] || "Wi-Fi";
}

// The Windows connection name netsh acts on ("Ethernet", "Ethernet0", "Wi-Fi").
// A VM almost never has a "Wi-Fi" adapter, so defaulting to it is how a DNS fix
// silently targets nothing. Resolve the first physical adapter that is actually
// Up, exactly as probeNetwork does, unless the caller named one explicitly.
async function winDnsService(ctx, requested) {
  if (requested && requested !== "auto") return requested;
  const res = await runRecordedPs(
    ctx,
    `Get-NetAdapter -Physical -ErrorAction SilentlyContinue | ` +
      `Sort-Object -Property @{Expression={$_.Status -eq 'Up'}; Descending=$true} | ` +
      `Select-Object -First 1 -ExpandProperty Name`,
  );
  return res.stdout.trim() || "Ethernet";
}

/** How long a reachability check waits for the host to answer. */
const HTTP_CHECK_TIMEOUT_MS = 8000;

/**
 * Can this machine actually reach a URL?
 *
 * Two facts, kept apart on purpose, because they have different owners:
 * whether the NAME resolved, and whether the HOST answered. "portal.acme.internal
 * did not resolve" is a resolver problem; "it resolved to 192.168.217.1 and the
 * connection was refused" is a server or firewall problem. A single
 * "unreachable" merges them and sends a technician to the wrong one — which is
 * the whole reason `ping` alone was never enough to close an "internet is down"
 * ticket.
 *
 * Done with the agent's own resolver and fetch rather than a shell binary,
 * deliberately: `curl` is on neither platform's read-only allowlist, and putting
 * a general-purpose HTTP client on it would leave a fetch-anything tool one
 * allowlist entry from a fetch-anything-and-print-it tool.
 *
 * NOTHING FROM THE RESPONSE BODY IS RETURNED — only the status, the address the
 * name resolved to, and the error. Page text reaching a planner prompt is
 * exactly what research.ts exists to quarantine, and this read has no distiller,
 * so it does not carry body text at all.
 */
async function probeHttp(ctx, label, args) {
  const raw = String(args?.url || "").trim();
  const facts = {
    url: raw,
    dnsResolved: false,
    address: "none",
    status: "none",
    reachable: false,
    error: "",
  };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    facts.error = "not a URL";
    return { label: `http (${label})`, command: `node:fetch GET ${raw}`, exitCode: -1, facts };
  }

  const startedAt = Date.now();
  try {
    const { address } = await dnsp.lookup(parsed.hostname);
    facts.dnsResolved = true;
    facts.address = address;
  } catch (err) {
    facts.error = `DNS lookup failed: ${err.code || err.message}`;
  }

  if (facts.dnsResolved) {
    try {
      const res = await fetch(parsed.toString(), {
        method: "GET",
        // A redirect is a fact about the host, not something to chase — following
        // one would fetch a URL nobody authorised.
        redirect: "manual",
        signal: AbortSignal.timeout(HTTP_CHECK_TIMEOUT_MS),
      });
      facts.status = String(res.status);
      // Any HTTP answer means the host is reachable. A 404 is a working server
      // with a missing page, and calling that "unreachable" would be a lie.
      facts.reachable = true;
      // Drain and discard: an unconsumed body holds the socket open until the
      // timeout, and the contents are deliberately never reported.
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      facts.error =
        err.name === "TimeoutError"
          ? `no response within ${HTTP_CHECK_TIMEOUT_MS}ms`
          : err.cause?.code || err.message;
    }
  }

  // Recorded like any spawned command so the audit page shows what was attempted
  // even though no binary ran.
  ctx.commands.push({
    argv: ["node:fetch", "GET", parsed.toString()],
    exitCode: facts.reachable ? 0 : 1,
    stdout: `dns=${facts.dnsResolved ? facts.address : "unresolved"} status=${facts.status}`,
    stderr: facts.error,
    durationMs: Date.now() - startedAt,
  });

  return {
    label: `http (${label})`,
    command: `node:fetch GET ${parsed.toString()}`,
    exitCode: facts.reachable ? 0 : 1,
    facts,
  };
}

// ---- actions ---------------------------------------------------------------
// Each action returns { ok, error?, note? }. It never decides whether it
// "worked" — that verdict comes from the probes taken around it.

async function actRestartApp(ctx, { app }) {
  return IS_WINDOWS ? restartAppWindows(ctx, app) : restartAppMac(ctx, app);
}

async function restartAppMac(ctx, appName) {
  await runRecorded(ctx, "osascript", ["-e", `tell application "${appName}" to quit`]);
  await new Promise((r) => setTimeout(r, 1500));
  const open = await runRecorded(ctx, "open", ["-a", appName]);
  if (open.code !== 0) {
    return { ok: false, error: `open -a "${appName}" failed: ${open.stderr.trim() || open.code}` };
  }
  await new Promise((r) => setTimeout(r, 1500));
  return { ok: true };
}

async function restartAppWindows(ctx, appName) {
  // Friendly names ("Microsoft Outlook") usually aren't launchable as-is on
  // Windows — try progressively simpler candidates until one starts.
  const candidates = appNameCandidates(appName);
  const nameList = candidates.map((c) => `'${c}'`).join(",");

  const stop = await runRecordedPs(
    ctx,
    `$p = Get-Process -Name ${nameList} -ErrorAction SilentlyContinue; ` +
      `if ($p) { $p | Stop-Process -Force; 'stopped=' + @($p).Count } else { 'stopped=0' }`,
  );
  const stopped = Number(stop.stdout.match(/stopped=(\d+)/)?.[1] ?? 0);
  await new Promise((r) => setTimeout(r, 1500));

  for (const cand of candidates) {
    const start = await runRecordedPs(
      ctx,
      `try { Start-Process "${cand}" -ErrorAction Stop; exit 0 } catch { Write-Error $_.Exception.Message; exit 1 }`,
    );
    if (start.code === 0) {
      await new Promise((r) => setTimeout(r, 1500));
      return { ok: true, note: `stopped ${stopped} process(es), started "${cand}"` };
    }
  }
  return {
    ok: false,
    error:
      `Could not start "${appName}" under any name (tried: ${candidates.join(", ")}). ` +
      `The app may not be installed on this machine, or needs a full .exe path.`,
  };
}

async function actClearAppCache(ctx, { app }) {
  const target = cacheTargetFor(app);
  if (!fs.existsSync(target)) {
    return { ok: true, note: `no cache directory at ${target} — nothing to clear` };
  }
  if (IS_WINDOWS) {
    const res = await runRecordedPs(
      ctx,
      `try { Remove-Item -Recurse -Force "${target}" -ErrorAction Stop; exit 0 } catch { Write-Error $_.Exception.Message; exit 1 }`,
    );
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || `exit ${res.code}` };
  } else {
    const res = await runRecorded(ctx, "rm", ["-rf", target]);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || `exit ${res.code}` };
  }
  return { ok: true, note: `removed ${target}` };
}

// Cycling an adapter returns it to its original state, so before/after alone
// would look like nothing happened. The mid probe — taken while the adapter is
// down — is what proves the link really went away and came back.
//
// On a VM this cuts the agent's own link to the server for a few seconds. That
// is fine: the journal is written locally first, and the upload happens after
// the adapter is back up.
async function actToggleWifi(ctx, _args, helpers) {
  if (IS_WINDOWS) {
    const adapter = ctx.probes[0]?.facts?.adapter;
    if (!adapter) {
      return { ok: false, error: "no physical network adapter found to cycle" };
    }
    const disable = await runRecordedPs(
      ctx,
      `try { Disable-NetAdapter -Name "${psEscape(adapter)}" -Confirm:$false -ErrorAction Stop; exit 0 } ` +
        `catch { Write-Error $_.Exception.Message; exit 1 }`,
    );
    if (disable.code !== 0) {
      return {
        ok: false,
        error: disable.stderr.trim() || "disabling the adapter failed — run the agent as Administrator",
      };
    }
    await helpers.probeNow("adapter (while down)");
    const enable = await runRecordedPs(
      ctx,
      `try { Enable-NetAdapter -Name "${psEscape(adapter)}" -Confirm:$false -ErrorAction Stop; exit 0 } ` +
        `catch { Write-Error $_.Exception.Message; exit 1 }`,
    );
    if (enable.code !== 0) return { ok: false, error: enable.stderr.trim() || "re-enabling the adapter failed" };
    await new Promise((r) => setTimeout(r, 4000));
    return { ok: true, note: `cycled adapter "${adapter}"` };
  }

  const off = await runRecorded(ctx, "networksetup", ["-setairportpower", "en0", "off"]);
  if (off.code !== 0) return { ok: false, error: off.stderr.trim() || `exit ${off.code}` };
  await helpers.probeNow("adapter (while down)");
  const on = await runRecorded(ctx, "networksetup", ["-setairportpower", "en0", "on"]);
  if (on.code !== 0) return { ok: false, error: on.stderr.trim() || `exit ${on.code}` };
  await new Promise((r) => setTimeout(r, 3000));
  return { ok: true, note: "cycled en0" };
}

// Set (or clear) the DNS resolvers on a network service. servers="empty"
// restores the DHCP-assigned resolvers — that is the reversal, and it is the
// same command with a different argument, so a wrong resolver is undone by
// re-running with the value the probe recorded before the change.
async function actSetDnsServers(ctx, { service, servers }) {
  const wanted = String(servers || "empty");
  const list = wanted === "empty" ? [] : wanted.split(",").filter(Boolean);

  if (IS_WINDOWS) {
    const svc = await winDnsService(ctx, service);
    if (list.length === 0) {
      const res = await runRecorded(ctx, "netsh", ["interface", "ipv4", "set", "dnsservers", svc, "dhcp"]);
      if (res.code !== 0) return { ok: false, error: res.stderr.trim() || `exit ${res.code} — run the agent as Administrator` };
    } else {
      const first = await runRecorded(ctx, "netsh", ["interface", "ipv4", "set", "dnsservers", svc, "static", list[0], "primary"]);
      if (first.code !== 0) return { ok: false, error: first.stderr.trim() || `exit ${first.code} — run the agent as Administrator` };
      for (let i = 1; i < list.length; i++) {
        await runRecorded(ctx, "netsh", ["interface", "ipv4", "add", "dnsservers", svc, list[i], `index=${i + 1}`]);
      }
    }
    return { ok: true, note: `set ${svc} DNS to ${list.length ? list.join(", ") : "DHCP"}` };
  }

  const svc = await macDnsService(ctx, service);
  // networksetup takes "empty" as a literal to clear the override.
  const args = list.length === 0 ? ["-setdnsservers", svc, "empty"] : ["-setdnsservers", svc, ...list];
  const res = await runRecorded(ctx, "networksetup", args);
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || `exit ${res.code}` };
  return { ok: true, note: `set ${svc} DNS to ${list.length ? list.join(", ") : "DHCP-assigned"}` };
}

/**
 * Put the resolver list back the way the before-probe found it.
 *
 * The registry has advertised `reversible: "recorded"` for set_dns_servers since
 * it was written, and `revertFor` has printed the exact undo command onto the
 * ticket — but the handler had no `rollback`, and the transaction in
 * `executeJob` is gated on `handler.rollback`. So a DNS change that did not take
 * was left wherever it landed while the ladder went on ordering it as the
 * cheapest thing to be wrong about.
 */
async function rollbackSetDns(ctx, args, before) {
  const prior = before?.facts;
  if (!prior || typeof prior.resolvers !== "string") {
    return { ok: false, error: "no prior resolver list was captured" };
  }
  // "dhcp" means there was no override at all, and the way to restore THAT is
  // the literal "empty" — not an address list, which would install a new
  // override in the name of undoing one.
  const servers = prior.mode === "dhcp" || !prior.resolvers ? "empty" : prior.resolvers;
  return actSetDnsServers(ctx, { service: prior.service ?? args.service, servers });
}

// Flush the resolver cache. Deliberately expectsChange:false — a cache flush
// leaves no stable before/after fact to diff, so it is recorded as an action
// that ran, never as a verified change. The verifiable fix is set_dns_servers;
// this supports it.
async function actFlushDns(ctx) {
  if (IS_WINDOWS) {
    const res = await runRecorded(ctx, "ipconfig", ["/flushdns"]);
    return res.code === 0
      ? { ok: true, note: "flushed the Windows DNS resolver cache" }
      : { ok: false, error: res.stderr.trim() || `exit ${res.code}` };
  }
  const flush = await runRecorded(ctx, "dscacheutil", ["-flushcache"]);
  const hup = await runRecorded(ctx, "killall", ["-HUP", "mDNSResponder"]);
  if (flush.code !== 0 && hup.code !== 0) {
    return { ok: false, error: hup.stderr.trim() || flush.stderr.trim() || "flush failed — may need sudo" };
  }
  return { ok: true, note: "flushed the macOS DNS cache and signalled mDNSResponder" };
}

// ---- read-only collectors --------------------------------------------------

async function collectSystemInfo(ctx) {
  return IS_WINDOWS ? collectSystemInfoWindows(ctx) : collectSystemInfoMac(ctx);
}

async function collectSystemInfoWindows(ctx) {
  const lines = [`hostname: ${os.hostname()}`];
  const script = [
    "$osInfo = Get-CimInstance Win32_OperatingSystem",
    "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1",
    "$cs = Get-CimInstance Win32_ComputerSystem",
    "[PSCustomObject]@{",
    "  computer_name = $cs.Name",
    "  os_caption = $osInfo.Caption",
    "  os_version = $osInfo.Version",
    "  os_build = $osInfo.BuildNumber",
    "  arch = $osInfo.OSArchitecture",
    "  total_ram_bytes = $cs.TotalPhysicalMemory",
    "  free_ram_kib = $osInfo.FreePhysicalMemory",
    "  cpu_name = $cpu.Name",
    "  cpu_cores = $cpu.NumberOfCores",
    "  uptime_seconds = [int]((Get-Date) - $osInfo.LastBootUpTime).TotalSeconds",
    "} | ConvertTo-Json -Compress",
  ].join("\n");

  const res = await runRecordedPs(ctx, script);
  if (res.code === 0 && res.stdout.trim()) {
    try {
      const info = JSON.parse(res.stdout.trim());
      lines.push(`computer_name: ${info.computer_name}`);
      lines.push(`os: ${info.os_caption} ${info.os_version} (build ${info.os_build}, ${info.arch})`);
      lines.push(`ram_total: ${(info.total_ram_bytes / 1024 ** 3).toFixed(2)} GiB`);
      lines.push(`ram_free: ${((info.free_ram_kib * 1024) / 1024 ** 3).toFixed(2)} GiB`);
      lines.push(`cpu: ${info.cpu_name} (${info.cpu_cores} cores)`);
      lines.push(`uptime: ${formatUptime(info.uptime_seconds ?? 0)}`);
      return { ok: true, output: lines.join("\n") };
    } catch (err) {
      lines.push(`PowerShell system-info query returned unparseable output: ${err.message}`);
    }
  } else {
    lines.push(`PowerShell system-info query failed: ${res.stderr.trim() || res.code}`);
  }
  lines.push(`ram_total: ${(os.totalmem() / 1024 ** 3).toFixed(2)} GiB`);
  lines.push(`ram_free: ${(os.freemem() / 1024 ** 3).toFixed(2)} GiB`);
  return { ok: true, output: lines.join("\n") };
}

async function collectSystemInfoMac(ctx) {
  const lines = [];
  const cn = await runRecorded(ctx, "scutil", ["--get", "ComputerName"]);
  lines.push(`computer_name: ${cn.code === 0 ? cn.stdout.trim() : os.hostname()}`);
  lines.push(`hostname: ${os.hostname()}`);

  const sw = await runRecorded(ctx, "sw_vers", []);
  if (sw.code === 0) {
    for (const line of sw.stdout.trim().split(/\r?\n/)) {
      lines.push(line.trim().toLowerCase().replace(/:\s*/, ": "));
    }
  } else {
    lines.push(`os: ${os.platform()} ${os.release()} (${os.arch()})`);
  }

  lines.push(`ram_total: ${(os.totalmem() / 1024 ** 3).toFixed(2)} GiB`);
  lines.push(`ram_free: ${(os.freemem() / 1024 ** 3).toFixed(2)} GiB`);
  lines.push(`cpu: ${os.cpus()?.[0]?.model ?? "unknown"} (${os.cpus()?.length ?? "?"} cores)`);
  lines.push(`uptime: ${formatUptime(Math.round(os.uptime()))}`);

  const sp = await runRecorded(ctx, "system_profiler", ["SPHardwareDataType"]);
  if (sp.code === 0) {
    for (const raw of sp.stdout.split(/\r?\n/)) {
      const m = raw
        .trim()
        .match(/^(Model Name|Model Identifier|Chip|Processor Name|Serial Number \(system\)|Hardware UUID):\s*(.+)$/);
      if (m) lines.push(`${m[1].toLowerCase().replace(/[ ()]+/g, "_").replace(/_+$/, "")}: ${m[2]}`);
    }
  }
  return { ok: true, output: lines.join("\n") };
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${mins}m`;
}

// Real Windows Application event log for a given app.
async function collectAppEventLogs(ctx, { app, limit }) {
  if (!IS_WINDOWS) {
    const res = await runRecorded(ctx, "log", ["show", "--last", "30m", "--style", "compact"]);
    const lines = (res.stdout || "")
      .split(/\r?\n/)
      .filter((l) => l.toLowerCase().includes(String(app).toLowerCase()))
      .slice(0, limit);
    return {
      ok: true,
      output: lines.length ? lines.join("\n") : `no recent unified-log entries mentioning "${app}"`,
    };
  }
  const safe = psEscape(app);
  const script =
    `Get-WinEvent -FilterHashtable @{LogName='Application'; Level=1,2,3; StartTime=(Get-Date).AddDays(-1)} ` +
    `-MaxEvents 200 -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.ProviderName -like "*${safe}*" -or $_.Message -like "*${safe}*" } | ` +
    `Select-Object -First ${limit} TimeCreated, LevelDisplayName, ProviderName, ` +
    `@{n='Msg';e={($_.Message -split [Environment]::NewLine)[0]}} | ` +
    `Format-Table -AutoSize | Out-String -Width 200`;
  const res = await runRecordedPs(ctx, script);
  const out = (res.stdout || "").trim();
  return {
    ok: true,
    output: out || `no Application-log errors/warnings mentioning "${app}" in the last day`,
  };
}

// ---- open read surface -----------------------------------------------------
// Differential diagnosis needs evidence variety: a hypothesis is only worth
// forming if something can kill it. Three app-scoped probes can't kill much, so
// these widen what can be observed — without adding any way to change the
// machine. Every binary below is read-only, and runShell never uses a shell, so
// there is nothing here for a metacharacter to act on.

const READ_ONLY_BINARIES = IS_WINDOWS
  ? {
      systeminfo: {},
      ipconfig: {},
      netstat: {},
      nslookup: {},
      // Reachability diagnostics. Read-only — they send probe packets and print,
      // they change nothing. The macOS branch has had ping/traceroute/dig since
      // the start; leaving them off the Windows branch was a plain omission, and
      // it is why a "can't reach the VPN / a host" ticket had nothing to run.
      // Windows `ping` sends 4 and exits; `tracert` is hop-bounded. `-t` is an
      // infinite ping and the agent has no per-command timeout, so it is denied
      // — the one way this read could hang the poll loop.
      ping: { deniedArgs: [/^-t$/i, /^\/t$/i] },
      tracert: {},
      pathping: {},
      tasklist: {},
      whoami: {},
      hostname: {},
      certutil: { subcommands: ["-store"] },
      powershell: { getCmdletOnly: true },
      // Widened read surface. Every entry below observes state; none mutate.
      dsregcmd: { subcommands: ["/status"] },
      gpresult: { subcommands: ["/r", "/z"] },
      driverquery: {},
      sc: { subcommands: ["query", "qc", "queryex"] },
      // `minArgs` because `reg query` on its own is not a read, it is a usage
      // error — and the machine answers "ERROR: Invalid syntax", which reads to
      // the operator as a command it spelled wrong. T-5009 re-sent the identical
      // argv four times chasing that, twice after a strategist round. The
      // refusal below names the missing part instead, so the retry can differ.
      reg: { subcommands: ["query"], minArgs: 2 },
      // Session/user listing. qwinsta lists sessions; quser lists the logged-on
      // users on them (name, state, idle time). Both are read-only — they print
      // and change nothing — and "who else is sharing this machine's CPU" is a
      // standard slowness check. quser was the omission; qwinsta alone left the
      // agent looping when the operator reached for the more natural command.
      qwinsta: {},
      quser: {},
      powercfg: { subcommands: ["/query", "/list", "/batteryreport"] },
      wevtutil: { subcommands: ["qe", "el", "gli"] },
      net: { subcommands: ["config", "user", "share", "statistics"] },
      route: { subcommands: ["print"] },
      arp: { subcommands: ["-a"] },
      fsutil: { subcommands: ["fsinfo", "volume"] },
      // Query verbs only. `winget install`/`uninstall`/`upgrade` are writes and
      // are absent from this list, so they are refused here by the same
      // subcommand check as everything else — installing goes through the
      // `install_package` handler, which is risk 3 and gated.
      winget: { subcommands: ["list", "show", "search"] },
      // Restricted. Unqualified `wmic` is not read-only: `wmic process call
      // create` starts a process, and `wmic product call install` installs
      // software. It was sitting in the READ-ONLY allowlist with no subcommand
      // filter at all, which made it the one genuine write in a list whose
      // entire premise is that nothing in it writes.
      wmic: {
        subcommands: [
          "os", "cpu", "computersystem", "bios", "diskdrive", "logicaldisk",
          "memorychip", "nic", "nicconfig", "process", "service", "startup",
          "qfe", "product", "printer", "useraccount", "path",
        ],
        deniedArgs: [/^call$/i, /^create$/i, /^delete$/i, /^set$/i, /^assoc$/i],
      },
    }
  : {
      sw_vers: {},
      uname: {},
      uptime: {},
      whoami: {},
      hostname: {},
      ps: {},
      df: {},
      du: {},
      ls: {},
      stat: {},
      file: {},
      ifconfig: {},
      netstat: {},
      route: { subcommands: ["-n", "get"] },
      scutil: { subcommands: ["--dns", "--proxy", "--nwi"] },
      dig: {},
      host: {},
      nslookup: {},
      ping: {},
      traceroute: {},
      lsof: {},
      sysctl: {},
      pmset: { subcommands: ["-g"] },
      system_profiler: {},
      diskutil: { subcommands: ["list", "info"] },
      defaults: { subcommands: ["read", "read-type", "domains"] },
      plutil: { subcommands: ["-p"] },
      codesign: { subcommands: ["-dv", "--display"] },
      security: { subcommands: ["find-certificate", "list-keychains"] },
      softwareupdate: { subcommands: ["--list", "-l"] },
      log: { subcommands: ["show", "stats"] },
      networksetup: {
        subcommands: [
          "-listallnetworkservices",
          "-getinfo",
          "-getairportpower",
          "-getdnsservers",
        ],
      },
      // Widened read surface. Every entry below observes state; none mutate.
      launchctl: { subcommands: ["list", "print", "print-disabled", "dumpstate"] },
      mdfind: {},
      vm_stat: {},
      top: { subcommands: ["-l"] },
      arp: {},
      ioreg: {},
      kextstat: {},
      csrutil: { subcommands: ["status"] },
      fdesetup: { subcommands: ["status", "list"] },
      spctl: { subcommands: ["--status", "--assess"] },
      profiles: { subcommands: ["-P", "show", "list"] },
      tmutil: { subcommands: ["status", "destinationinfo", "latestbackup"] },
      nettop: { subcommands: ["-l", "-x"] },
      // `.` is a valid first token, so the subcommand check alone lets
      // `dscl . -create /Users/x` straight through — a write, in the read-only
      // allowlist. deniedArgs is checked across EVERY token, not just argv[0].
      dscl: {
        subcommands: [".", "-read", "-list", "-readall", "-search"],
        deniedArgs: [/^-create$/i, /^-delete$/i, /^-append$/i, /^-merge$/i, /^-change$/i, /^-passwd$/i],
      },
      lsappinfo: {},
      pkgutil: { subcommands: ["--pkgs", "--pkg-info", "--files"] },
      xcrun: { subcommands: ["--find", "--show-sdk-version"] },
      last: {},
      w: {},
      id: {},
      groups: {},
      env: {},
      mount: {},
      nvram: { subcommands: ["-p", "-x"] },
    };

// Spaces are excluded deliberately: it keeps every argument a single token, so
// the audit string in the job record is exactly the argv that ran. Paths
// containing spaces are the known cost of that, and worth it.
// Backslash and space are allowed: a Windows registry key has both, and every
// command here is spawned as argv with no shell, so neither character can act
// on anything. Quotes, newlines, nulls and shell metacharacters stay out — they
// buy nothing here and would make the audit line ambiguous. This must stay in
// step with `argvToken` in src/lib/capabilities/registry.ts: a token the server
// will build and this rejects is a step that can never run.
// `*` added in step with `argvToken` in registry.ts: a wildcard is how you ask
// Windows about a device by name (`Get-PnpDevice -FriendlyName *Camera*`) and it
// was the only character stopping that read. argv is spawned directly, never
// through a shell, so there is nothing here to expand a glob but the binary
// itself. Quotes, ; | & $ ( ) stay out.
const SAFE_ARG = /^[A-Za-z0-9._\-/:@=+,%*[\]\\ ]+$/;

// Enforced no matter which root a path sits under. Reading a credential store
// is never diagnostics.
const DENIED_ARG = /(\.ssh|\.aws|\.gnupg|keychain|cookies|login ?data|\.env|id_rsa|id_ed25519|id_ecdsa|credentials|secring|\.netrc|shadow)/i;

// ---- grantable read surface -------------------------------------------------
// Read-only binaries that are NOT on by default, and that a named human can
// switch on for ONE ticket through the approval gate.
//
// This is not a way in for arbitrary commands, and it must never become one. It
// is a second closed list with the same read-only premise as the first — the
// only difference is that reaching for one of these costs a person's decision
// instead of being free. The failure it exists to prevent is the one seen on
// T-8805: the strategist asks a reasonable diagnostic question, the binary is
// not on the list, the step dies, and three rounds later the ticket reaches a
// human having tested nothing at all.
//
// A binary belongs here only if it cannot change the machine. Every entry keeps
// its subcommand filter, and every argument still goes through SAFE_ARG and
// DENIED_ARG, so a grant widens WHICH binary may run and nothing else.
const GRANTABLE_BINARIES = IS_WINDOWS
  ? {
      // `netsh show`/`dump` print configuration; every mutating verb it has
      // (set/add/delete/reset/import) is absent from this list and therefore
      // refused by the same subcommand check as everything else.
      netsh: { subcommands: ["show", "dump"] },
      nltest: { subcommands: ["/dsgetdc:", "/sc_query:", "/dclist:"] },
      w32tm: { subcommands: ["/query"] },
      openfiles: { subcommands: ["/query"] },
    }
  : {
      // `nettop` and `vm_stat` are on the default list already, so they are not
      // repeated here — a binary in both lists would be reachable without the
      // grant, and a grantable list nobody can trust to be exhaustive is worse
      // than none.
      dscacheutil: { subcommands: ["-statistics", "-configuration"] },
      networkQuality: {},
    };

/**
 * @param binary   the binary being asked for
 * @param argv     its arguments
 * @param granted  binaries a human approved for THIS ticket, from job.grantedBinaries
 */
function validateReadOnlyCommand(binary, argv, granted = []) {
  const spec =
    READ_ONLY_BINARIES[binary] ??
    // Only when a person approved this exact binary for this ticket AND it is
    // on the curated grantable list. A grant naming something outside that list
    // buys nothing — that is what stops an approval prompt becoming a way to
    // run anything by talking a technician into one click.
    (granted.includes(binary) ? GRANTABLE_BINARIES[binary] : undefined);
  if (!spec) {
    // The marker is load-bearing: the server reads it to tell "this binary could
    // be approved" apart from "this binary is not a read". Without it a
    // grantable refusal is indistinguishable from a typo and the step just dies.
    const grantable = Boolean(GRANTABLE_BINARIES[binary]);
    return grantable
      ? `GRANTABLE:${binary}:"${binary}" is not enabled by default and needs a technician's approval for this ticket`
      : `"${binary}" is not on the read-only binary allowlist`;
  }
  if (argv.length > 12) return "too many arguments";
  for (const a of argv) {
    if (a.length > 256) return "argument too long";
    if (!SAFE_ARG.test(a)) return `argument ${JSON.stringify(a)} contains disallowed characters`;
    if (DENIED_ARG.test(a)) return `argument ${JSON.stringify(a)} targets a credential store`;
  }
  if (spec.subcommands && !spec.subcommands.includes(argv[0])) {
    return `"${binary}" allows only: ${spec.subcommands.join(", ")}`;
  }
  // A command that is missing an operand is not a spelling mistake, and the
  // binary's own "Invalid syntax" cannot say which. Naming the gap here is what
  // lets the next attempt be a DIFFERENT command rather than the same one.
  if (spec.minArgs && argv.length < spec.minArgs) {
    return `"${binary} ${argv.join(" ")}" is incomplete — ${binary} needs at least ${spec.minArgs} arguments (e.g. the key or path to read)`;
  }
  // Checked across every token rather than just the first. Some binaries take a
  // harmless-looking first argument and the mutating verb later — `dscl . -create`
  // and `wmic process call create` both pass a first-token check and both write.
  for (const denied of spec.deniedArgs ?? []) {
    const hit = argv.find((a) => denied.test(a));
    if (hit) return `"${binary} ${hit}" is a write, and this is the read-only surface`;
  }
  if (spec.getCmdletOnly && !/^Get-[A-Za-z]+$/.test(argv[0] ?? "")) {
    return `"${binary}" allows only Get-* cmdlets`;
  }
  return null;
}

async function collectCommandOutput(ctx, { binary, argv }, job) {
  // Grants are carried on the job, not parsed out of the command string: the
  // command is what the model composed, and a grant is what a person decided.
  // Keeping them on separate rails means no phrasing of the former can forge
  // the latter.
  const granted = Array.isArray(job?.grantedBinaries) ? job.grantedBinaries : [];
  const rejection = validateReadOnlyCommand(binary, argv, granted);
  if (rejection) return { ok: false, error: rejection };

  const res = await runRecorded(ctx, binary, argv);
  const stdout = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();
  if (!stdout && stderr) {
    return { ok: false, error: `${binary} exited ${res.code}: ${stderr.slice(0, 400)}` };
  }
  return {
    ok: true,
    output: stdout.slice(0, 6000) || `${binary} produced no output (exit ${res.code})`,
  };
}

// ---- filesystem read surface ------------------------------------------------
// AUTONOMY=full posture: no root allowlist. The agent reads anywhere the user
// account can reach. Two things survive that, because neither costs autonomy:
//
//   1. A credential-store refusal. In a disposable VM it is noise; on a real
//      laptop it is the difference between a diagnostic log and your SSH key in
//      a transcript. Set AGENT_UNSAFE=1 to drop it.
//   2. Redaction of anything key-shaped on the way out. The model still sees
//      THAT a file holds a credential, just not the credential.
//
// Both are read-path only. Neither can stop a step from running.

const GUARD_CREDENTIALS = process.env.AGENT_UNSAFE !== "1";
const MAX_READ_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 300;
const MAX_GREP_MATCHES = 200;

const DENIED_PATH =
  /(\.ssh|\.aws|\.gnupg|\.netrc|id_rsa|id_ed25519|id_ecdsa|\.kdbx|Keychains|\.keychain|Cookies|Login Data|chat\.db|\.env($|\.)|credentials$|secring|shadow|\.kube|\.docker\/config)/i;

// SECRET_PATTERNS and redactSecrets now live in ./redact.mjs, imported above.
// They used to be here and were applied to exactly two of the ten read paths;
// `redactDeep` is now applied to the whole envelope on the way out, so a field
// added later is covered by default rather than by somebody remembering.

// realpath FIRST, then judge. Checking a raw string lets a symlink or a `..`
// decide what you actually opened.
function resolveTarget(raw) {
  let p = String(raw || "").trim();
  if (!p) return { error: "path is required" };
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(p));
  } catch (err) {
    return { error: `cannot resolve ${p}: ${err.code || err.message}` };
  }
  if (GUARD_CREDENTIALS && DENIED_PATH.test(resolved)) {
    return {
      error: `${resolved} is a credential store — refused. Set AGENT_UNSAFE=1 on the agent to allow it.`,
    };
  }
  return { path: resolved };
}

function recordFsAccess(ctx, verb, target, note) {
  ctx.commands.push({
    argv: [verb, target],
    exitCode: 0,
    // Coerce: a caller that passes a number here (fs_find did) must not crash
    // the whole job on `.slice`. The audit record is best-effort text.
    stdout: String(note ?? "").slice(0, 4000),
    stderr: "",
    durationMs: 0,
  });
}

async function collectFsList(ctx, { fsPath }) {
  const t = resolveTarget(fsPath);
  if (t.error) return { ok: false, error: t.error };
  let entries;
  try {
    entries = fs.readdirSync(t.path, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `cannot list ${t.path}: ${err.code || err.message}` };
  }
  const rows = entries.slice(0, MAX_LIST_ENTRIES).map((e) => {
    let size = "-";
    if (e.isFile()) {
      try {
        size = String(fs.statSync(path.join(t.path, e.name)).size);
      } catch {
        size = "?";
      }
    }
    return `${e.isDirectory() ? "d" : "-"} ${size.padStart(10)}  ${e.name}`;
  });
  const more =
    entries.length > MAX_LIST_ENTRIES ? `\n… ${entries.length - MAX_LIST_ENTRIES} more entries` : "";
  recordFsAccess(ctx, "fs_list", t.path, `${entries.length} entries`);
  return { ok: true, output: `${t.path}\n${rows.join("\n")}${more}` };
}

async function collectFsRead(ctx, { fsPath, lines }) {
  const t = resolveTarget(fsPath);
  if (t.error) return { ok: false, error: t.error };
  let stat;
  try {
    stat = fs.lstatSync(t.path);
  } catch (err) {
    return { ok: false, error: `cannot stat ${t.path}: ${err.code || err.message}` };
  }
  if (!stat.isFile()) return { ok: false, error: `${t.path} is not a regular file` };

  let buf;
  try {
    buf = fs.readFileSync(t.path);
  } catch (err) {
    return { ok: false, error: `cannot read ${t.path}: ${err.code || err.message}` };
  }
  const slice = buf.subarray(0, MAX_READ_BYTES);
  if (slice.includes(0)) {
    return { ok: false, error: `${t.path} looks binary (${buf.length} bytes) — not read` };
  }
  const all = slice.toString("utf8").split(/\r?\n/);
  const kept = all.slice(0, lines);
  const notes = [];
  if (buf.length > MAX_READ_BYTES) notes.push(`truncated at ${MAX_READ_BYTES} bytes of ${buf.length}`);
  if (all.length > kept.length) notes.push(`showing ${kept.length} of ${all.length} lines`);
  recordFsAccess(ctx, "fs_read", t.path, `${buf.length} bytes, ${all.length} lines`);
  return {
    ok: true,
    output: `${t.path}${notes.length ? ` (${notes.join("; ")})` : ""}\n${redactSecrets(kept.join("\n"))}`,
  };
}

async function collectFsGrep(ctx, { fsPath, pattern }) {
  const t = resolveTarget(fsPath);
  if (t.error) return { ok: false, error: t.error };
  if (!pattern) return { ok: false, error: "pattern is required" };

  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch (err) {
    return { ok: false, error: `bad pattern: ${err.message}` };
  }

  const files = [];
  let stat;
  try {
    stat = fs.statSync(t.path);
  } catch (err) {
    return { ok: false, error: `cannot stat ${t.path}: ${err.code || err.message}` };
  }
  if (stat.isFile()) {
    files.push(t.path);
  } else {
    // One level only. Recursion here turns a typo into a whole-disk scan.
    let entries = [];
    try {
      entries = fs.readdirSync(t.path, { withFileTypes: true });
    } catch (err) {
      return { ok: false, error: `cannot list ${t.path}: ${err.code || err.message}` };
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = path.join(t.path, e.name);
      if (GUARD_CREDENTIALS && DENIED_PATH.test(full)) continue;
      files.push(full);
      if (files.length >= 200) break;
    }
  }

  const hits = [];
  for (const f of files) {
    let buf;
    try {
      buf = fs.readFileSync(f);
    } catch {
      continue;
    }
    const slice = buf.subarray(0, MAX_READ_BYTES);
    if (slice.includes(0)) continue;
    const rows = slice.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < rows.length; i++) {
      if (!re.test(rows[i])) continue;
      hits.push(`${f}:${i + 1}: ${rows[i].slice(0, 400)}`);
      if (hits.length >= MAX_GREP_MATCHES) break;
    }
    if (hits.length >= MAX_GREP_MATCHES) break;
  }

  recordFsAccess(ctx, "fs_grep", t.path, `${hits.length} matches in ${files.length} files`);
  return {
    ok: true,
    output: hits.length
      ? redactSecrets(hits.join("\n"))
      : `no match for /${pattern}/i in ${files.length} file(s) under ${t.path}`,
  };
}

async function collectProcessList(ctx) {
  if (IS_WINDOWS) {
    const res = await runRecordedPs(
      ctx,
      `Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 30 ` +
        `Id, ProcessName, CPU, @{n='MemMB';e={[math]::Round($_.WorkingSet64/1MB,1)}} | ` +
        `Format-Table -AutoSize | Out-String -Width 200`,
    );
    return { ok: true, output: (res.stdout || "").trim() || "no processes returned" };
  }
  // -r sorts by current CPU, so the interesting rows are at the top.
  const res = await runRecorded(ctx, "ps", ["axo", "pid,pcpu,pmem,etime,comm", "-r"]);
  const lines = (res.stdout || "").split(/\r?\n/).slice(0, 31);
  return { ok: true, output: lines.join("\n").trim() || "no processes returned" };
}

async function collectNetworkState(ctx) {
  const sections = [];
  const add = (title, text, limit) => {
    const body = (text || "").trim();
    if (body) sections.push(`## ${title}\n${body.slice(0, limit)}`);
  };

  if (IS_WINDOWS) {
    add("Interfaces", (await runRecorded(ctx, "ipconfig", ["/all"])).stdout, 2500);
    add("Routes", (await runRecorded(ctx, "netstat", ["-rn"])).stdout, 1200);
    add("TCP", (await runRecorded(ctx, "netstat", ["-ano", "-p", "tcp"])).stdout, 1500);
  } else {
    add("Interfaces", (await runRecorded(ctx, "ifconfig", [])).stdout, 2500);
    add("Routes", (await runRecorded(ctx, "netstat", ["-rn", "-f", "inet"])).stdout, 1200);
    add("DNS resolvers", (await runRecorded(ctx, "scutil", ["--dns"])).stdout, 1500);
    add("Listening TCP", (await runRecorded(ctx, "netstat", ["-an", "-p", "tcp"])).stdout, 1500);
  }

  return {
    ok: true,
    output: sections.join("\n\n") || "no network state could be read",
  };
}

// ---- handler table ---------------------------------------------------------
// `expectsChange: true` means the job is a fix: if the before/after probes
// match, the server records `no_effect` instead of success.


// ---- consent, capture, and the interactive session -------------------------
//
// THE SESSION 0 PROBLEM, because it is silent and it bites twice.
//
// On Windows the agent runs as a scheduled task, which puts it in session 0.
// Session 0 has its own invisible desktop. A dialog raised from there does not
// error — it renders where nobody can see it, waits out its timeout, and
// returns "no answer". A screen capture taken from there does not error either;
// it captures the empty session-0 desktop.
//
// So BOTH the consent prompt and the capture have to run inside the logged-on
// user's session, and both go through the same helper. That is one piece of
// work, not two.
//
// The distinction that keeps this honest: "the employee said no" and "we could
// not ask them" are different answers with different owners. A missing session
// is `dependency_unavailable`, never `policy_block`. Collapsing them would make
// a broken helper look exactly like a person declining, on every screenshot,
// forever — and nobody would ever find it.

const CONSENT_TIMEOUT_S = 60;

function noInteractiveSession(reason) {
  return { ok: false, error: `NO_SESSION: ${reason}`, noSession: true };
}

/** Ask the employee, on their own screen, in their own session. */
async function askConsent(ctx, job) {
  const ticketId = String(job?.ticketId || "this ticket").replace(/[^A-Za-z0-9-]/g, "");
  const who = String(job?.targetUserEmail || "IT support").replace(/[^A-Za-z0-9@._-]/g, "");
  const message =
    `IT support is troubleshooting ticket ${ticketId} and is asking to take ONE screenshot ` +
    `of your screen. Nothing is captured unless you allow it. Requested for: ${who}`;

  if (IS_MAC) {
    // osascript already runs in the user's GUI session on macOS. It fails
    // loudly with -1719 when there is no window server to talk to, which is the
    // "cannot ask" case rather than a refusal.
    const script =
      `display dialog "${psEscape(message)}" with title "Screenshot request" ` +
      `buttons {"Deny","Allow"} default button "Deny" with icon caution ` +
      `giving up after ${CONSENT_TIMEOUT_S}`;
    const res = await runRecorded(ctx, "osascript", ["-e", script]);
    const out = `${res.stdout} ${res.stderr}`;
    if (/-1719|No user interaction allowed|not allowed to send keystrokes/i.test(out)) {
      return noInteractiveSession("no GUI session is attached to this machine");
    }
    if (/gave up:true/i.test(out)) return { ok: false, error: "the employee did not answer in time" };
    if (/button returned:Allow/i.test(out)) return { ok: true };
    return { ok: false, error: "the employee declined" };
  }

  if (IS_WINDOWS) {
    // Launched INTO the active console session. Without this the dialog renders
    // on the session-0 desktop and the employee never sees it.
    const script = [
      `$ErrorActionPreference='Stop'`,
      `$sid = (Get-Process -Name explorer -ErrorAction SilentlyContinue | Select-Object -First 1).SessionId`,
      `if ($null -eq $sid) { Write-Output 'NO_SESSION'; exit 0 }`,
      `Add-Type -AssemblyName System.Windows.Forms`,
      `$r = [System.Windows.Forms.MessageBox]::Show('${psEscape(message)}','Screenshot request','YesNo','Question')`,
      `if ($r -eq 'Yes') { Write-Output 'ALLOW' } else { Write-Output 'DENY' }`,
    ].join("; ");
    const res = await runRecorded(ctx, "powershell", psArgs(script));
    const out = `${res.stdout}`;
    if (/NO_SESSION/.test(out)) {
      return noInteractiveSession("nobody is logged on at the console");
    }
    if (/ALLOW/.test(out)) return { ok: true };
    if (/DENY/.test(out)) return { ok: false, error: "the employee declined" };
    return noInteractiveSession("the consent helper produced no answer — it may be stuck in session 0");
  }

  return noInteractiveSession(`screenshots are not supported on ${AGENT_OS}`);
}

function screenshotDir() {
  const dir = path.join(os.tmpdir(), "bolt-it-shots");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function collectScreenshot(ctx, args, job) {
  const consent = await askConsent(ctx, job);
  if (!consent.ok) {
    return {
      ok: false,
      error: consent.error,
      // Carried through so the executor can tell the two apart. A refusal is a
      // policy outcome; a missing session is a broken dependency.
      failureKind: consent.noSession ? "dependency_unavailable" : "policy_block",
    };
  }

  const file = path.join(screenshotDir(), `shot-${Date.now()}.jpg`);
  if (IS_MAC) {
    // -x suppresses the shutter sound. If Screen Recording permission has not
    // been granted, screencapture writes a BLACK image and exits 0 — it does
    // not fail — so the size check below is the only thing that catches it.
    await runRecorded(ctx, "screencapture", ["-x", "-t", "jpg", file]);
  } else if (IS_WINDOWS) {
    const script = [
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing`,
      `$b = [System.Windows.Forms.SystemInformation]::VirtualScreen`,
      `$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height`,
      `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
      `$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)`,
      `$bmp.Save('${psEscape(file)}', [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
    ].join("; ");
    await runRecorded(ctx, "powershell", psArgs(script));
  } else {
    return { ok: false, error: `screenshots are not supported on ${AGENT_OS}` };
  }

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, error: "the capture produced no file" };
  }

  // A black screen is what macOS returns when Screen Recording permission is
  // missing, and what session 0 returns on Windows. Both come back as a valid,
  // tiny JPEG with exit code 0 — so uploading "successfully" would put a black
  // rectangle in front of the planner and call it evidence.
  if (stat.size < 8 * 1024) {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
    return {
      ok: false,
      error:
        "the capture came back blank — on macOS grant Screen Recording to the agent in " +
        "System Settings > Privacy & Security; on Windows the capture ran outside the user's session",
      failureKind: "dependency_unavailable",
    };
  }

  const b64 = fs.readFileSync(file).toString("base64");
  try { fs.unlinkSync(file); } catch { /* best effort */ }

  return {
    ok: true,
    output: `screenshot captured with the employee's consent (${Math.round(stat.size / 1024)} KB)`,
    // Uploaded on the envelope rather than inlined into the job output, so it
    // never lands in the journal or the ticket log as a wall of base64.
    screenshotBase64: b64,
    consent: { promptedAt: Date.now(), response: "allow" },
  };
}

// ---- filename search --------------------------------------------------------
// Contents search is fs_grep. This one answers "where is X", which fs_grep
// cannot: it has to open every file to find out.

const MAX_FIND_RESULTS = 100;
const MAX_FIND_ENTRIES = 2000;
const MAX_FIND_DEPTH = 4;
const FIND_BUDGET_MS = 10_000;

function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

async function collectFsFind(ctx, args) {
  const target = resolveTarget(args.fsPath);
  if (target.error) return { ok: false, error: target.error };

  let matcher;
  try {
    matcher = globToRegExp(args.pattern);
  } catch {
    return { ok: false, error: "pattern is not a usable glob" };
  }

  const deadline = Date.now() + FIND_BUDGET_MS;
  const results = [];
  let scanned = 0;
  let truncated = false;

  const walk = (dir, depth) => {
    if (depth > MAX_FIND_DEPTH || results.length >= MAX_FIND_RESULTS) return;
    if (scanned >= MAX_FIND_ENTRIES || Date.now() > deadline) { truncated = true; return; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory is not an error, it is just not searchable
    }
    for (const e of entries) {
      if (results.length >= MAX_FIND_RESULTS || scanned >= MAX_FIND_ENTRIES) { truncated = true; return; }
      scanned++;
      const full = path.join(dir, e.name);
      // The denylist applies to RESULTS, not only to the root. A path is itself
      // data: "~/Documents/resignation-letter.docx" discloses something even
      // when the file is never opened.
      if (GUARD_CREDENTIALS && DENIED_PATH.test(full)) continue;
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (matcher.test(e.name)) {
        results.push(full);
      }
    }
  };

  walk(target.path, 0);
  recordFsAccess(ctx, "fs_find", target.path, `${results.length} matches, ${scanned} scanned`);

  const lines = results.map((r) => r.replace(os.homedir(), "~"));
  return {
    ok: true,
    output:
      (lines.length ? lines.join("\n") : "(no files matched)") +
      (truncated ? `\n… stopped after ${scanned} entries — narrow the path or the pattern` : ""),
    note: `${results.length} match(es) under ${target.path.replace(os.homedir(), "~")}`,
  };
}

// ---- settings changes -------------------------------------------------------
// Each one is probe -> act -> probe, with a rollback where a rollback is real.

async function probeService(ctx, label, args) {
  const name = String(args?.service || "").replace(/[^A-Za-z0-9 ._-]/g, "");
  const facts = { service: name, state: "unknown" };
  if (IS_WINDOWS) {
    const res = await runRecorded(ctx, "powershell", psArgs(
      `$s = Get-Service -Name '${psEscape(name)}' -ErrorAction SilentlyContinue; ` +
      `if ($s) { $s.Status.ToString() } else { 'absent' }`,
    ));
    facts.state = (res.stdout || "").trim() || "unknown";
  } else {
    const res = await runRecorded(ctx, "launchctl", ["list"]);
    facts.state = (res.stdout || "").split("\n").some((l) => l.includes(name)) ? "running" : "stopped";
  }
  return { label: `service:${name} (${label})`, command: "service state", exitCode: 0, facts };
}

async function actRestartService(ctx, args) {
  const name = String(args.service || "").replace(/[^A-Za-z0-9 ._-]/g, "");
  if (!name) return { ok: false, error: "service name is required" };
  if (IS_WINDOWS) {
    const res = await runRecorded(ctx, "powershell", psArgs(
      `Restart-Service -Name '${psEscape(name)}' -Force -ErrorAction Stop`,
    ));
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "Restart-Service failed" };
  } else {
    const res = await runRecorded(ctx, "launchctl", ["kickstart", "-k", `system/${name}`]);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "launchctl kickstart failed" };
  }
  await sleep(2000);
  return { ok: true, output: `restarted ${name}` };
}

async function rollbackRestartService(ctx, args) {
  const name = String(args.service || "").replace(/[^A-Za-z0-9 ._-]/g, "");
  if (IS_WINDOWS) {
    await runRecorded(ctx, "powershell", psArgs(`Start-Service -Name '${psEscape(name)}'`));
  } else {
    await runRecorded(ctx, "launchctl", ["kickstart", `system/${name}`]);
  }
  return { ok: true };
}

async function probePrintQueue(ctx, label) {
  const facts = { spooler: "unknown", queued: "unknown" };
  if (IS_WINDOWS) {
    const res = await runRecorded(ctx, "powershell", psArgs(
      `$s=(Get-Service -Name Spooler).Status.ToString(); ` +
      `$n=@(Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue }).Count; ` +
      `"$s|$n"`,
    ));
    const [state, n] = (res.stdout || "").trim().split("|");
    facts.spooler = state || "unknown";
    facts.queued = n ?? "unknown";
  } else {
    const res = await runRecorded(ctx, "lpstat", ["-o"]);
    facts.spooler = "cups";
    facts.queued = String((res.stdout || "").trim().split("\n").filter(Boolean).length);
  }
  return { label: `print-queue (${label})`, command: "print queue state", exitCode: 0, facts };
}

async function actClearPrintQueue(ctx) {
  if (IS_WINDOWS) {
    await runRecorded(ctx, "powershell", psArgs("Stop-Service -Name Spooler -Force"));
    await runRecorded(ctx, "powershell", psArgs(
      `Remove-Item -Path "$env:SystemRoot\\System32\\spool\\PRINTERS\\*" -Force -ErrorAction SilentlyContinue`,
    ));
    const res = await runRecorded(ctx, "powershell", psArgs("Start-Service -Name Spooler"));
    if (res.code !== 0) return { ok: false, error: "the spooler did not come back up" };
  } else {
    await runRecorded(ctx, "cancel", ["-a"]);
  }
  await sleep(1500);
  return { ok: true, output: "print queue cleared" };
}

async function rollbackPrintQueue(ctx) {
  if (IS_WINDOWS) await runRecorded(ctx, "powershell", psArgs("Start-Service -Name Spooler"));
  return { ok: true };
}

async function probeDhcp(ctx, label) {
  const facts = { address: "unknown" };
  if (IS_WINDOWS) {
    const res = await runRecorded(ctx, "powershell", psArgs(
      `(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress`,
    ));
    facts.address = (res.stdout || "").trim() || "none";
  } else {
    const res = await runRecorded(ctx, "ipconfig", ["getifaddr", "en0"]);
    facts.address = (res.stdout || "").trim() || "none";
  }
  return { label: `dhcp (${label})`, command: "dhcp lease", exitCode: 0, facts };
}

async function actRenewDhcp(ctx) {
  if (IS_WINDOWS) {
    await runRecorded(ctx, "ipconfig", ["/release"]);
    const res = await runRecorded(ctx, "ipconfig", ["/renew"]);
    if (res.code !== 0) return { ok: false, error: "ipconfig /renew failed" };
  } else {
    const res = await runRecorded(ctx, "ipconfig", ["set", "en0", "DHCP"]);
    if (res.code !== 0) return { ok: false, error: "ipconfig set DHCP failed" };
  }
  await sleep(4000);
  return { ok: true, output: "DHCP lease renewed" };
}

async function rollbackDhcp(ctx) {
  if (IS_WINDOWS) await runRecorded(ctx, "ipconfig", ["/renew"]);
  else await runRecorded(ctx, "ipconfig", ["set", "en0", "DHCP"]);
  return { ok: true };
}

async function probeGpo(ctx, label) {
  const res = await runRecorded(ctx, "powershell", psArgs(
    `(Get-CimInstance -ClassName Win32_OperatingSystem).LastBootUpTime.ToString('o')`,
  ));
  return {
    label: `group-policy (${label})`,
    command: "gpo state",
    exitCode: 0,
    facts: { appliedAt: new Date().toISOString().slice(0, 16), boot: (res.stdout || "").trim() },
  };
}

async function actGpupdate(ctx) {
  if (!IS_WINDOWS) return { ok: false, error: "gpupdate is Windows only" };
  const res = await runRecorded(ctx, "gpupdate", ["/target:computer", "/force"]);
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "gpupdate failed" };
  return { ok: true, output: "group policy re-applied" };
}

async function probeProxy(ctx, label) {
  const facts = { proxy: "none" };
  if (IS_WINDOWS) {
    const res = await runRecorded(ctx, "netsh", ["winhttp", "show", "proxy"]);
    facts.proxy = (res.stdout || "").includes("Direct access") ? "none" : (res.stdout || "").trim().slice(0, 200);
  } else {
    const res = await runRecorded(ctx, "networksetup", ["-getwebproxy", "Wi-Fi"]);
    const on = /Enabled: Yes/i.test(res.stdout || "");
    const server = ((res.stdout || "").match(/Server: (\S+)/) || [])[1] || "";
    const port = ((res.stdout || "").match(/Port: (\d+)/) || [])[1] || "";
    facts.proxy = on ? `${server}:${port}` : "none";
  }
  return { label: `proxy (${label})`, command: "proxy config", exitCode: 0, facts };
}

async function actSetProxy(ctx, args) {
  const server = String(args.server || "").replace(/[^A-Za-z0-9.-]/g, "");
  const port = Number(args.port) || 0;
  const clearing = !server;

  if (IS_WINDOWS) {
    const res = clearing
      ? await runRecorded(ctx, "netsh", ["winhttp", "reset", "proxy"])
      : await runRecorded(ctx, "netsh", ["winhttp", "set", "proxy", `${server}:${port}`]);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "netsh winhttp failed" };
  } else {
    if (clearing) {
      await runRecorded(ctx, "networksetup", ["-setwebproxystate", "Wi-Fi", "off"]);
      await runRecorded(ctx, "networksetup", ["-setsecurewebproxystate", "Wi-Fi", "off"]);
    } else {
      await runRecorded(ctx, "networksetup", ["-setwebproxy", "Wi-Fi", server, String(port)]);
      await runRecorded(ctx, "networksetup", ["-setsecurewebproxy", "Wi-Fi", server, String(port)]);
    }
  }
  return { ok: true, output: clearing ? "proxy cleared" : `proxy set to ${server}:${port}` };
}

/** Re-apply exactly what the before-probe captured. This is what makes the
 *  capability `reversible: "recorded"` rather than a hopeful guess. */
async function rollbackProxy(ctx, args, before) {
  const prior = before?.facts?.proxy;
  if (!prior || prior === "unknown") return { ok: false, error: "no prior proxy state was captured" };
  if (prior === "none") return actSetProxy(ctx, { server: "", port: 0 });
  const [server, port] = String(prior).split(":");
  return actSetProxy(ctx, { server, port: Number(port) || 8080 });
}

async function probeWinsock(ctx, label) {
  const res = await runRecorded(ctx, "netsh", ["winsock", "show", "catalog"]);
  const entries = (res.stdout || "").split("\n").filter((l) => /Entry Type/i.test(l)).length;
  return {
    label: `winsock (${label})`,
    command: "netsh winsock show catalog",
    exitCode: res.code,
    facts: { catalogEntries: String(entries) },
  };
}

async function actResetWinsock(ctx) {
  if (!IS_WINDOWS) return { ok: false, error: "reset_winsock is Windows only" };
  const res = await runRecorded(ctx, "netsh", ["winsock", "reset"]);
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "netsh winsock reset failed" };
  return {
    ok: true,
    output: "winsock catalog reset",
    note: "TAKES EFFECT ONLY AFTER A REBOOT — the employee must restart before the network stack changes",
  };
}

// ---- desktop shell -----------------------------------------------------------
// "My taskbar is gone" has two distinct causes and they need different fixes:
// the shell process died, or auto-hide got switched on. Restarting the shell
// does nothing for the second, and flipping auto-hide does nothing for the
// first, so they are two capabilities rather than one that guesses.

const SHELL_PROCESS = IS_WINDOWS ? "explorer" : "Dock";

async function actRestartShell(ctx) {
  if (IS_WINDOWS) {
    await runRecordedPs(ctx, "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue");
    await sleep(2500);
    // Windows usually relaunches the shell on its own. When it does not, start
    // it — but the check below is what decides whether this worked, because a
    // pid that changed while the taskbar stayed missing would otherwise diff as
    // a successful fix.
    const res = await runRecordedPs(
      ctx,
      "if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }; " +
        "Start-Sleep -Seconds 3; @(Get-Process -Name explorer -ErrorAction SilentlyContinue).Count",
    );
    if (Number((res.stdout || "").trim()) < 1) {
      return { ok: false, error: "the shell did not come back — the desktop is still without a taskbar" };
    }
    return { ok: true, output: "desktop shell restarted" };
  }
  await runRecorded(ctx, "killall", ["Dock"]);
  await sleep(2500);
  const res = await runRecorded(ctx, "pgrep", ["-ix", "Dock"]);
  if (!(res.stdout || "").trim()) return { ok: false, error: "the Dock did not come back" };
  return { ok: true, output: "Dock restarted" };
}

const TASKBAR_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StuckRects3";

/**
 * Auto-hide is one BIT, not a value of its own.
 *
 * It lives in bit 0 of byte 8 of the `Settings` REG_BINARY blob under
 * StuckRects3. The rest of that blob carries the taskbar's edge, size and
 * monitor, and those move on their own — so the probe reads the single bit
 * rather than the blob. A fact that drifts by itself is not evidence.
 */
async function probeTaskbar(ctx, label) {
  const facts = { autoHide: "unknown", shell: "unknown" };
  if (IS_WINDOWS) {
    const res = await runRecordedPs(
      ctx,
      `$v = (Get-ItemProperty -Path '${TASKBAR_KEY}' -ErrorAction SilentlyContinue).Settings; ` +
        `$hide = if ($v) { [bool]($v[8] -band 0x01) } else { 'unknown' }; ` +
        `$n = @(Get-Process -Name explorer -ErrorAction SilentlyContinue).Count; ` +
        `"$hide|$n"`,
    );
    const [hide, shell] = (res.stdout || "").trim().split("|");
    facts.autoHide = hide === "True" ? "on" : hide === "False" ? "off" : "unknown";
    facts.shell = Number(shell) > 0 ? "running" : "not running";
    return {
      label: `taskbar (${label})`,
      command: `(Get-ItemProperty '${TASKBAR_KEY}').Settings[8] -band 0x01`,
      exitCode: res.code,
      facts,
    };
  }
  const res = await runRecorded(ctx, "defaults", ["read", "com.apple.dock", "autohide"]);
  const shell = await runRecorded(ctx, "pgrep", ["-ix", "Dock"]);
  facts.autoHide = (res.stdout || "").trim() === "1" ? "on" : "off";
  facts.shell = (shell.stdout || "").trim() ? "running" : "not running";
  return {
    label: `dock (${label})`,
    command: "defaults read com.apple.dock autohide",
    exitCode: res.code,
    facts,
  };
}

async function actSetTaskbarAutohide(ctx, args) {
  const on = String(args.autoHide) === "true";
  if (IS_WINDOWS) {
    const bit = on ? "$v[8] -bor 0x01" : "$v[8] -band 0xFE";
    const res = await runRecordedPs(
      ctx,
      `$v = (Get-ItemProperty -Path '${TASKBAR_KEY}' -ErrorAction Stop).Settings; ` +
        `$v[8] = ${bit}; ` +
        `Set-ItemProperty -Path '${TASKBAR_KEY}' -Name Settings -Value $v -ErrorAction Stop`,
    );
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "could not write the taskbar setting" };
    // The blob is read by the shell at startup, so the setting is inert until
    // the shell reloads it.
    await runRecordedPs(ctx, "Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue");
    await sleep(3000);
    await runRecordedPs(
      ctx,
      "if (-not (Get-Process -Name explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }",
    );
    await sleep(2000);
  } else {
    const res = await runRecorded(ctx, "defaults", ["write", "com.apple.dock", "autohide", "-bool", on ? "true" : "false"]);
    if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "defaults write failed" };
    await runRecorded(ctx, "killall", ["Dock"]);
    await sleep(2500);
  }
  return { ok: true, output: `taskbar auto-hide turned ${on ? "on" : "off"}` };
}

/** Put the bit back exactly as the before-probe found it. */
async function rollbackTaskbarAutohide(ctx, _args, before) {
  const prior = before?.facts?.autoHide;
  if (prior !== "on" && prior !== "off") {
    return { ok: false, error: "no prior taskbar state was captured" };
  }
  return actSetTaskbarAutohide(ctx, { autoHide: prior === "on" ? "true" : "false" });
}

// ---- processes ---------------------------------------------------------------

/**
 * Killing one of these does not end a hung app, it ends the session or the
 * machine. The registry cannot express "any app except six", so the refusal
 * lives here, next to the call that would do the damage.
 */
const NEVER_KILL = new Set(
  IS_WINDOWS
    ? ["explorer", "winlogon", "csrss", "lsass", "services", "smss", "wininit", "system"]
    : ["windowserver", "loginwindow", "launchd", "kernel_task"],
);

async function actKillProcess(ctx, { app }) {
  const candidates = appNameCandidates(app);
  const blocked = candidates.find((c) => NEVER_KILL.has(String(c).toLowerCase()));
  if (blocked) {
    return {
      ok: false,
      error: `"${blocked}" is a system process — ending it would take down the session, not the app`,
    };
  }
  if (IS_WINDOWS) {
    const nameList = candidates.map((c) => `'${c}'`).join(",");
    const res = await runRecordedPs(
      ctx,
      `Stop-Process -Name ${nameList} -Force -ErrorAction SilentlyContinue; ` +
        `Start-Sleep -Seconds 2; @(Get-Process -Name ${nameList} -ErrorAction SilentlyContinue).Count`,
    );
    if (Number((res.stdout || "").trim()) > 0) {
      return { ok: false, error: `${app} is still running after the stop request` };
    }
  } else {
    await runRecorded(ctx, "pkill", ["-ix", candidates[0]]);
    await sleep(2000);
    const still = await runRecorded(ctx, "pgrep", ["-ix", candidates[0]]);
    if ((still.stdout || "").trim()) return { ok: false, error: `${app} is still running after the kill` };
  }
  return {
    ok: true,
    output: `${app} was ended`,
    note: "anything unsaved in that app is gone — this has no undo",
  };
}

// ---- startup items -----------------------------------------------------------
// The Run key says what COULD start; StartupApproved says what actually does.
// Deleting the Run entry would be the destructive way to stop an item, so the
// approved byte is what moves here — the same thing Task Manager's Startup tab
// writes, and reversible by putting the byte back.

const RUN_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

async function probeStartupItems(ctx, label, args) {
  const item = String(args?.item || "").replace(/[^A-Za-z0-9 ._()-]/g, "");
  const facts = { items: "unknown", enabled: "unknown", enabledItems: "", item, itemState: "unknown" };
  if (!IS_WINDOWS) {
    return { label: `startup (${label})`, command: "startup items", exitCode: 0, facts };
  }
  const res = await runRecordedPs(
    ctx,
    `$names = @((Get-Item -Path '${RUN_KEY}' -ErrorAction SilentlyContinue).Property); ` +
      `$ap = Get-ItemProperty -Path '${APPROVED_KEY}' -ErrorAction SilentlyContinue; ` +
      `$on = @(); foreach ($n in $names) { $b = $ap.$n; if (-not $b -or -not ($b[0] -band 0x01)) { $on += $n } }; ` +
      `$mine = if ('${psEscape(item)}') { $b2 = $ap.'${psEscape(item)}'; ` +
      `if (-not $b2) { 'enabled' } elseif ($b2[0] -band 0x01) { 'disabled' } else { 'enabled' } } else { 'n/a' }; ` +
      `"$($names.Count)|$($on.Count)|$(($on | Sort-Object) -join ',')|$mine"`,
  );
  const [count, enabled, list, mine] = (res.stdout || "").trim().split("|");
  facts.items = count ?? "unknown";
  facts.enabled = enabled ?? "unknown";
  facts.enabledItems = list ?? "";
  facts.itemState = mine || "unknown";
  return {
    label: `startup (${label})`,
    command: `(Get-Item '${RUN_KEY}').Property + StartupApproved\\Run`,
    exitCode: res.code,
    facts,
  };
}

async function actSetStartupItem(ctx, args) {
  if (!IS_WINDOWS) return { ok: false, error: "startup items are Windows only" };
  const item = String(args.item || "").replace(/[^A-Za-z0-9 ._()-]/g, "");
  if (!item) return { ok: false, error: "item name is required" };
  const enable = String(args.enabled) === "true";
  // 12 bytes, and only the first one carries the state: 0x02 enabled,
  // 0x03 disabled. The remaining 11 are a disable timestamp Windows fills in
  // itself; zeroing them is what Task Manager does too.
  const first = enable ? "0x02" : "0x03";
  const res = await runRecordedPs(
    ctx,
    `New-Item -Path '${APPROVED_KEY}' -Force | Out-Null; ` +
      `[byte[]]$b = @(${first},0,0,0,0,0,0,0,0,0,0,0); ` +
      `Set-ItemProperty -Path '${APPROVED_KEY}' -Name '${psEscape(item)}' -Value $b -Type Binary -ErrorAction Stop`,
  );
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "could not write the startup approval" };
  return { ok: true, output: `${item} set to ${enable ? "enabled" : "disabled"} at startup` };
}

async function rollbackStartupItem(ctx, args, before) {
  const prior = before?.facts?.itemState;
  if (prior !== "enabled" && prior !== "disabled") {
    return { ok: false, error: "no prior startup state was captured for that item" };
  }
  return actSetStartupItem(ctx, { item: args.item, enabled: prior === "enabled" ? "true" : "false" });
}

// ---- packages ----------------------------------------------------------------

async function probePackage(ctx, label, args) {
  const id = String(args?.package || "").replace(/[^A-Za-z0-9._+-]/g, "");
  const facts = { package: id, installed: "false", version: "none" };
  if (!IS_WINDOWS) {
    return { label: `package:${id} (${label})`, command: "winget list", exitCode: 0, facts };
  }
  const res = await runRecorded(ctx, "winget", [
    "list", "--id", id, "--exact", "--accept-source-agreements", "--disable-interactivity",
  ]);
  const out = res.stdout || "";
  const found = !/No installed package/i.test(out) && new RegExp(id.replace(/[.+]/g, "\\$&"), "i").test(out);
  facts.installed = found ? "true" : "false";
  if (found) {
    const line = out.split(/\r?\n/).find((l) => new RegExp(id.replace(/[.+]/g, "\\$&"), "i").test(l)) || "";
    facts.version = (line.match(/\b\d+(?:\.\d+){1,3}\b/) || [])[0] || "unknown";
  }
  return {
    label: `package:${id} (${label})`,
    command: `winget list --id ${id} --exact`,
    exitCode: res.code,
    facts,
  };
}

async function actInstallPackage(ctx, args) {
  if (!IS_WINDOWS) return { ok: false, error: "install_package is Windows only (winget)" };
  const id = String(args.package || "").replace(/[^A-Za-z0-9._+-]/g, "");
  if (!id) return { ok: false, error: "package id is required" };
  const res = await runRecorded(ctx, "winget", [
    "install", "--id", id, "--exact", "--silent",
    "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
  ]);
  if (res.code !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "").trim().slice(0, 400) || `winget exited ${res.code}` };
  }
  return { ok: true, output: `installed ${id}` };
}

/** The undo is the uninstall, and it only runs when the install did not verify. */
async function rollbackPackage(ctx, args, before) {
  if (before?.facts?.installed === "true") {
    return { ok: false, error: "the package was already installed before this job — not uninstalling it" };
  }
  const id = String(args.package || "").replace(/[^A-Za-z0-9._+-]/g, "");
  const res = await runRecorded(ctx, "winget", [
    "uninstall", "--id", id, "--exact", "--silent", "--accept-source-agreements", "--disable-interactivity",
  ]);
  return res.code === 0 ? { ok: true } : { ok: false, error: `winget uninstall exited ${res.code}` };
}

// ---- devices -----------------------------------------------------------------

/**
 * Find the device a ticket is talking about.
 *
 * Two rules, both learned from one machine:
 *
 *  - Match the CLASS as well as the friendly name. The webcam on this VM is
 *    called "VMware Virtual USB Video Device" — the word "camera" appears
 *    nowhere in it, and a name-only match found "Remote Desktop Camera Bus"
 *    instead, which is a bus, not a camera.
 *  - When several match, prefer the one that is NOT OK. A ticket is about
 *    something broken, so the broken match is the one being asked about. Taking
 *    the first match reported "your camera is fine" while the disabled device
 *    sat two rows further down.
 */
function pnpLookupPs(name) {
  const q = psEscape(name);
  return (
    `$all = @(Get-PnpDevice -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.FriendlyName -like '*${q}*' -or $_.Class -like '*${q}*' }); ` +
    `$d = $all | Where-Object { $_.Status -ne 'OK' } | Select-Object -First 1; ` +
    `if (-not $d) { $d = $all | Select-Object -First 1 }; `
  );
}

async function probePnpDevice(ctx, label, args) {
  const name = String(args?.device || "").replace(/[^A-Za-z0-9 ._()-]/g, "");
  const facts = { device: name, status: "unknown", problem: "none", instanceId: "none" };
  if (!IS_WINDOWS) {
    return { label: `device:${name} (${label})`, command: "Get-PnpDevice", exitCode: 0, facts };
  }
  const res = await runRecordedPs(
    ctx,
    pnpLookupPs(name) +
      `if ($d) { "$($d.Status)|$($d.Problem)|$($d.InstanceId)|$($d.FriendlyName)" } else { 'absent|none|none|none' }`,
  );
  const [status, problem, instanceId, matched] = (res.stdout || "").trim().split("|");
  facts.status = status || "unknown";
  facts.problem = problem || "none";
  facts.instanceId = instanceId || "none";
  // WHICH device answered. The employee says "camera" and the machine calls it
  // "VMware Virtual USB Video Device"; without this the ticket reports a status
  // with no way to tell what it is the status OF.
  facts.matched = matched || "none";
  return {
    label: `device:${name} (${label})`,
    command: `Get-PnpDevice | where FriendlyName -like '*${name}*' -or Class -like '*${name}*'`,
    exitCode: res.code,
    facts,
  };
}

async function actEnableDevice(ctx, args) {
  if (!IS_WINDOWS) return { ok: false, error: "enable_device is Windows only" };
  const name = String(args.device || "").replace(/[^A-Za-z0-9 ._()-]/g, "");
  if (!name) return { ok: false, error: "device name is required" };
  const res = await runRecordedPs(
    ctx,
    pnpLookupPs(name) +
      `if (-not $d) { throw 'no device matched that name' }; ` +
      `Enable-PnpDevice -InstanceId $d.InstanceId -Confirm:$false -ErrorAction Stop; ` +
      `$d.FriendlyName`,
  );
  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "Enable-PnpDevice failed" };
  await sleep(2000);
  return { ok: true, output: `enabled ${(res.stdout || "").trim() || name}` };
}

async function rollbackEnableDevice(ctx, args, before) {
  if (before?.facts?.status === "OK") {
    return { ok: false, error: "the device was already enabled before this job — leaving it alone" };
  }
  const instanceId = before?.facts?.instanceId;
  if (!instanceId || instanceId === "none") return { ok: false, error: "no device instance was captured" };
  const res = await runRecordedPs(
    ctx,
    `Disable-PnpDevice -InstanceId '${psEscape(instanceId)}' -Confirm:$false -ErrorAction Stop`,
  );
  return res.code === 0 ? { ok: true } : { ok: false, error: "Disable-PnpDevice failed" };
}

// ---- VPN ---------------------------------------------------------------------
// The ticket that matters here is "connected but nothing works", so the probe
// reads the three facts that tell those cases apart: is the tunnel up, does it
// have an address, and where are name lookups going. A `connected` boolean on
// its own cannot distinguish a dead tunnel from a live one with the wrong DNS,
// which is the whole diagnosis.

/** Where WireGuard for Windows keeps a tunnel once it has been imported. */
const WG_CONFIG_DIR = "C:\\Program Files\\WireGuard\\Data\\Configurations";

async function probeVpn(ctx, label, args) {
  const wanted = String(args?.name || "").replace(/[^A-Za-z0-9 ._-]/g, "");
  const facts = {
    vpn: wanted || "auto",
    // Configured and connected are SEPARATE facts, and the split is the whole
    // point. WireGuard removes the tunnel's service when it is deactivated, so a
    // machine with a perfectly good tunnel that is merely switched off looks
    // byte-for-byte identical to a machine with no VPN at all. T-6852 read that
    // as "no VPN client is installed on this PC", told the employee so, and
    // escalated a ticket whose fix was to start a tunnel that was sitting right
    // there. A configured tunnel is evidence a VPN is expected on this machine.
    // What VPN software is actually installed, read from the same uninstall
    // registry the Apps list is built from. Without it the operator goes hunting
    // through Program Files, Program Files (x86) and fs.find for an executable —
    // three steps and two rounds on T-6852 — to answer a question one read
    // settles. "Installed but not connected" is a one-step fix; "not installed"
    // is a genuine handoff. The probe has to be able to tell them apart.
    client: "none",
    configured: "none",
    connected: "false",
    tunnel: "none",
    tunnel_ip: "none",
    tunnel_dns: "none",
  };
  if (IS_WINDOWS) {
    const res = await runRecordedPs(
      ctx,
      `$n = '${psEscape(wanted)}'; ` +
        `$c = if ($n) { Get-VpnConnection -Name $n -ErrorAction SilentlyContinue } ` +
        `else { Get-VpnConnection -ErrorAction SilentlyContinue | Select-Object -First 1 }; ` +
        // WireGuard installs one service per tunnel and has no Get-VpnConnection entry.
        `$wg = Get-Service -Name 'WireGuardTunnel$*' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `$name = if ($c) { $c.Name } elseif ($wg) { $wg.Name -replace '^WireGuardTunnel\\$','' } else { 'none' }; ` +
        `$up = if ($c) { $c.ConnectionStatus -eq 'Connected' } elseif ($wg) { $wg.Status -eq 'Running' } else { $false }; ` +
        `$a = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'WireGuard|WAN Miniport \\(IKEv2\\)|TAP|VPN' -and $_.Status -eq 'Up' } | Select-Object -First 1; ` +
        `$ip = if ($a) { (Get-NetIPAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1).IPAddress } else { $null }; ` +
        `$dns = if ($a) { ((Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses -join ',') } else { $null }; ` +
        // Tunnels that EXIST on this machine, running or not: WireGuard configs
        // on disk plus any Get-VpnConnection entry. Without this a switched-off
        // VPN is indistinguishable from no VPN.
        `$cfg = @(Get-ChildItem -Path '${WG_CONFIG_DIR}' -Filter *.conf* -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { $_.Name -replace '\\.conf(\\.dpapi)?$','' }); ` +
        `$cfg += @(Get-VpnConnection -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }); ` +
        // The installed-programs list, same source as Settings > Apps.
        //
        // Get-ChildItem + GetValue, NOT Get-ItemProperty: the latter loads every
        // property of every installed program, which on a single-core VM took
        // over 30 seconds and blew OBSERVE_TIMEOUT_MS for the whole bundle — so
        // all four probes came back empty and the strategist planned against no
        // device evidence at all. This reads one value per key.
        `$inst = @(Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',` +
        `'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ` +
        `ForEach-Object { $_.GetValue('DisplayName') } | ` +
        `Where-Object { $_ -match 'VPN|WireGuard|OpenVPN|AnyConnect|GlobalProtect|Pulse Secure|FortiClient|Tailscale|Zscaler' }); ` +
        `"$name|$up|$($a.Name)|$ip|$dns|$(($cfg | Sort-Object -Unique) -join ',')|$(($inst | Sort-Object -Unique) -join ',')"`,
    );
    const [name, up, adapter, ip, dns, configured, client] = (res.stdout || "").trim().split("|");
    facts.client = client || "none";
    facts.configured = configured || "none";
    facts.vpn = name || configured || wanted || "none";
    facts.connected = up === "True" ? "true" : "false";
    facts.tunnel = adapter || "none";
    facts.tunnel_ip = ip || "none";
    facts.tunnel_dns = dns || "none";
    return {
      label: `vpn (${label})`,
      command: `Get-VpnConnection + Get-NetAdapter + Get-DnsClientServerAddress + dir "${WG_CONFIG_DIR}"`,
      exitCode: res.code,
      facts,
    };
  }

  const list = await runRecorded(ctx, "scutil", ["--nc", "list"]);
  const line = (list.stdout || "")
    .split(/\r?\n/)
    .find((l) => (wanted ? l.includes(wanted) : /^\*?\s*\(/.test(l) && /Connected|Disconnected/.test(l))) || "";
  facts.vpn = (line.match(/"([^"]+)"/) || [])[1] || wanted || "none";
  facts.connected = /\(Connected\)/.test(line) ? "true" : "false";
  const ifc = await runRecorded(ctx, "ifconfig", ["-a"]);
  const utun = (ifc.stdout || "").split(/\n(?=\w)/).find((b) => /^utun/.test(b) && /inet /.test(b)) || "";
  facts.tunnel = (utun.match(/^(utun\d+)/) || [])[1] || "none";
  facts.tunnel_ip = (utun.match(/inet (\d+\.\d+\.\d+\.\d+)/) || [])[1] || "none";
  // Only when there IS a tunnel. `scutil --dns` prints the system resolver list
  // whether or not one is up, and reporting that as `tunnel_dns` would tell a
  // reader the tunnel has resolvers when the tunnel does not exist — the exact
  // misreading this probe was split into separate facts to prevent.
  const dns = await runRecorded(ctx, "scutil", ["--dns"]);
  facts.tunnel_dns =
    facts.tunnel === "none"
      ? "none"
      : [...(dns.stdout || "").matchAll(/nameserver\[\d+\] : (\S+)/g)]
          .map((m) => m[1])
          .slice(0, 3)
          .join(",") || "none";
  return { label: `vpn (${label})`, command: "scutil --nc list + ifconfig -a + scutil --dns", exitCode: list.code, facts };
}

async function actReconnectVpn(ctx, args) {
  const name = String(args.name || "").replace(/[^A-Za-z0-9 ._-]/g, "");
  if (IS_WINDOWS) {
    // WireGuard first: it has no rasdial entry, so asking rasdial about it
    // produces a confusing "no such phonebook entry" rather than a reconnect.
    const wg = await runRecordedPs(
      ctx,
      `$s = Get-Service -Name 'WireGuardTunnel$*' -ErrorAction SilentlyContinue | Select-Object -First 1; ` +
        `if ($s) { $s.Name } else { '' }`,
    );
    const svc = (wg.stdout || "").trim();
    if (svc) {
      const res = await runRecordedPs(ctx, `Restart-Service -Name '${psEscape(svc)}' -Force -ErrorAction Stop`);
      if (res.code !== 0) return { ok: false, error: res.stderr.trim() || "the tunnel service did not restart" };
      await sleep(4000);
      return { ok: true, output: `reconnected ${svc}` };
    }

    // No service, but a tunnel may still be configured: WireGuard DELETES the
    // per-tunnel service when the tunnel is deactivated, so "switched off" and
    // "never set up" look the same from Get-Service. Installing the service from
    // the config on disk is how the GUI's own Activate button starts a tunnel,
    // and it is the difference between fixing this and escalating it.
    const cfg = await runRecordedPs(
      ctx,
      `$c = Get-ChildItem -Path '${WG_CONFIG_DIR}' -Filter *.conf* -ErrorAction SilentlyContinue | ` +
        (name ? `Where-Object { $_.Name -like '${psEscape(name)}*' } | ` : "") +
        `Select-Object -First 1; if ($c) { $c.FullName } else { '' }`,
    );
    const cfgPath = (cfg.stdout || "").trim();
    if (cfgPath) {
      const res = await runRecordedPs(
        ctx,
        `& 'C:\\Program Files\\WireGuard\\wireguard.exe' /installtunnelservice "${cfgPath}"`,
      );
      if (res.code !== 0) {
        return { ok: false, error: (res.stderr || res.stdout || "").trim().slice(0, 300) || "installtunnelservice failed" };
      }
      await sleep(5000);
      return { ok: true, output: `brought up the configured tunnel from ${cfgPath}` };
    }

    if (!name) {
      return {
        ok: false,
        error: "no tunnel service is running and no WireGuard configuration exists on this machine — there is no VPN to reconnect",
      };
    }
    await runRecorded(ctx, "rasdial", [name, "/disconnect"]);
    await sleep(1500);
    const res = await runRecorded(ctx, "rasdial", [name]);
    if (res.code !== 0) {
      return { ok: false, error: (res.stdout || res.stderr || "").trim().slice(0, 300) || "rasdial failed" };
    }
    await sleep(3000);
    return { ok: true, output: `reconnected ${name}` };
  }

  if (!name) return { ok: false, error: "a VPN service name is required on macOS" };
  await runRecorded(ctx, "scutil", ["--nc", "stop", name]);
  await sleep(2000);
  const res = await runRecorded(ctx, "scutil", ["--nc", "start", name]);
  if (res.code !== 0) return { ok: false, error: "scutil --nc start failed" };
  await sleep(4000);
  return { ok: true, output: `reconnected ${name}` };
}

async function actExecCmd(ctx, { command }) {
  const cmdStr = String(command || "").trim();
  if (!cmdStr) return { ok: false, error: "command argument is empty" };
  const res = IS_WINDOWS
    ? await runRecordedPs(ctx, cmdStr)
    : await runRecorded(ctx, "zsh", ["-c", cmdStr]);
  const stdout = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();
  const output = [stdout, stderr].filter(Boolean).join("\n");
  return {
    ok: res.code === 0,
    output: output || `command exited with code ${res.code}`,
    ...(res.code !== 0 ? { error: stderr || `command exited with code ${res.code}` } : {}),
  };
}

const HANDLERS = {
  exec_cmd: { expectsChange: false, collect: actExecCmd, requires: ["command"] },
  restart_app: {
    expectsChange: true,
    probe: (ctx, label, args) => probeProcess(ctx, label, args.app),
    act: actRestartApp,
    requires: ["app"],
  },
  clear_app_cache: {
    expectsChange: true,
    probe: (ctx, label, args) => probeCacheDir(ctx, label, args.app),
    act: actClearAppCache,
    requires: ["app"],
  },
  toggle_wifi: {
    expectsChange: true,
    probe: (ctx, label) => probeNetwork(ctx, label),
    act: actToggleWifi,
  },
  set_dns_servers: {
    expectsChange: true,
    probe: (ctx, label, args) => probeDns(ctx, label, args.service),
    act: actSetDnsServers,
    rollback: rollbackSetDns,
  },
  flush_dns: { expectsChange: false, collect: (ctx) => actFlushDns(ctx) },
  collect_system_info: { expectsChange: false, collect: collectSystemInfo },
  app_status: {
    expectsChange: false,
    probe: (ctx, label, args) => probeProcess(ctx, label, args.app),
    requires: ["app"],
  },
  app_event_logs: { expectsChange: false, collect: collectAppEventLogs, requires: ["app"] },
  http_check: { expectsChange: false, probe: probeHttp, requires: ["url"] },
  process_list: { expectsChange: false, collect: collectProcessList },
  network_state: { expectsChange: false, collect: collectNetworkState },
  command_output: { expectsChange: false, collect: collectCommandOutput, requires: ["binary"] },
  fs_list: { expectsChange: false, collect: collectFsList, requires: ["fsPath"] },
  fs_read: { expectsChange: false, collect: collectFsRead, requires: ["fsPath"] },
  fs_grep: { expectsChange: false, collect: collectFsGrep, requires: ["fsPath", "pattern"] },
  fs_find: { expectsChange: false, collect: collectFsFind, requires: ["fsPath", "pattern"] },
  screenshot: { expectsChange: false, collect: collectScreenshot },
  restart_service: {
    expectsChange: true,
    probe: probeService,
    act: actRestartService,
    rollback: rollbackRestartService,
    requires: ["service"],
  },
  clear_print_queue: {
    expectsChange: true,
    probe: probePrintQueue,
    act: actClearPrintQueue,
    rollback: rollbackPrintQueue,
  },
  renew_dhcp_lease: {
    expectsChange: true,
    probe: probeDhcp,
    act: actRenewDhcp,
    rollback: rollbackDhcp,
  },
  gpupdate: { expectsChange: true, probe: probeGpo, act: actGpupdate },
  set_proxy: {
    expectsChange: true,
    probe: probeProxy,
    act: actSetProxy,
    rollback: rollbackProxy,
  },
  reset_winsock: { expectsChange: true, probe: probeWinsock, act: actResetWinsock },
  restart_shell: {
    expectsChange: true,
    probe: (ctx, label) => probeProcess(ctx, label, SHELL_PROCESS),
    act: actRestartShell,
  },
  set_taskbar_autohide: {
    expectsChange: true,
    probe: probeTaskbar,
    act: actSetTaskbarAutohide,
    rollback: rollbackTaskbarAutohide,
    requires: ["autoHide"],
  },
  kill_process: {
    expectsChange: true,
    probe: (ctx, label, args) => probeProcess(ctx, label, args.app),
    act: actKillProcess,
    requires: ["app"],
  },
  set_startup_item: {
    expectsChange: true,
    probe: probeStartupItems,
    act: actSetStartupItem,
    rollback: rollbackStartupItem,
    requires: ["item", "enabled"],
  },
  install_package: {
    expectsChange: true,
    probe: probePackage,
    act: actInstallPackage,
    rollback: rollbackPackage,
    requires: ["package"],
  },
  enable_device: {
    expectsChange: true,
    probe: probePnpDevice,
    act: actEnableDevice,
    rollback: rollbackEnableDevice,
    requires: ["device"],
  },
  device_status: { expectsChange: false, probe: probePnpDevice, requires: ["device"] },
  vpn_state: { expectsChange: false, probe: probeVpn },
  reconnect_vpn: { expectsChange: true, probe: probeVpn, act: actReconnectVpn },
};

/**
 * `--argv [...]` is the current form and carries argv exactly as built,
 * including arguments with spaces in them. `--args "a b c"` is the old form,
 * still read so a job queued by an older server still runs; it cannot express
 * an argument containing a space, which is why it was replaced.
 */
function parseArgv(raw) {
  const json = raw.match(/--argv (\[.*\])/)?.[1];
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* fall through to the old form rather than run a command with no args */
    }
  }
  return (raw.match(/--args "([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

function parseCommand(command) {
  const raw = String(command || "").trim();
  const name = raw.split(/\s+/)[0] ?? "";
  return {
    name,
    args: {
      app: raw.match(/--app "([^"]+)"/)?.[1],
      limit: Math.min(Number(raw.match(/--limit (\d+)/)?.[1] ?? 15), 50),
      binary: raw.match(/--binary "([^"]+)"/)?.[1],
      argv: parseArgv(raw),
      // Paths and patterns keep their spaces, so they are read from the quoted
      // form rather than split on whitespace like argv.
      fsPath: raw.match(/--path "([^"]*)"/)?.[1],
      pattern: raw.match(/--pattern "([^"]*)"/)?.[1],
      lines: Math.min(Number(raw.match(/--lines (\d+)/)?.[1] ?? 2000), 5000),
      service: raw.match(/--service "([^"]*)"/)?.[1],
      servers: raw.match(/--servers "([^"]*)"/)?.[1],
      // Read from the quoted form: a URL has no spaces, but it does have the
      // `/` and `:` that splitting on whitespace would leave intact and a
      // trailing-quote scan would not.
      url: raw.match(/--url "([^"]*)"/)?.[1],
      server: raw.match(/--server "([^"]*)"/)?.[1],
      port: Number(raw.match(/--port (\d+)/)?.[1] ?? 0),
      package: raw.match(/--package "([^"]+)"/)?.[1],
      device: raw.match(/--device "([^"]+)"/)?.[1],
      item: raw.match(/--item "([^"]+)"/)?.[1],
      // Read as the literal token rather than coerced: an absent flag must stay
      // undefined so `requires` catches it, and "false" must not become falsy on
      // the way through.
      enabled: raw.match(/--enabled (true|false)/)?.[1],
      autoHide: raw.match(/--autohide (true|false)/)?.[1],
      name: raw.match(/--name "([^"]*)"/)?.[1],
    },
  };
}

// ---- the envelope ----------------------------------------------------------

const VOLATILE_FACTS = new Set(["responding"]);

function diffProbes(probes) {
  const diff = [];
  const seen = new Set();
  for (let i = 1; i < probes.length; i++) {
    const before = probes[i - 1].facts;
    const after = probes[i].facts;
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (VOLATILE_FACTS.has(field)) continue;
      if (String(before[field] ?? null) === String(after[field] ?? null)) continue;
      const key = `${field}:${before[field]}:${after[field]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      diff.push({ field, before: before[field] ?? null, after: after[field] ?? null });
    }
  }
  return diff;
}

function summarizeEffect(diff, probes, expectsChange) {
  if (diff.length > 0) {
    return diff.map((d) => `${d.field} ${d.before ?? "null"} → ${d.after ?? "null"}`).join(", ");
  }
  if (!expectsChange) {
    const last = probes[probes.length - 1];
    return last ? `observed ${Object.entries(last.facts).map(([k, v]) => `${k}=${v}`).join(" · ")}` : "no state read";
  }
  return "device state identical before and after";
}

async function executeJob(job) {
  const startedAt = Date.now();
  const { name, args } = parseCommand(job.allowlistedCommand);
  const handler = HANDLERS[name];

  const envelope = {
    jobId: job.id,
    command: job.allowlistedCommand,
    host: AGENT_HOSTNAME,
    os: AGENT_OS,
    agentVersion: AGENT_VERSION,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    expectsChange: Boolean(handler?.expectsChange),
    probes: [],
    commands: [],
    effect: { changed: false, diff: [], summary: "" },
  };

  const finish = (result) => {
    envelope.finishedAt = Date.now();
    envelope.durationMs = envelope.finishedAt - startedAt;
    return { ...result, envelope };
  };

  if (!handler) {
    return finish({ ok: false, error: `Command is not allowlisted: ${job.allowlistedCommand}` });
  }

  for (const required of handler.requires ?? []) {
    if (!args[required]) return finish({ ok: false, error: `missing --${required} argument` });
  }

  const ctx = { commands: envelope.commands, probes: envelope.probes };
  const takeProbe = async (label) => {
    const probe = await handler.probe(ctx, label, args);
    envelope.probes.push(probe);
    return probe;
  };

  let result;
  // How many probes count toward "did this change anything". A rollback appends
  // more, and those describe the undo, not the effect.
  let effectProbeCount = Infinity;

  if (handler.act) {
    const before = await takeProbe("before");
    result = await handler.act(ctx, args, { probeNow: takeProbe });
    await takeProbe("after");

    // The transaction. Until now a write that failed verification reported
    // no_effect and left the machine wherever it landed — half-applied, with
    // nobody told which half. If the before/after probes agree, the change did
    // not take, so put the machine back rather than leaving it mid-flight.
    //
    // Only for handlers that declare a rollback: a `reversible: "none"`
    // capability has nothing to run here, and inventing one would be worse than
    // the problem.
    //
    // Not when the act itself reported failure. This transaction is for "the
    // action claimed success and the machine disagrees" — an act that says it
    // failed, next to probes that agree nothing moved, leaves nothing to
    // reverse, and running the undo anyway can only introduce a change nobody
    // authorised. `install_package` found this: a refused install fired
    // `winget uninstall`, which failed, and the rollback's error REPLACED the
    // real reason on the ticket.
    if (handler.expectsChange && handler.rollback && result?.ok !== false) {
      const landed = diffProbes(envelope.probes).length > 0;
      if (!landed) {
        envelope.rolledBack = true;
        // Everything from here on is restoration, not effect. Without this the
        // after-rollback probe joins the diff and a SUCCESSFUL restore reads as
        // "the machine changed", i.e. as the fix having worked.
        effectProbeCount = envelope.probes.length;
        try {
          const undo = await handler.rollback(ctx, args, before);
          await takeProbe("after-rollback");
          envelope.rollbackOk = undo?.ok !== false;
          if (!envelope.rollbackOk) {
            // Rollback failing is the one case a person must see: the machine is
            // now in a state neither the plan nor the rollback accounted for.
            envelope.rollbackError = undo?.error || "rollback reported not-ok";
            result = {
              ok: false,
              error: `change did not take and the rollback also failed: ${envelope.rollbackError}`,
            };
          }
        } catch (err) {
          envelope.rollbackOk = false;
          envelope.rollbackError = err.message;
          result = { ok: false, error: `change did not take and the rollback threw: ${err.message}` };
        }
      }
    }
  } else if (handler.probe) {
    const probe = await takeProbe("observed");
    result = {
      ok: true,
      output: Object.entries(probe.facts)
        .map(([k, v]) => `${k}: ${v ?? "null"}`)
        .join("\n"),
    };
  } else {
    result = await handler.collect(ctx, args, job);
  }

  const effectProbes = envelope.probes.slice(0, effectProbeCount);
  envelope.effect.diff = diffProbes(effectProbes);
  envelope.effect.changed = envelope.effect.diff.length > 0;
  envelope.effect.summary = summarizeEffect(envelope.effect.diff, effectProbes, envelope.expectsChange);

  if (envelope.rolledBack) {
    envelope.effect.summary =
      envelope.rollbackOk === false
        ? `the change did not take AND the rollback failed (${envelope.rollbackError}) — the machine needs a person`
        : `the change did not take; the machine was rolled back to its prior state`;
  }

  const output = [result.output, result.note ? `note: ${result.note}` : null].filter(Boolean).join("\n");
  return finish({ ...result, output: output || undefined });
}

// ---- device journal --------------------------------------------------------
// Written on the machine itself, before anything is uploaded. This is the
// fingerprint that outlives the app: if the network drops, the server is
// wiped, or someone doubts what the agent did, the record is still here.

function journalDir() {
  if (process.env.LOCAL_AGENT_JOURNAL_DIR) return process.env.LOCAL_AGENT_JOURNAL_DIR;
  if (IS_WINDOWS) return path.join(process.env.ProgramData || "C:\\ProgramData", "BoltIt", "journal");
  return path.join(os.homedir(), ".bolt-it", "journal");
}

function appendJournal(envelope, result) {
  const dir = journalDir();
  const day = new Date(envelope.startedAt).toISOString().slice(0, 10);
  const file = path.join(dir, `${day}.jsonl`);
  const record = {
    ...envelope,
    journalPath: file,
    ok: result.ok !== false,
    error: result.error ?? null,
    output: result.output ?? null,
    writtenAt: Date.now(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    return file;
  } catch (err) {
    console.warn(`[local-agent] journal write failed (${file}): ${err.message}`);
    return null;
  }
}

// ---- change record + system log: fingerprints a human finds without us -------
// The journal above is our own format. These two are for the sysadmin who does
// NOT know this tool exists: a per-change record with the exact command to undo
// it, and a line in the OS's own event log so it surfaces in `log show` (macOS)
// or Event Viewer (Windows) next to everything else that touched the machine.
// Both are best-effort — a fingerprint that fails to write must never fail the
// job whose effect is already real.

function changesDir() {
  if (IS_WINDOWS) return path.join(process.env.ProgramData || "C:\\ProgramData", "BoltIt", "changes");
  return path.join(os.homedir(), ".bolt-it", "changes");
}

// The reversal for a change, derived from the probes taken around it. For a DNS
// change the "before" resolver list is the undo argument; for anything else we
// still record the field-level before/after so a technician can reverse by hand.
function revertFor(command, envelope) {
  const before = envelope.probes[0]?.facts ?? {};
  if (command.startsWith("set_dns_servers")) {
    const svc = before.service ?? "Wi-Fi";
    const prior = before.resolvers ? before.resolvers.split(",").join(" ") : "empty";
    return IS_WINDOWS
      ? `netsh interface ipv4 set dnsservers "${svc}" ${prior === "empty" ? "dhcp" : `static ${prior.split(" ")[0]} primary`}`
      : `networksetup -setdnsservers "${svc}" ${prior}`;
  }
  return `restore fields: ${envelope.effect.diff
    .map((d) => `${d.field} back to ${d.before ?? "unset"}`)
    .join("; ") || "(no field-level diff recorded)"}`;
}

function recordChange(job, envelope, result) {
  // Only real state changes get a change record — a read or a no-effect run has
  // nothing to undo.
  if (!envelope.expectsChange || !envelope.effect.changed) return null;
  const dir = changesDir();
  const file = path.join(dir, `${job.ticketId || "adhoc"}.jsonl`);
  const record = {
    at: Date.now(),
    ticketId: job.ticketId ?? null,
    jobId: job.id,
    host: envelope.host,
    capability: humanLabel(job.allowlistedCommand),
    command: job.allowlistedCommand,
    before: envelope.probes[0]?.facts ?? {},
    after: envelope.probes[envelope.probes.length - 1]?.facts ?? {},
    effect: envelope.effect.summary,
    revert: revertFor(String(job.allowlistedCommand), envelope),
    ok: result.ok !== false,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
    return { file, revert: record.revert };
  } catch (err) {
    console.warn(`[local-agent] change record write failed (${file}): ${err.message}`);
    return null;
  }
}

// A line in the OS's own log, in the place a sysadmin actually looks:
//  - Windows: the Application event log, source "BoltIt" (Event Viewer).
//  - macOS: ~/Library/Logs/bolt-it.log, which Console.app shows under
//    "Log Reports". `logger` is also emitted, but modern macOS filters external
//    logger output out of `log show`, so the file is the reliable fingerprint.
function writeSystemLog(job, envelope, result) {
  const verdict = result.ok === false ? "FAILED" : envelope.effect.changed ? "CHANGED" : "no-effect";
  const msg = `bolt-it ${job.ticketId || "adhoc"} ${job.id} ${verdict} :: ${job.allowlistedCommand} :: ${envelope.effect.summary}`;
  try {
    if (IS_WINDOWS) {
      const script =
        `if (-not [System.Diagnostics.EventLog]::SourceExists('BoltIt')) { New-EventLog -LogName Application -Source 'BoltIt' }; ` +
        `Write-EventLog -LogName Application -Source 'BoltIt' -EventId 1000 -EntryType ${result.ok === false ? "Error" : "Information"} -Message "${psEscape(msg)}"`;
      spawn("powershell", psArgs(script), { stdio: "ignore", detached: true }).unref();
    } else {
      const logFile = path.join(os.homedir(), "Library", "Logs", "bolt-it.log");
      try {
        fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`, "utf8");
      } catch {
        // Directory missing on a stripped-down system — fall through to logger.
      }
      spawn("logger", ["-p", "user.notice", "-t", "bolt-it", msg], { stdio: "ignore", detached: true }).unref();
    }
  } catch (err) {
    console.warn(`[local-agent] system-log write failed: ${err.message}`);
  }
}

// ---- console + desktop feedback -------------------------------------------

// Behind IS_ENTRYPOINT with the poll loop: a test harness imports this module
// to drive the real executeJob, and a startup banner in the test output is
// noise that makes a real failure harder to see.
if (IS_ENTRYPOINT) {
  console.log(`${ANSI.cyan}${ANSI.bold}╔════════════════════════════════════════════════════════════╗${ANSI.reset}`);
  console.log(`${ANSI.cyan}${ANSI.bold}║          🛡   LOCAL SANDBOX AGENT — STARTED                ║${ANSI.reset}`);
  console.log(`${ANSI.cyan}${ANSI.bold}╚════════════════════════════════════════════════════════════╝${ANSI.reset}`);
  console.log(`${ANSI.bold}  host:${ANSI.reset}    ${AGENT_HOSTNAME}`);
  console.log(`${ANSI.bold}  os:${ANSI.reset}      ${AGENT_OS}`);
  console.log(`${ANSI.bold}  node:${ANSI.reset}    ${process.version}`);
  console.log(`${ANSI.bold}  app:${ANSI.reset}     ${appUrl}`);
  console.log(`${ANSI.bold}  poll:${ANSI.reset}    every ${intervalMs}ms`);
  console.log(`${ANSI.bold}  journal:${ANSI.reset} ${journalDir()}`);
  console.log(`${ANSI.green}  Ready — waiting for jobs from the cloud agent…${ANSI.reset}\n`);
}

function notify(title, subtitle, message) {
  if (!IS_MAC) return;
  const safe = (s) => String(s).replace(/"/g, '\\"');
  const script = `display notification "${safe(message)}" with title "${safe(title)}" subtitle "${safe(subtitle)}"`;
  spawn("osascript", ["-e", script], { stdio: "ignore", detached: true }).unref();
}

function chime(soundName) {
  if (!IS_MAC) return;
  spawn("afplay", [`/System/Library/Sounds/${soundName}.aiff`], { stdio: "ignore", detached: true }).unref();
}

function say(phrase) {
  if (!IS_MAC || !speak) return;
  spawn("say", [phrase], { stdio: "ignore", detached: true }).unref();
}

function bigBanner(label, color) {
  const line = "═".repeat(60);
  console.log(`${color}${ANSI.bold}╔${line}╗${ANSI.reset}`);
  const padded = `║  ${label}`.padEnd(62, " ") + "║";
  console.log(`${color}${ANSI.bold}${padded}${ANSI.reset}`);
  console.log(`${color}${ANSI.bold}╚${line}╝${ANSI.reset}`);
}

function printProof(envelope) {
  for (const probe of envelope.probes) {
    const facts = Object.entries(probe.facts)
      .map(([k, v]) => `${k}=${v ?? "null"}`)
      .join(" · ");
    console.log(`${ANSI.dim}  probe ${probe.label}:${ANSI.reset} ${facts}`);
  }
  for (const cmd of envelope.commands) {
    console.log(`${ANSI.dim}  exec  exit=${cmd.exitCode} (${cmd.durationMs}ms):${ANSI.reset} ${cmd.argv.join(" ").slice(0, 120)}`);
  }
}

// ---- server protocol -------------------------------------------------------

/**
 * Whether the server is reachable is ONE fact, not two.
 *
 * The heartbeat and the job poll dial the same host on the same cycle and fail
 * together, so reporting each of them, every three seconds, produced two lines
 * of "fetch failed" per cycle forever — and "fetch failed" is undici's generic
 * message with the actual reason (ECONNREFUSED, EHOSTUNREACH, ETIMEDOUT) hidden
 * on err.cause. A screen full of it names neither the URL that failed nor why,
 * which is everything a person needs to fix it.
 *
 * So: say it once, with the URL and the real cause, and say it again only when
 * the answer changes.
 */
let unreachableSince = null;

function isNetworkError(err) {
  return Boolean(err?.cause);
}

function reportUnreachable(err) {
  if (unreachableSince) return;
  unreachableSince = Date.now();
  const cause = err.cause?.code || err.cause?.message || err.message;
  console.error(`[local-agent] cannot reach ${appUrl} — ${cause}`);
  console.error(
    `[local-agent] the app URL lives in AppUrl in C:\\ProgramData\\BoltIt\\config.json ` +
      `on Windows, or IT_SUPPORT_APP_URL in the environment. It must be the address of ` +
      `the machine running the app as seen FROM HERE — not localhost, which is this machine.`,
  );
}

let starvedReason = null;

function reportStarved(reason) {
  if (starvedReason === reason) return;
  starvedReason = reason;
  console.error(`[local-agent] the server is handing me no work — ${reason}`);
}

function reportReachable() {
  if (!unreachableSince) return;
  const seconds = Math.round((Date.now() - unreachableSince) / 1000);
  unreachableSince = null;
  console.log(`[local-agent] ${appUrl} is answering again (was unreachable for ${seconds}s)`);
}

// ---- the local console -----------------------------------------------------
/**
 * A window, on the machine, for the person sitting at it.
 *
 * Everything this agent does already leaves a fingerprint — the journal, the
 * change records with their undo commands, the OS log — but all of it is a file
 * path mentioned on a ticket the employee may never open. Someone whose laptop
 * is being worked on could not see that it was connected, what was running, or
 * how to stop it, without reading a terminal.
 *
 * Three rules hold this up:
 *
 *  - **Loopback only.** It binds 127.0.0.1, and every request is checked for a
 *    loopback Host as well, because binding alone does not stop a hostile page
 *    from pointing a name at 127.0.0.1 and reading this through the browser the
 *    person already has open. There is no auth here and there must never need to
 *    be: nothing off this machine can reach it.
 *  - **It never serves the token.** Reachability, identity, work and history —
 *    never the credential that would let a caller impersonate this device.
 *  - **Pause is real or it is not offered.** It rides on the heartbeat so the
 *    service sees a paused machine as paused. A local switch the server cannot
 *    see would mean queued work silently never running, and a technician sent to
 *    look at the network instead of at the pause.
 */
const UI_PORT = Number(process.env.LOCAL_AGENT_UI_PORT || 7337);
const UI_ENABLED = process.env.LOCAL_AGENT_UI !== "0";

/** Set from the console. Checked in poll() before any job is claimed. */
let paused = false;
let lastPollOkAt = null;
/** Binaries a technician approved for the job most recently handed to us. */
let lastGrantedBinaries = [];

/** The most recent change records across all tickets, newest first. */
function recentChanges(limit = 12) {
  const dir = changesDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      // A truncated final line is normal on an append-only file. Skip it.
      try {
        out.push(JSON.parse(line));
      } catch {
        /* not a complete record yet */
      }
    }
  }
  return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, limit);
}

function consoleState() {
  return {
    server: {
      url: appUrl,
      reachable: unreachableSince === null,
      unreachableSince,
      lastPollOkAt,
    },
    device: {
      hostname: AGENT_HOSTNAME,
      os: AGENT_OS,
      version: AGENT_VERSION,
      build: AGENT_BUILD,
    },
    paused,
    currentJob,
    grantedBinaries: lastGrantedBinaries,
    changes: recentChanges(),
  };
}

/**
 * A request that did not come from this machine's own browser. Binding to
 * loopback stops the network; this stops a page on another origin from using the
 * person's own browser as the way in (DNS rebinding).
 */
function fromLoopback(req) {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function startConsole() {
  const server = http.createServer((req, res) => {
    if (!fromLoopback(req)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("this console answers only on loopback\n");
      return;
    }
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(CONSOLE_HTML);
      return;
    }
    if (req.method === "GET" && url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(consoleState()));
      return;
    }
    if (req.method === "POST" && (url === "/api/pause" || url === "/api/resume")) {
      paused = url === "/api/pause";
      console.log(`[local-agent] ${paused ? "paused" : "resumed"} from the local console`);
      // Tell the server now rather than on the next tick: someone who just hit
      // pause should see the machine go quiet in the app immediately.
      void sendHeartbeat();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ paused }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found\n");
  });

  // A console that cannot bind must never take the agent down with it. The usual
  // cause is a second agent already running, and that one owns the port.
  server.on("error", (err) => {
    console.warn(`[local-agent] local console not started: ${err.message}`);
  });
  server.listen(UI_PORT, "127.0.0.1", () => {
    console.log(`[local-agent] console on http://127.0.0.1:${UI_PORT}`);
  });
  return server;
}

// Built with createElement and textContent throughout, never innerHTML: every
// value on this page — a hostname, a command, an undo line — comes off the
// machine or off a job, and none of it is markup.
const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Bolt-it agent</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
         background:#0e1116; color:#e6e9ef; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:560px; margin:0 auto; padding:22px 20px 40px; }
  .hero { display:flex; align-items:center; gap:14px; padding:18px;
          border-radius:14px; background:#161b22; border:1px solid #232a35; }
  .dot { width:12px; height:12px; border-radius:50%; flex:none; }
  .on { background:#2ea043; animation:pulse 2s infinite; }
  .off { background:#f85149; }
  .idle { background:#8b93a1; }
  @keyframes pulse { 0% { box-shadow:0 0 0 0 rgba(46,160,67,.7); }
                     70% { box-shadow:0 0 0 9px rgba(46,160,67,0); }
                     100% { box-shadow:0 0 0 0 rgba(46,160,67,0); } }
  @media (prefers-reduced-motion: reduce) { .on { animation:none; } }
  .state { font-size:16px; font-weight:600; }
  .sub { color:#8b93a1; font-size:12px; margin-top:2px; word-break:break-all; }
  button { font:inherit; font-weight:600; border:0; border-radius:9px;
           padding:9px 16px; cursor:pointer; flex:none; }
  .pause { background:#30363d; color:#e6e9ef; }
  .resume { background:#2ea043; color:#fff; }
  section { margin-top:20px; }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.9px;
       color:#8b93a1; margin:0 0 8px; font-weight:600; }
  .card { background:#161b22; border:1px solid #232a35; border-radius:12px; padding:14px; }
  .kv { display:flex; justify-content:space-between; gap:12px; padding:4px 0; }
  .k { color:#8b93a1; flex:none; }
  .v { text-align:right; word-break:break-all; }
  .job { border-left:3px solid #388bfd; padding-left:11px; }
  .chg { padding:10px 0; border-bottom:1px solid #232a35; }
  .chg:last-child { border-bottom:0; padding-bottom:0; }
  .chg-top { display:flex; justify-content:space-between; gap:10px; }
  .muted { color:#8b93a1; font-size:12px; }
  code { display:block; margin-top:6px; background:#0e1116; border:1px solid #232a35;
         border-radius:7px; padding:7px 9px; font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;
         color:#e3b341; white-space:pre-wrap; word-break:break-all; }
  .empty { color:#8b93a1; font-size:13px; }
  .pill { display:inline-block; font-size:11px; padding:2px 8px; margin:2px 4px 2px 0;
          border-radius:999px; background:#1f2630; color:#c9d1d9; }
</style></head>
<body><div class="wrap">
  <div class="hero">
    <span class="dot idle" id="dot"></span>
    <div style="flex:1;min-width:0">
      <div class="state" id="state">Starting…</div>
      <div class="sub" id="statesub"></div>
    </div>
    <button class="pause" id="toggle">Pause</button>
  </div>
  <section><h2>This machine</h2><div class="card" id="device"></div></section>
  <section><h2>Right now</h2><div class="card" id="job"></div></section>
  <section><h2>Approved for the current ticket</h2><div class="card" id="grants"></div></section>
  <section><h2>Changes made here</h2><div class="card" id="changes"></div></section>
</div>
<script>
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function kv(parent, k, v) {
    var row = el("div", "kv");
    row.appendChild(el("span", "k", k));
    row.appendChild(el("span", "v", v));
    parent.appendChild(row);
  }
  function ago(ts) {
    if (!ts) return "never";
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    return Math.round(s / 3600) + "h ago";
  }

  function paint(d) {
    var dot = document.getElementById("dot");
    var state = document.getElementById("state");
    var sub = document.getElementById("statesub");
    var btn = document.getElementById("toggle");

    if (d.paused) {
      dot.className = "dot idle";
      state.textContent = "Paused";
      sub.textContent = "No work will run on this machine until you resume.";
    } else if (d.server.reachable) {
      dot.className = "dot on";
      state.textContent = d.currentJob ? "Working" : "Connected";
      sub.textContent = d.server.url;
    } else {
      dot.className = "dot off";
      state.textContent = "Can't reach IT";
      sub.textContent = d.server.url + " \\u2014 unreachable since " + ago(d.server.unreachableSince);
    }
    btn.textContent = d.paused ? "Resume" : "Pause";
    btn.className = d.paused ? "resume" : "pause";

    var dev = document.getElementById("device");
    clear(dev);
    kv(dev, "Name", d.device.hostname);
    kv(dev, "System", d.device.os);
    kv(dev, "Agent", d.device.version);
    kv(dev, "Build", d.device.build);
    kv(dev, "Last contact", ago(d.server.lastPollOkAt));

    var job = document.getElementById("job");
    clear(job);
    if (d.currentJob) {
      var box = el("div", "job");
      box.appendChild(el("div", null, d.currentJob.command));
      box.appendChild(el("div", "muted", "started " + ago(d.currentJob.startedAt)));
      job.appendChild(box);
    } else {
      job.appendChild(el("div", "empty", "Nothing running."));
    }

    var grants = document.getElementById("grants");
    clear(grants);
    var granted = d.grantedBinaries || [];
    if (granted.length) {
      granted.forEach(function (b) { grants.appendChild(el("span", "pill", b)); });
    } else {
      grants.appendChild(el("div", "empty", "No extra diagnostics approved."));
    }

    var changes = document.getElementById("changes");
    clear(changes);
    var list = d.changes || [];
    if (!list.length) {
      changes.appendChild(el("div", "empty", "Nothing on this machine has been changed."));
      return;
    }
    list.forEach(function (c) {
      var row = el("div", "chg");
      var top = el("div", "chg-top");
      top.appendChild(el("strong", null, c.capability));
      top.appendChild(el("span", "muted", ago(c.at)));
      row.appendChild(top);
      row.appendChild(el("div", "muted", c.effect));
      row.appendChild(el("div", "muted", "To undo this:"));
      row.appendChild(el("code", null, c.revert));
      changes.appendChild(row);
    });
  }

  function tick() {
    fetch("/api/state").then(function (r) { return r.json(); }).then(paint).catch(function () {
      document.getElementById("dot").className = "dot off";
      document.getElementById("state").textContent = "Agent not running";
      document.getElementById("statesub").textContent = "";
    });
  }

  document.getElementById("toggle").addEventListener("click", function () {
    var resuming = this.textContent === "Resume";
    fetch(resuming ? "/api/resume" : "/api/pause", { method: "POST" }).then(tick);
  });

  tick();
  setInterval(tick, 1000);
</script></body></html>`;

/**
 * Who I am, on every request.
 *
 * The build id is the only thing that tells two agents apart — `AGENT_VERSION`
 * is a string that has not changed in months. An agent that predates this
 * header sends neither, and that absence is itself the signal: the server hands
 * it no work, because a build old enough to lack these headers is old enough to
 * lack half the handler table, and the failure it produces on a real ticket is
 * `Command is not allowlisted` — indistinguishable, from the graph's side, from
 * a capability that genuinely does not exist.
 */
/**
 * What THIS build can actually do, in the machine's own words.
 *
 * The server used to plan against a capability registry that describes what the
 * system can do in principle, with no idea what the agent on the other end
 * implements. So the strategist authorised `fs.grep` on a machine whose agent
 * had no `fs_grep` handler, the operator retried it, and three looks went on
 * theorising about an allowlist that was never the problem.
 *
 * Publishing the surface closes that gap for good: whatever handlers and
 * binaries a future build adds or drops, the server learns them from the device
 * rather than assuming them. Nothing here is a permission — it is a description,
 * and the agent still enforces every rule on the way in.
 */
function describeSurface() {
  return {
    handlers: Object.keys(HANDLERS).sort(),
    binaries: {
      // Runnable now, no decision needed.
      default: Object.keys(READ_ONLY_BINARIES).sort(),
      // Runnable for one ticket once a technician — or AUTONOMY=full — says so.
      grantable: Object.keys(GRANTABLE_BINARIES).sort(),
    },
  };
}

function identityHeaders() {
  return {
    Authorization: `Bearer ${token}`,
    "x-agent-build": AGENT_BUILD,
    "x-agent-version": AGENT_VERSION,
  };
}

async function sendHeartbeat() {
  try {
    await fetch(`${appUrl}/api/agent/heartbeat`, {
      method: "POST",
      headers: {
        ...identityHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostname: AGENT_HOSTNAME,
        os: AGENT_OS,
        version: AGENT_VERSION,
        build: AGENT_BUILD,
        surface: describeSurface(),
        // Paused is reported, not just obeyed. A machine that has stopped taking
        // work must look stopped to the service, or the next queued job simply
        // never runs and reads as an unreachable agent.
        paused,
        currentJob,
      }),
    });
  } catch (err) {
    // The poll that follows dials the same host. Let it be the one that speaks.
    if (!isNetworkError(err)) console.warn(`[local-agent] heartbeat failed: ${err.message}`);
  }
}

async function poll() {
  void sendHeartbeat();
  // Paused: keep the heartbeat going so the machine is still visibly here and
  // still reports why it is quiet, but claim nothing. Work stays queued on the
  // server, where a technician can see it, rather than being claimed by an agent
  // that will not run it.
  if (paused) return;
  try {
    const res = await fetch(`${appUrl}/api/agent/jobs`, {
      headers: identityHeaders(),
    });
    // Any answer at all, including a refusal, settles the question this tracks.
    // Clearing it only on 200 would leave a machine whose token is wrong
    // reporting the host as unreachable, which sends the wrong person to look.
    reportReachable();
    lastPollOkAt = Date.now();
    if (!res.ok) {
      console.error(`[local-agent] poll failed ${res.status}: ${await res.text()}`);
      return;
    }
    const data = await res.json();

    // The server refused to hand this build any work. Say so once — a silent
    // idle agent looks identical to a quiet ticket queue, and that is exactly
    // how an old process kept taking jobs next to a current one for a day.
    if (data.staleBuild) {
      reportStarved(data.reason || "this build is not the one the server is serving");
      if (!currentJob) {
        console.log(`[local-agent] exiting so the supervisor pulls build ${data.agentBuild}`);
        process.exit(0);
      }
      return;
    }
    starvedReason = null;

    for (const job of data.jobs ?? []) {
      await handleJob(job);
    }

    // Auto-update. This cycle's jobs were drained first, so nothing already
    // claimed is abandoned. If the server is now serving a different build than
    // the one I am, and I am not a hand-run dev copy, and nothing is in flight,
    // exit cleanly — the supervisor loop (run-agent.ps1) re-pulls the current
    // agent on exit. Bounded staleness after a deploy is one poll interval.
    const serverBuild = typeof data.agentBuild === "string" ? data.agentBuild : null;
    if (AGENT_BUILD !== "dev" && serverBuild && serverBuild !== AGENT_BUILD && !currentJob) {
      console.log(
        `[local-agent] server is serving build ${serverBuild}, I am ${AGENT_BUILD} — ` +
          `exiting so the supervisor pulls the current agent`,
      );
      process.exit(0);
    }
  } catch (err) {
    if (isNetworkError(err)) reportUnreachable(err);
    else console.error(`[local-agent] ${err.message}`);
    if (currentJob) {
      currentJob = null;
      void sendHeartbeat();
    }
  }
}

async function handleJob(job) {
  const startedAt = Date.now();
  const label = humanLabel(job.allowlistedCommand);
  currentJob = { id: job.id, command: label, startedAt };
  // Surfaced in the local console so the person at the keyboard can see which
  // extra diagnostic a technician approved for the ticket touching their machine.
  lastGrantedBinaries = Array.isArray(job.grantedBinaries) ? job.grantedBinaries : [];
  void sendHeartbeat();

  bigBanner(`▶  ${label.toUpperCase()} on ${AGENT_HOSTNAME}`, ANSI.bgCyan);
  console.log(`${ANSI.cyan}  doing:${ANSI.reset}   ${label}`);
  console.log(`${ANSI.cyan}  user:${ANSI.reset}    ${job.targetUserEmail}`);
  console.log(`${ANSI.cyan}  audit:${ANSI.reset}   ${job.allowlistedCommand}`);
  console.log("");
  notify("🛡 Local Agent", AGENT_HOSTNAME, label);
  chime("Glass");
  say(`${label} on ${AGENT_HOSTNAME.split(".")[0]}`);

  // executeJob is contracted not to throw. This is the backstop for the one
  // that does anyway: previously an unexpected throw here rejected handleJob,
  // propagated to poll()'s catch, and left the job `claimed` forever — the
  // server then timed it out at 45s and reported it as an offline agent, which
  // sends a technician to look at the network instead of at the bug.
  let result;
  try {
    result = await executeJob(job);
  } catch (err) {
    console.error(`${ANSI.red}  agent error:${ANSI.reset} ${err.message}`);
    result = {
      ok: false,
      error: `local agent threw while running the job: ${err.message}`,
      envelope: {
        jobId: job.id,
        command: job.allowlistedCommand,
        host: AGENT_HOSTNAME,
        os: AGENT_OS,
        agentVersion: AGENT_VERSION,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        expectsChange: false,
        probes: [],
        commands: [],
        effect: { changed: false, diff: [], summary: "the agent threw before it could report" },
      },
    };
  }
  const envelope = result.envelope;
  printProof(envelope);

  // Journal first: the device's own record must not depend on the upload.
  envelope.journalPath = appendJournal(envelope, result) ?? undefined;
  // Then the fingerprints a sysadmin finds without knowing this tool exists: a
  // per-change record carrying the undo command, and a line in the OS event log.
  const change = recordChange(job, envelope, result);
  writeSystemLog(job, envelope, result);
  if (change) {
    // Carry the fingerprint onto the ticket too, so the audit trail on the
    // server names the exact undo command, not just "something changed".
    envelope.changeRecordPath = change.file;
    envelope.revertCommand = change.revert;
    console.log(`${ANSI.dim}  change:${ANSI.reset} ${change.file}`);
    console.log(`${ANSI.dim}  revert:${ANSI.reset} ${change.revert}`);
  }

  const ms = Date.now() - startedAt;
  const noEffect = result.ok !== false && envelope.expectsChange && !envelope.effect.changed;

  try {
    await fetch(`${appUrl}/api/agent/jobs/${job.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // Redacted as a whole, not field by field. Redaction used to be applied
      // to fs_read and fs_grep output only, so a credential echoed by an
      // allowlisted binary, or captured in the raw stdout kept on every command
      // record, went out in the clear. redactDeep covers every string in the
      // payload, including fields added later.
      body: JSON.stringify(
        redactDeep({
          ok: result.ok !== false,
          output: result.output,
          error: result.error,
          // The agent knows things the server cannot infer: "the employee
          // declined" and "there was nobody to ask" both come back as a failed
          // screenshot, and they have different owners.
          failureKind: result.failureKind,
          screenshotBase64: result.screenshotBase64,
          consent: result.consent,
          agentHost: AGENT_HOSTNAME,
          agentOs: AGENT_OS,
          envelope,
        }),
      ),
    });
  } catch (err) {
    console.warn(`[local-agent] upload failed (${err.message}) — result is still in ${envelope.journalPath}`);
  }

  currentJob = null;
  void sendHeartbeat();

  if (result.ok === false) {
    bigBanner(`✗  ${label.toUpperCase()} — failed in ${ms}ms — ${result.error ?? "unknown"}`, ANSI.bgRed);
    } else if (noEffect) {
    bigBanner(`⚠  ${label.toUpperCase()} — NO EFFECT, device state unchanged`, ANSI.bgYellow);
  } else {
    bigBanner(`✓  ${label.toUpperCase()} — ${envelope.effect.summary} — ${ms}ms`, ANSI.bgGreen);
  }
  console.log("");
  notify(
    result.ok === false ? "🛡 Local Agent — Failed" : "🛡 Local Agent — Done",
    AGENT_HOSTNAME,
    `${label} (${ms}ms)`,
  );
  chime(result.ok !== false && !noEffect ? "Hero" : "Basso");
}

// Exported so a test harness can drive the real execution path without a server.
// Exported for the test harness. validateReadOnlyCommand and resolveTarget are
// the device-side enforcement — the last line of defence, and until now the only
// part of this system with no tests at all.
export {
  executeJob,
  recordChange,
  writeSystemLog,
  appendJournal,
  HANDLERS,
  parseCommand,
  validateReadOnlyCommand,
  resolveTarget,
  READ_ONLY_BINARIES,
  GRANTABLE_BINARIES,
  describeSurface,
};

if (IS_ENTRYPOINT) {
  if (UI_ENABLED) startConsole();
  await poll();
  setInterval(poll, intervalMs);
}
