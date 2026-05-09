"use server";

import { insertRunbook } from "@/lib/data";
import { addMemory } from "@/lib/integrations/hyperspell";
import { getCurrentWorkspaceId } from "@/lib/workspace";
import { createTicket } from "./tickets";

export interface LogAnalysisResult {
  ticketId: string;
  title: string;
  severity: "low" | "medium" | "high";
  rootCause: string;
  importantDetails: string[];
  evidence: string[];
  suggestedFixes: string[];
  userReply: string;
  savedPersonMemory: boolean;
  savedCompanyRunbook: boolean;
  memoryId?: string;
  runbookId?: string;
}

export async function analyzeLogsAction(formData: FormData): Promise<LogAnalysisResult> {
  const reporter = String(formData.get("reporter") || "Demo guest");
  const reporterEmail = String(formData.get("reporterEmail") || "guest@demo.local");
  const issue = String(formData.get("issue") || "Log analysis");
  const rawLogs = String(formData.get("logs") || "");
  const saveScope = String(formData.get("saveScope") || "both");

  const analysis = analyzeLogs(issue, rawLogs);
  const ticketBody = [
    issue,
    "",
    "Log analyzer findings:",
    `Root cause: ${analysis.rootCause}`,
    `Severity: ${analysis.severity}`,
    "",
    "Important details:",
    ...analysis.importantDetails.map((d) => `- ${d}`),
    "",
    "Evidence:",
    ...analysis.evidence.map((d) => `- ${d}`),
  ].join("\n");

  const ticketId = await createTicket({
    reporter,
    reporterEmail,
    subject: analysis.title,
    body: ticketBody,
    channel: "portal",
  });

  const memoryText = [
    `Issue: ${issue}`,
    `Root cause: ${analysis.rootCause}`,
    `Severity: ${analysis.severity}`,
    `Details: ${analysis.importantDetails.join("; ")}`,
    `Fixes: ${analysis.suggestedFixes.join("; ")}`,
    `Ticket: ${ticketId}`,
  ].join("\n");

  let memoryId: string | undefined;
  if (saveScope === "person" || saveScope === "both") {
    memoryId =
      (await addMemory(
        memoryText,
        `IT support context: ${analysis.title}`,
        "it-support-log-analyzer",
        reporterEmail,
      )) ?? undefined;
  }

  let runbookId: string | undefined;
  if (saveScope === "company" || saveScope === "both") {
    const workspaceId = (await getCurrentWorkspaceId()) ?? "acme.test";
    runbookId = `rb-log-${ticketId.toLowerCase()}`;
    const now = Date.now();
    await insertRunbook({
      id: runbookId,
      workspaceId,
      title: `Log finding: ${analysis.title}`,
      tags: inferTags(`${issue}\n${rawLogs}`),
      body: [
        `Symptom: ${issue}`,
        "",
        `Likely root cause: ${analysis.rootCause}`,
        `Severity: ${analysis.severity}`,
        "",
        "Important details:",
        ...analysis.importantDetails.map((d) => `- ${d}`),
        "",
        "Evidence lines:",
        ...analysis.evidence.map((d) => `- ${d}`),
        "",
        "Suggested fixes:",
        ...analysis.suggestedFixes.map((d) => `- ${d}`),
        "",
        `Created from ticket ${ticketId}.`,
      ].join("\n"),
      sourceTicketIds: [ticketId],
      createdAt: now,
      updatedAt: now,
      successCount: 0,
      failureCount: 0,
    });
  }

  return {
    ticketId,
    ...analysis,
    savedPersonMemory: Boolean(memoryId),
    savedCompanyRunbook: Boolean(runbookId),
    memoryId,
    runbookId,
  };
}

function analyzeLogs(issue: string, rawLogs: string): Omit<
  LogAnalysisResult,
  "ticketId" | "savedPersonMemory" | "savedCompanyRunbook" | "memoryId" | "runbookId"
> {
  const text = `${issue}\n${rawLogs}`;
  const lower = text.toLowerCase();
  const evidence = importantLines(rawLogs);

  if (lower.includes("vpn") || lower.includes("saml") || lower.includes("gateway")) {
    const staleGateway = lower.includes("old") || lower.includes("decommission") || lower.includes("us-west-1");
    const auth = lower.includes("auth_failed") || lower.includes("saml") || lower.includes("token");
    return {
      title: "VPN access failure from stale profile or expired auth session",
      severity: lower.includes("cfo") || lower.includes("urgent") || lower.includes("board") ? "high" : "medium",
      rootCause: staleGateway
        ? "VPN client is using a stale gateway/profile and needs a refreshed MDM VPN configuration."
        : auth
          ? "VPN authentication is failing after password or SAML token change."
          : "VPN issue detected from network/auth logs.",
      importantDetails: [
        staleGateway ? "Gateway/profile appears stale or points at an old endpoint." : "VPN endpoint needs verification.",
        auth ? "Authentication or SAML session failure is present in logs." : "No explicit auth failure found.",
        "This is safe to handle with diagnostic plus scoped MDM profile push after approval.",
      ],
      evidence,
      suggestedFixes: [
        "Run a read-only VPN diagnostic against the last-known endpoint.",
        "Refresh the user's VPN profile through MDM.",
        "Ask the user to reconnect and verify access to required apps.",
      ],
      userReply: "I found signs of a VPN profile/authentication issue. I am going to refresh your VPN configuration and have you reconnect once the profile lands.",
    };
  }

  if (lower.includes("account_locked") || lower.includes("failed login") || lower.includes("bad password")) {
    return {
      title: "Account lockout from repeated failed logins",
      severity: "high",
      rootCause: "Directory authentication logs show repeated failed logins that triggered an account lockout.",
      importantDetails: [
        "Failed login pattern is visible in the logs.",
        "Identity should be verified before unlock or password reset.",
        "Unlock/reset should use a scoped identity capability, not broad admin access.",
      ],
      evidence,
      suggestedFixes: [
        "Verify user identity with recent context.",
        "Unlock the account and reset failed-login counter.",
        "Have the user retry sign-in and monitor for recurring failures.",
      ],
      userReply: "I found repeated failed logins that likely locked your account. I will verify identity, unlock it, and ask you to try again.",
    };
  }

  if (lower.includes("kerberos") || lower.includes("kdc") || lower.includes("mapped drive")) {
    return {
      title: "Stale Kerberos ticket causing repeated credential prompts",
      severity: "medium",
      rootCause: "Kerberos/KDC logs indicate a stale or expired ticket, commonly after hibernation or clock drift.",
      importantDetails: [
        "Credential prompts are consistent with expired Kerberos ticket state.",
        "Mapped drive and intranet access can recover after ticket purge/renew.",
      ],
      evidence,
      suggestedFixes: [
        "Inspect KDC/system logs in read-only mode.",
        "Push klist purge and ticket renewal through device management.",
        "Ask user to retry mapped drive access.",
      ],
      userReply: "This looks like a stale Kerberos session. I can refresh the ticket through device management and have you retry the mapped drive.",
    };
  }

  return {
    title: "Support log analysis needs technician review",
    severity: evidence.length > 3 ? "medium" : "low",
    rootCause: "The logs contain potentially relevant errors, but no high-confidence automated diagnosis was found.",
    importantDetails: [
      "Important error/warning lines were extracted for technician review.",
      "The ticket and context were saved so this investigation is not lost.",
    ],
    evidence,
    suggestedFixes: [
      "Review the extracted lines and correlate with user impact.",
      "Ask for a screenshot or exact timestamp if needed.",
      "Turn the final resolution into a runbook once confirmed.",
    ],
    userReply: "I extracted the important log lines and opened a ticket for review. I may ask for one more detail if the root cause is not clear.",
  };
}

function importantLines(rawLogs: string): string[] {
  const patterns = /(error|fail|failed|denied|expired|timeout|locked|auth|saml|tls|gateway|exception|panic|crash|kerberos|kdc|vpn|warning|warn)/i;
  const lines = rawLogs
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hits = lines.filter((line) => patterns.test(line)).slice(0, 8);
  return hits.length > 0 ? hits : lines.slice(0, 5);
}

function inferTags(text: string): string[] {
  const lower = text.toLowerCase();
  const tags: string[] = ["logs"];
  for (const tag of ["vpn", "network", "password", "auth", "saml", "kerberos", "ad", "okta", "mdm", "printer", "crash"]) {
    if (lower.includes(tag)) tags.push(tag);
  }
  return Array.from(new Set(tags));
}
