#!/usr/bin/env node
import os from "node:os";
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
const AGENT_VERSION = "local-agent/0.3.0";
const IS_MAC = os.platform() === "darwin";
const IS_WINDOWS = os.platform() === "win32";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  bgCyan: "\x1b[46m\x1b[30m",
  bgGreen: "\x1b[42m\x1b[30m",
  bgRed: "\x1b[41m\x1b[97m",
};

let currentJob = null;

function humanLabel(command) {
  const c = String(command || "");
  if (c.startsWith("collect_vpn_diagnostics ")) return "Inspecting VPN client logs";
  if (c.startsWith("collect_auth_logs ")) return "Reading authentication logs";
  if (c.startsWith("collect_windows_event_logs ")) return "Checking Kerberos ticket status";
  if (c.startsWith("collect_app_logs ")) return "Reviewing application crash logs";
  if (c.startsWith("restart_app ")) {
    const m = c.match(/--app "([^"]+)"/);
    return `Restarting ${m?.[1] || "app"}`;
  }
  if (c.startsWith("clear_app_cache ")) {
    const m = c.match(/--app "([^"]+)"/);
    return `Clearing ${m?.[1] || "app"} cache`;
  }
  if (c.startsWith("toggle_wifi")) return "Toggling Wi-Fi off and on";
  if (c.startsWith("collect_system_info")) return "Collecting computer hardware/OS info";
  return "Running sandboxed diagnostic";
}

function runShell(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
    p.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

function runPowerShell(script) {
  return runShell("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

function psEscape(s) {
  return String(s).replace(/[`"$]/g, "");
}

async function restartApp(appName) {
  return IS_WINDOWS ? restartAppWindows(appName) : restartAppMac(appName);
}

async function restartAppMac(appName) {
  const lines = [];
  lines.push(`requesting quit for "${appName}" via osascript`);
  await runShell("osascript", ["-e", `tell application "${appName}" to quit`]);
  await new Promise((r) => setTimeout(r, 1500));
  lines.push(`reopening "${appName}"`);
  const open = await runShell("open", ["-a", appName]);
  if (open.code !== 0) {
    return { ok: false, output: lines.join("\n"), error: `open failed: ${open.stderr.trim() || open.code}` };
  }
  lines.push(`"${appName}" restarted successfully`);
  return { ok: true, output: lines.join("\n") };
}

async function restartAppWindows(appName) {
  const lines = [];
  const safe = psEscape(appName);
  // Friendly names ("Microsoft Outlook") usually aren't launchable as-is on
  // Windows — try progressively simpler candidates until one starts.
  const candidates = [...new Set([
    safe,
    safe.replace(/^Microsoft\s+/i, ""),
    safe.split(/\s+/).pop(),
    safe.replace(/\s+/g, "").toLowerCase(),
  ])].filter(Boolean);

  for (const cand of candidates) {
    lines.push(`stopping process "${cand}" via PowerShell`);
    await runPowerShell(`Stop-Process -Name "${cand}" -Force -ErrorAction SilentlyContinue`);
  }
  await new Promise((r) => setTimeout(r, 1500));

  for (const cand of candidates) {
    lines.push(`trying to start "${cand}"`);
    const start = await runPowerShell(`Start-Process "${cand}"`);
    if (start.code === 0) {
      lines.push(`"${cand}" restarted successfully`);
      return { ok: true, output: lines.join("\n") };
    }
    lines.push(`  not launchable as "${cand}"`);
  }
  return {
    ok: false,
    output: lines.join("\n"),
    error: `Could not start "${appName}" under any name (tried: ${candidates.join(", ")}). The app may not be installed on this machine, or needs a full .exe path.`,
  };
}

async function clearAppCache(appName) {
  return IS_WINDOWS ? clearAppCacheWindows(appName) : clearAppCacheMac(appName);
}

async function clearAppCacheMac(appName) {
  const lines = [];
  const safeName = appName.replace(/[^a-zA-Z0-9 _-]/g, "");
  const target = `${os.homedir()}/Library/Caches/${safeName}`;
  lines.push(`target cache: ${target}`);
  const ls = await runShell("ls", [target]);
  if (ls.code !== 0) {
    lines.push(`no user cache directory found at ${target} — nothing to clear`);
    return { ok: true, output: lines.join("\n") };
  }
  await runShell("rm", ["-rf", target]);
  lines.push(`cleared ${target}`);
  return { ok: true, output: lines.join("\n") };
}

async function clearAppCacheWindows(appName) {
  const lines = [];
  const safeName = appName.replace(/[^a-zA-Z0-9 _-]/g, "");
  const localAppData = process.env.LOCALAPPDATA || `${os.homedir()}\\AppData\\Local`;
  // Browsers keep their cache under User Data profiles, not <app>\Cache.
  const BROWSER_CACHES = {
    edge: `${localAppData}\\Microsoft\\Edge\\User Data\\Default\\Cache`,
    "microsoft edge": `${localAppData}\\Microsoft\\Edge\\User Data\\Default\\Cache`,
    chrome: `${localAppData}\\Google\\Chrome\\User Data\\Default\\Cache`,
    "google chrome": `${localAppData}\\Google\\Chrome\\User Data\\Default\\Cache`,
  };
  const target = BROWSER_CACHES[safeName.toLowerCase()] ?? `${localAppData}\\${safeName}\\Cache`;
  lines.push(`target cache: ${target}`);
  const check = await runPowerShell(`Test-Path "${target}"`);
  if (!check.stdout.trim().toLowerCase().includes("true")) {
    lines.push(`no cache directory found at ${target} — nothing to clear`);
    return { ok: true, output: lines.join("\n") };
  }
  const size = await runPowerShell(
    `"{0:N1} MB" -f ((Get-ChildItem -Recurse -Force "${target}" -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB)`,
  );
  if (size.code === 0 && size.stdout.trim()) lines.push(`cache size before clear: ${size.stdout.trim()}`);
  await runPowerShell(`Remove-Item -Recurse -Force "${target}" -ErrorAction SilentlyContinue`);
  lines.push(`cleared ${target}`);
  return { ok: true, output: lines.join("\n") };
}

async function collectSystemInfo() {
  return IS_WINDOWS ? collectSystemInfoWindows() : collectSystemInfoMac();
}

async function collectSystemInfoWindows() {
  const lines = [];
  lines.push(`hostname: ${os.hostname()}`);

  const query = `
$osInfo = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cs = Get-CimInstance Win32_ComputerSystem
[PSCustomObject]@{
  computer_name = $cs.Name
  os_caption = $osInfo.Caption
  os_version = $osInfo.Version
  os_build = $osInfo.BuildNumber
  arch = $osInfo.OSArchitecture
  total_ram_bytes = $cs.TotalPhysicalMemory
  free_ram_kib = $osInfo.FreePhysicalMemory
  cpu_name = $cpu.Name
  cpu_cores = $cpu.NumberOfCores
  uptime_seconds = [int]((Get-Date) - $osInfo.LastBootUpTime).TotalSeconds
} | ConvertTo-Json -Compress
`.trim();

  const res = await runPowerShell(query);
  if (res.code === 0 && res.stdout.trim()) {
    try {
      const info = JSON.parse(res.stdout.trim());
      lines.push(`computer_name: ${info.computer_name}`);
      lines.push(`os: ${info.os_caption} ${info.os_version} (build ${info.os_build}, ${info.arch})`);
      lines.push(`ram_total: ${(info.total_ram_bytes / 1024 ** 3).toFixed(2)} GiB`);
      lines.push(`ram_free: ${((info.free_ram_kib * 1024) / 1024 ** 3).toFixed(2)} GiB`);
      lines.push(`cpu: ${info.cpu_name} (${info.cpu_cores} cores)`);
      const uptimeSec = info.uptime_seconds ?? 0;
      const days = Math.floor(uptimeSec / 86400);
      const hours = Math.floor((uptimeSec % 86400) / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      lines.push(`uptime: ${days}d ${hours}h ${mins}m`);
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

async function collectSystemInfoMac() {
  const lines = [];
  const cn = await runShell("scutil", ["--get", "ComputerName"]);
  const computerName = cn.code === 0 ? cn.stdout.trim() : os.hostname();
  lines.push(`computer_name: ${computerName}`);
  lines.push(`hostname: ${os.hostname()}`);

  const sw = await runShell("sw_vers", []);
  if (sw.code === 0) {
    for (const line of sw.stdout.trim().split(/\r?\n/)) {
      lines.push(line.trim().toLowerCase().replace(/:\s*/, ": "));
    }
  } else {
    lines.push(`os: ${os.platform()} ${os.release()} (${os.arch()})`);
  }

  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  const totalGib = (totalMemBytes / 1024 ** 3).toFixed(2);
  const freeGib = (freeMemBytes / 1024 ** 3).toFixed(2);
  lines.push(`ram_total: ${totalGib} GiB`);
  lines.push(`ram_free: ${freeGib} GiB`);

  const cpuModel = os.cpus()?.[0]?.model ?? "unknown";
  lines.push(`cpu: ${cpuModel} (${os.cpus()?.length ?? "?"} cores)`);

  const uptimeSec = Math.round(os.uptime());
  const days = Math.floor(uptimeSec / 86400);
  const hours = Math.floor((uptimeSec % 86400) / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  lines.push(`uptime: ${days}d ${hours}h ${mins}m`);

  if (IS_MAC) {
    const sp = await runShell("system_profiler", ["SPHardwareDataType"]);
    if (sp.code === 0) {
      for (const raw of sp.stdout.split(/\r?\n/)) {
        const line = raw.trim();
        const m = line.match(/^(Model Name|Model Identifier|Chip|Processor Name|Serial Number \(system\)|Hardware UUID):\s*(.+)$/);
        if (m) lines.push(`${m[1].toLowerCase().replace(/[ ()]+/g, "_").replace(/_+$/, "")}: ${m[2]}`);
      }
    }
  }

  return { ok: true, output: lines.join("\n") };
}

async function toggleWifi() {
  return IS_WINDOWS ? toggleWifiWindows() : toggleWifiMac();
}

async function toggleWifiMac() {
  const lines = [];
  lines.push(`turning Wi-Fi off (en0)`);
  const off = await runShell("networksetup", ["-setairportpower", "en0", "off"]);
  if (off.code !== 0) return { ok: false, output: lines.join("\n"), error: off.stderr.trim() };
  await new Promise((r) => setTimeout(r, 1500));
  lines.push(`turning Wi-Fi back on`);
  const on = await runShell("networksetup", ["-setairportpower", "en0", "on"]);
  if (on.code !== 0) return { ok: false, output: lines.join("\n"), error: on.stderr.trim() };
  lines.push(`Wi-Fi cycled`);
  return { ok: true, output: lines.join("\n") };
}

async function toggleWifiWindows() {
  const lines = [];
  lines.push(`turning Wi-Fi off (interface "Wi-Fi")`);
  const off = await runShell("netsh", ["interface", "set", "interface", "Wi-Fi", "admin=disable"]);
  if (off.code !== 0) {
    return {
      ok: false,
      output: lines.join("\n"),
      error: off.stderr.trim() || "toggling Wi-Fi off failed — run the agent as Administrator",
    };
  }
  await new Promise((r) => setTimeout(r, 1500));
  lines.push(`turning Wi-Fi back on`);
  const on = await runShell("netsh", ["interface", "set", "interface", "Wi-Fi", "admin=enable"]);
  if (on.code !== 0) return { ok: false, output: lines.join("\n"), error: on.stderr.trim() };
  lines.push(`Wi-Fi cycled`);
  return { ok: true, output: lines.join("\n") };
}

console.log(`${ANSI.cyan}${ANSI.bold}╔════════════════════════════════════════════════════════════╗${ANSI.reset}`);
console.log(`${ANSI.cyan}${ANSI.bold}║          🛡   LOCAL SANDBOX AGENT — STARTED                ║${ANSI.reset}`);
console.log(`${ANSI.cyan}${ANSI.bold}╚════════════════════════════════════════════════════════════╝${ANSI.reset}`);
console.log(`${ANSI.bold}  host:${ANSI.reset}    ${AGENT_HOSTNAME}`);
console.log(`${ANSI.bold}  os:${ANSI.reset}      ${AGENT_OS}`);
console.log(`${ANSI.bold}  node:${ANSI.reset}    ${process.version}`);
console.log(`${ANSI.bold}  app:${ANSI.reset}     ${appUrl}`);
console.log(`${ANSI.bold}  poll:${ANSI.reset}    every ${intervalMs}ms`);
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

      const result = await runAllowlisted(job);
      const ms = Date.now() - startedAt;

      await fetch(`${appUrl}/api/agent/jobs/${job.id}/complete`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...result,
          agentHost: AGENT_HOSTNAME,
          agentOs: AGENT_OS,
        }),
      });

      currentJob = null;
      void sendHeartbeat();

      const okBanner = result.ok
        ? `✓  ${label.toUpperCase()} — done in ${ms}ms — results sent to cloud`
        : `✗  ${label.toUpperCase()} — failed in ${ms}ms — ${result.error ?? "unknown"}`;
      bigBanner(okBanner, result.ok ? ANSI.bgGreen : ANSI.bgRed);
      console.log("");
      notify(
        result.ok ? "🛡 Local Agent — Done" : "🛡 Local Agent — Failed",
        AGENT_HOSTNAME,
        `${label} (${ms}ms)`,
      );
      chime(result.ok ? "Hero" : "Basso");
    }
  } catch (err) {
    console.error(`[local-agent] ${err.message}`);
    if (currentJob) {
      currentJob = null;
      void sendHeartbeat();
    }
  }
}

async function runAllowlisted(job) {
  const command = String(job.allowlistedCommand || "");
  if (command.startsWith("restart_app ")) {
    const m = command.match(/--app "([^"]+)"/);
    if (!m?.[1]) return { ok: false, error: "missing --app argument" };
    return await restartApp(m[1]);
  }
  if (command.startsWith("clear_app_cache ")) {
    const m = command.match(/--app "([^"]+)"/);
    if (!m?.[1]) return { ok: false, error: "missing --app argument" };
    return await clearAppCache(m[1]);
  }
  if (command.startsWith("toggle_wifi")) {
    return await toggleWifi();
  }
  if (command.startsWith("collect_system_info")) {
    return await collectSystemInfo();
  }
  if (command.startsWith("collect_vpn_diagnostics ")) {
    return {
      ok: true,
      output: [
        "[sample data — this diagnostic is not yet implemented on this agent]",
        "vpn-client.log: AUTH_FAILED after SAML/password change",
        "vpn-profile: gateway=us-west-1.old.acme.test profile_age_days=93",
        "probe: TLS handshake failed certificate_unknown",
        "recommendation: push refreshed VPN profile via MDM and ask user to reconnect",
      ].join("\n"),
    };
  }
  if (command.startsWith("collect_auth_logs ")) {
    return {
      ok: true,
      output: [
        "[sample data — this diagnostic is not yet implemented on this agent]",
        "auth.log: USER_LOGIN failed x5 from known device",
        "auth.log: ACCOUNT_LOCKED threshold=5",
        "recommendation: verify identity, unlock account, reset failed-login counter",
      ].join("\n"),
    };
  }
  if (command.startsWith("collect_windows_event_logs ")) {
    return {
      ok: true,
      output: [
        "[sample data — this diagnostic is not yet implemented on this agent]",
        "Windows Event: Kerberos ticket cache empty",
        "KDC: PREAUTH_FAILED then ticket expired",
        "recommendation: klist purge and renew ticket through management agent",
      ].join("\n"),
    };
  }
  if (command.startsWith("collect_app_logs ")) {
    return {
      ok: true,
      output: [
        "[sample data — this diagnostic is not yet implemented on this agent]",
        `host: ${os.hostname()}`,
        "app log summary: crash signature found in recent application log",
        "recommendation: collect app version, restart app, and attach crash report to ticket",
      ].join("\n"),
    };
  }
  return {
    ok: false,
    error: `Command is not allowlisted: ${command}`,
  };
}

await poll();
setInterval(poll, intervalMs);
