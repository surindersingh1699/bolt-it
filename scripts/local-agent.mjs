#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const appUrl = process.env.IT_SUPPORT_APP_URL || "http://localhost:3000";
const token = process.env.LOCAL_AGENT_TOKEN;
const intervalMs = Number(process.env.LOCAL_AGENT_POLL_MS || 3000);
const speak = process.env.LOCAL_AGENT_SPEAK === "1";

if (!token) {
  console.error("LOCAL_AGENT_TOKEN is required.");
  process.exit(1);
}

const AGENT_HOSTNAME = os.hostname();
const AGENT_OS = `${os.platform()} ${os.release()} (${os.arch()})`;
const AGENT_VERSION = "local-agent/0.6.0";
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
  if (c.startsWith("collect_system_info")) return "Collecting computer hardware/OS info";
  if (c.startsWith("app_status ")) return "Checking whether the app is running";
  if (c.startsWith("app_event_logs ")) return "Reading the app's recent error events";
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

// ---- handler table ---------------------------------------------------------
// `expectsChange: true` means the job is a fix: if the before/after probes
// match, the server records `no_effect` instead of success.

const HANDLERS = {
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
  collect_system_info: { expectsChange: false, collect: collectSystemInfo },
  app_status: {
    expectsChange: false,
    probe: (ctx, label, args) => probeProcess(ctx, label, args.app),
    requires: ["app"],
  },
  app_event_logs: { expectsChange: false, collect: collectAppEventLogs, requires: ["app"] },

};

function parseCommand(command) {
  const raw = String(command || "").trim();
  const name = raw.split(/\s+/)[0] ?? "";
  return {
    name,
    args: {
      app: raw.match(/--app "([^"]+)"/)?.[1],
      limit: Math.min(Number(raw.match(/--limit (\d+)/)?.[1] ?? 15), 50),
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
  if (handler.act) {
    await takeProbe("before");
    result = await handler.act(ctx, args, { probeNow: takeProbe });
    await takeProbe("after");
  } else if (handler.probe) {
    const probe = await takeProbe("observed");
    result = {
      ok: true,
      output: Object.entries(probe.facts)
        .map(([k, v]) => `${k}: ${v ?? "null"}`)
        .join("\n"),
    };
  } else {
    result = await handler.collect(ctx, args);
  }

  envelope.effect.diff = diffProbes(envelope.probes);
  envelope.effect.changed = envelope.effect.diff.length > 0;
  envelope.effect.summary = summarizeEffect(envelope.effect.diff, envelope.probes, envelope.expectsChange);

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

// ---- console + desktop feedback -------------------------------------------

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

async function sendHeartbeat() {
  try {
    await fetch(`${appUrl}/api/agent/heartbeat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostname: AGENT_HOSTNAME,
        os: AGENT_OS,
        version: AGENT_VERSION,
        currentJob,
      }),
    });
  } catch (err) {
    console.warn(`[local-agent] heartbeat failed: ${err.message}`);
  }
}

async function poll() {
  void sendHeartbeat();
  try {
    const res = await fetch(`${appUrl}/api/agent/jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[local-agent] poll failed ${res.status}: ${await res.text()}`);
      return;
    }
    const data = await res.json();
    for (const job of data.jobs ?? []) {
      await handleJob(job);
    }
  } catch (err) {
    console.error(`[local-agent] ${err.message}`);
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
  void sendHeartbeat();

  bigBanner(`▶  ${label.toUpperCase()} on ${AGENT_HOSTNAME}`, ANSI.bgCyan);
  console.log(`${ANSI.cyan}  doing:${ANSI.reset}   ${label}`);
  console.log(`${ANSI.cyan}  user:${ANSI.reset}    ${job.targetUserEmail}`);
  console.log(`${ANSI.cyan}  audit:${ANSI.reset}   ${job.allowlistedCommand}`);
  console.log("");
  notify("🛡 Local Agent", AGENT_HOSTNAME, label);
  chime("Glass");
  say(`${label} on ${AGENT_HOSTNAME.split(".")[0]}`);

  const result = await executeJob(job);
  const envelope = result.envelope;
  printProof(envelope);

  // Journal first: the device's own record must not depend on the upload.
  envelope.journalPath = appendJournal(envelope, result) ?? undefined;

  const ms = Date.now() - startedAt;
  const noEffect = result.ok !== false && envelope.expectsChange && !envelope.effect.changed;

  try {
    await fetch(`${appUrl}/api/agent/jobs/${job.id}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ok: result.ok !== false,
        output: result.output,
        error: result.error,
        agentHost: AGENT_HOSTNAME,
        agentOs: AGENT_OS,
        envelope,
      }),
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

await poll();
setInterval(poll, intervalMs);
