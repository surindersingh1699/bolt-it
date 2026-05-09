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
const AGENT_VERSION = "local-agent/0.2.0";
const IS_MAC = os.platform() === "darwin";

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
      currentJob = { id: job.id, command: job.allowlistedCommand, startedAt };
      void sendHeartbeat();

      bigBanner(`▶  EXECUTING ON ${AGENT_HOSTNAME}`, ANSI.bgCyan);
      console.log(`${ANSI.cyan}  job:${ANSI.reset}     ${job.id}`);
      console.log(`${ANSI.cyan}  cmd:${ANSI.reset}     ${job.allowlistedCommand}`);
      console.log(`${ANSI.cyan}  user:${ANSI.reset}    ${job.targetUserEmail}`);
      console.log("");
      notify("🛡 Local Agent — Executing", AGENT_HOSTNAME, job.allowlistedCommand);
      chime("Glass");
      say(`Running diagnostic on ${AGENT_HOSTNAME.split(".")[0]}`);

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
        ? `✓  COMPLETED in ${ms}ms — sent results back to cloud`
        : `✗  FAILED in ${ms}ms — ${result.error ?? "unknown"}`;
      bigBanner(okBanner, result.ok ? ANSI.bgGreen : ANSI.bgRed);
      console.log("");
      notify(
        result.ok ? "✓ Local Agent — Done" : "✗ Local Agent — Failed",
        AGENT_HOSTNAME,
        `${job.allowlistedCommand.split(" ")[0]} (${ms}ms)`,
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
  if (command.startsWith("collect_vpn_diagnostics ")) {
    return {
      ok: true,
      output: [
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
