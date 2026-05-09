#!/usr/bin/env node
import os from "node:os";

const appUrl = process.env.IT_SUPPORT_APP_URL || "http://localhost:3000";
const token = process.env.LOCAL_AGENT_TOKEN;
const intervalMs = Number(process.env.LOCAL_AGENT_POLL_MS || 3000);

if (!token) {
  console.error("LOCAL_AGENT_TOKEN is required.");
  process.exit(1);
}

const AGENT_HOSTNAME = os.hostname();
const AGENT_OS = `${os.platform()} ${os.release()} (${os.arch()})`;
const AGENT_VERSION = "local-agent/0.1.0";

console.log(`[local-agent] host: ${AGENT_HOSTNAME}`);
console.log(`[local-agent] os:   ${AGENT_OS}`);
console.log(`[local-agent] node: ${process.version}`);
console.log(`[local-agent] polling ${appUrl}/api/agent/jobs every ${intervalMs}ms`);

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
      console.log(`[local-agent] claimed ${job.id}: ${job.allowlistedCommand}`);
      const result = await runAllowlisted(job);
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
      console.log(`[local-agent] completed ${job.id}`);
    }
  } catch (err) {
    console.error(`[local-agent] ${err.message}`);
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
