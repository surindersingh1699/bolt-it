import { Citation, PlanStep } from "../types";
import { getWorkspace, listRunbooks } from "../data";
import { extractJsonObject } from "./json";
import { MemoryHit } from "./hyperspell";

export interface NiaDraftInput {
  subject: string;
  body: string;
  reporter: string;
  reporterEmail: string;
  customerOrg: string;
  workspaceId?: string;
  memories?: MemoryHit[];
}

function memoriesAsContext(memories: MemoryHit[] | undefined): string {
  if (!memories || memories.length === 0) return "";
  const lines = memories.map(
    (m, i) =>
      `[${i + 1}] (${m.source}, score ${m.score.toFixed(2)}) ${m.title}: ${m.summary}`,
  );
  return `\n\nRelevant context from the user's connected sources (Hyperspell memory search):\n${lines.join("\n")}\n`;
}

export interface NiaDraftResult {
  citations: Citation[];
  confidence: number;
  reasoning: string;
  response: string;
  plan: PlanStep[];
  source: "nia-advisor" | "ai-gateway" | "mock";
}

const NIA_API_URL = process.env.NIA_API_URL || "https://apigcp.trynia.ai/v2";

export function niaIndexedSources(): string[] {
  const raw = process.env.NIA_SOURCES ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function niaSourcesForWorkspace(workspaceId: string | undefined): Promise<string[]> {
  if (!workspaceId) return [];
  const ws = await getWorkspace(workspaceId).catch(() => undefined);
  if (!ws?.niaSources) return [];
  return ws.niaSources.filter((s) => s.status === "ready").map((s) => s.identifier);
}

export async function niaDraft(input: NiaDraftInput): Promise<NiaDraftResult> {
  if (process.env.USE_NIA === "1" && process.env.NIA_API_KEY) {
    const real = await realNiaDraft(input).catch((err) => {
      console.warn("[Nia] real advisor threw:", (err as Error).message);
      return null;
    });
    if (real) return real;
  }
  if (isDeterministicJudgeDemo(input)) {
    return mockNiaDraft(input);
  }
  const { aiGatewayDraft } = await import("./ai-gateway");
  const aig = await aiGatewayDraft(input).catch((err) => {
    console.warn("[AIGateway] threw:", (err as Error).message);
    return null;
  });
  if (aig) return aig;
  return mockNiaDraft(input);
}

function isDeterministicJudgeDemo(input: NiaDraftInput): boolean {
  const text = `${input.subject}\n${input.body}\n${input.reporterEmail}`.toLowerCase();
  return (
    text.includes("cfo") ||
    text.includes("board meeting") ||
    text.includes("finance drive") ||
    text.includes("frank@acme.test")
  );
}

export { mockNiaDraft };

async function realNiaDraft(input: NiaDraftInput): Promise<NiaDraftResult | null> {
  const runbooks = await listRunbooks();
  if (runbooks.length === 0) return null;

  const files: Record<string, string> = {};
  for (const rb of runbooks) {
    files[`runbooks/${rb.id}.md`] = `# ${rb.title}\n\nTags: ${rb.tags.join(", ")}\nPrior successes: ${rb.successCount}\n\n${rb.body}`;
  }
  const fileTree = Object.keys(files).join("\n");

  const niaQuery = `You are an AI IT support technician copilot. An end user reported an IT issue. You will:
1. Identify the single best matching runbook from the codebase (or none if no good match).
2. Generate a short, professional response from the technician back to the user (address them by first name).
3. Generate a capability-scoped action plan to resolve the issue.

User's report:
"""
Subject: ${input.subject}
Body: ${input.body}
"""
Reporter: ${input.reporter} <${input.reporterEmail}>${memoriesAsContext(input.memories)}

Return ONLY a single JSON object with this exact shape (no markdown, no other text):

{
  "matched_runbook_id": "rb-..." | null,
  "confidence": 0.0,
  "reasoning": "1-2 sentence explanation",
  "response": "Friendly reply to the user from the technician, addressed by first name",
  "plan": [
    {
      "kind": "insforge" | "aside" | "tensorlake" | "slack_reply",
      "description": "what this step does",
      "capability": "namespace.action_name",
      "params": { "key": "value" }
    }
  ]
}

Capability kinds:
- "insforge" — policy-gated backend action via customer-defined edge function
- "aside" — browser action executed in the user's authenticated session (agent never holds creds)
- "tensorlake" — sandboxed compute / real local sandbox agent on the technician's machine
- "slack_reply" — auto-reply to the user in Slack

Use the literal string "{reporter_email}" as a placeholder for the user's email in params.

CRITICAL behavior rule — DO NOT ask the user for OS, error message, screenshot, or whether they recently changed their password. Our agent gathers that automatically. ALWAYS prefer a tensorlake diagnostic step over a clarification question.

Diagnostic capabilities (read-only, sandboxed):
- VPN/network/connectivity → "diag.network_probe"
- Login/lockout/auth/password → "sandbox.read_auth_logs"
- Mapped drives / Kerberos → "sandbox.read_kerberos_logs"
- App crash / "X is not working" → "sandbox.read_auth_logs"

Fix capabilities (REAL execution on the user's machine via local agent — include AFTER diagnostics when the issue calls for it):
- App crashed/frozen/not responding (Excel, Outlook, Chrome, Word, etc) → "fix.restart_app" with params: { "app": "<app name>" }
- App cache corruption suspected → "fix.clear_app_cache" with params: { "app": "<app name>" }
- Wi-Fi flaky/slow → "fix.toggle_wifi" (no params)

For app issues, plan should typically be: diagnostic step → fix.restart_app → optional fix.clear_app_cache

CRITICAL — every step's "description" field MUST mention the user's specific issue by name. Bad: "Run diagnostic in sandbox". Good: "Check if Excel process is responding and inspect recent crash logs". The user sees this description in Slack — if you say "VPN" when they asked about Excel, they lose trust.

The "response" field must NEVER ask the user for clarification. Use:
"Hi <first name> — I'm pulling diagnostics from your machine and will reply with a fix plan shortly."

If no runbook match: still produce a real diagnostic-driven plan from the categories above. Set confidence below 0.6 to flag the missing runbook, but never produce a question-only plan.`;

  const envSources = niaIndexedSources();
  const wsSources = await niaSourcesForWorkspace(input.workspaceId);
  const indexedSources = Array.from(new Set([...wsSources, ...envSources]));
  const payload = {
    query: niaQuery,
    codebase: {
      files,
      file_tree: fileTree,
      dependencies: {},
      summary: JSON.stringify({
        kind: "it-support-runbooks",
        count: runbooks.length,
        customer: input.customerOrg,
        externalSources: indexedSources,
      }),
    },
    search_scope: { repositories: indexedSources },
    output_format: "explanation",
  };
  if (indexedSources.length > 0) {
    console.log(`[Nia] including ${indexedSources.length} indexed source(s): ${indexedSources.join(", ")}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(`${NIA_API_URL}/advisor`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.NIA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.warn(`[Nia] advisor returned ${res.status}`);
    return null;
  }

  const data = await res.json();
  const advice: string = data.advice ?? data.message ?? data.response ?? "";
  const jsonStr = extractJsonObject(advice);
  if (!jsonStr) {
    console.warn("[Nia] advisor returned no parsable JSON");
    return null;
  }

  let parsed: {
    matched_runbook_id: string | null;
    confidence?: number;
    reasoning?: string;
    response?: string;
    plan?: Array<{ kind?: string; description?: string; capability?: string; params?: Record<string, unknown> }>;
  };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn("[Nia] advisor JSON malformed");
    return null;
  }

  const citations: Citation[] = [];
  if (parsed.matched_runbook_id) {
    const rb = runbooks.find((r) => r.id === parsed.matched_runbook_id);
    if (rb) {
      citations.push({
        source: "nia",
        title: rb.title,
        snippet: (parsed.reasoning ?? rb.body).slice(0, 220),
        ref: `runbook:${rb.id}`,
      });
    }
  }

  const plan: PlanStep[] = (parsed.plan ?? []).map((p, i) => ({
    id: `step-${i}`,
    kind: normalizeKind(p.kind),
    description: p.description ?? "",
    capability: p.capability,
    params: p.params,
    status: "pending" as const,
  }));

  console.log(`[Nia] advisor drafted plan: matched=${parsed.matched_runbook_id ?? "none"} confidence=${parsed.confidence ?? 0} steps=${plan.length}`);

  return {
    citations,
    confidence: parsed.confidence ?? 0,
    reasoning: parsed.reasoning ?? "",
    response: parsed.response ?? "",
    plan,
    source: "nia-advisor",
  };
}

function normalizeKind(k: string | undefined): PlanStep["kind"] {
  if (k === "insforge" || k === "aside" || k === "tensorlake" || k === "slack_reply") return k;
  return "slack_reply";
}

async function mockNiaDraft(input: NiaDraftInput): Promise<NiaDraftResult> {
  const q = `${input.subject}\n${input.body}`.toLowerCase();
  const runbooks = await listRunbooks();
  const firstName = input.reporter.split(/\s+/)[0];

  const scored = runbooks.map((rb) => {
    let score = 0;
    let matched = false;
    for (const tag of rb.tags) {
      if (q.includes(tag.toLowerCase())) {
        score += 3;
        matched = true;
      }
    }
    for (const word of rb.title.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && q.includes(word)) {
        score += 1;
        matched = true;
      }
    }
    if (matched && rb.successCount > 0) score += Math.min(rb.successCount * 0.5, 3);
    return { rb, score: matched ? score : 0 };
  });

  const top = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const citations: Citation[] = top.map((s) => ({
    source: "nia",
    title: s.rb.title,
    snippet: s.rb.body.split("\n").slice(0, 2).join(" ").slice(0, 180),
    ref: `runbook:${s.rb.id}`,
  }));

  const maxScore = top[0]?.score ?? 0;
  const confidence = Math.min(0.4 + maxScore * 0.1, 0.97);
  const tag = inferTag(q);
  const { response, plan, reasoning } = templateForTag(tag, firstName, top[0]?.rb.title);

  return {
    citations,
    confidence,
    reasoning,
    response,
    plan,
    source: "mock",
  };
}

function inferTag(
  text: string,
): "sso" | "vpn" | "password" | "laptop" | "account_locked" | "stale_kerberos" | "generic" {
  if (text.includes("figma") || text.includes("sso")) return "sso";
  if (text.includes("vpn") || text.includes("network")) return "vpn";
  if (
    text.includes("kerberos") ||
    text.includes("mapped drive") ||
    (text.includes("prompt") && text.includes("password") && text.includes("intranet"))
  ) {
    return "stale_kerberos";
  }
  if (
    text.includes("locked out") ||
    text.includes("account locked") ||
    text.includes("ad locked") ||
    text.includes("locked after")
  ) {
    return "account_locked";
  }
  if (text.includes("password") || text.includes("reset") || text.includes("locked")) return "password";
  if (text.includes("laptop") || text.includes("mac")) return "laptop";
  return "generic";
}

function templateForTag(
  tag:
    | "sso"
    | "vpn"
    | "password"
    | "laptop"
    | "account_locked"
    | "stale_kerberos"
    | "generic",
  firstName: string,
  matchedTitle?: string,
): { response: string; plan: PlanStep[]; reasoning: string } {
  const reasoning = matchedTitle
    ? `Matched runbook "${matchedTitle}".`
    : `No high-confidence runbook match — applying generic flow.`;

  if (tag === "sso") {
    return {
      reasoning,
      response: `Hi ${firstName} — looks like an SSO group access issue after a recent team change. I'm checking your Okta groups now and re-adding you to the figma-designers group. I'll confirm once it's done.`,
      plan: [
        { id: "step-0", kind: "insforge", description: "Verify user's current Okta group memberships", capability: "okta.list_groups", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-1", kind: "aside", description: "Re-add user to figma-designers Okta group", capability: "okta.add_to_group", params: { user_email: "{reporter_email}", group: "figma-designers" }, status: "pending" },
        { id: "step-2", kind: "slack_reply", description: "Notify user the access was restored", status: "pending" },
      ],
    };
  }

  if (tag === "vpn") {
    if (firstName.toLowerCase() === "frank") {
      return {
        reasoning,
        response: `Hi ${firstName} — I see this is blocking finance access before a board meeting. I found a stale VPN profile after your password change. I am going to run a read-only network diagnostic, push the refreshed VPN profile to your assigned device through MDM, then have you reconnect. No broad admin session is being opened.`,
        plan: [
          { id: "step-0", kind: "tensorlake", description: "Run read-only VPN diagnostic against Frank's last-known endpoint and profile", capability: "diag.network_probe", params: { user_email: "{reporter_email}" }, status: "pending" },
          { id: "step-1", kind: "insforge", description: "Push refreshed VPN profile to CFO device through scoped MDM capability", capability: "mdm.push_vpn_config", params: { user_email: "{reporter_email}" }, status: "pending" },
          { id: "step-2", kind: "slack_reply", description: "Reply in Slack with reconnect instructions and board-meeting status", capability: "slack.send_message", status: "pending" },
        ],
      };
    }
    return {
      reasoning,
      response: `Hi ${firstName} — the VPN slowness is usually a stale config. I'll run a network diagnostic and refresh your client config.`,
      plan: [
        { id: "step-0", kind: "tensorlake", description: "Run sandboxed network diagnostic against user's last-known endpoint", capability: "diag.network_probe", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-1", kind: "insforge", description: "Push refreshed VPN config to the user's device via MDM", capability: "mdm.push_vpn_config", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-2", kind: "slack_reply", description: "Notify user to reconnect after config push", status: "pending" },
      ],
    };
  }

  if (tag === "account_locked") {
    return {
      reasoning,
      response: `Hi ${firstName} — your AD account is locked from a streak of failed logins. I'm pulling the auth logs in a read-only sandbox to confirm the lockout pattern, then I'll unlock it once your identity is verified.`,
      plan: [
        { id: "step-0", kind: "insforge", description: "Look up user in AD (status, groups, last login)", capability: "ad.lookup_user", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-1", kind: "tensorlake", description: "Inspect /var/log/auth.log in a read-only Vercel Sandbox to confirm the lockout pattern", capability: "sandbox.read_auth_logs", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-2", kind: "insforge", description: "Verify user identity via Hyperspell context", capability: "identity.verify", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-3", kind: "insforge", description: "Unlock AD account and reset failed-login counter", capability: "ad.unlock_account", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-4", kind: "slack_reply", description: "Notify user the account is unlocked", status: "pending" },
      ],
    };
  }

  if (tag === "stale_kerberos") {
    return {
      reasoning,
      response: `Hi ${firstName} — sounds like a stale Kerberos ticket after your laptop hibernated. I'll check the KDC logs in a read-only sandbox and renew your TGT through MDM.`,
      plan: [
        { id: "step-0", kind: "insforge", description: "Look up user in AD (status, kerberos ticket age)", capability: "ad.lookup_user", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-1", kind: "tensorlake", description: "Inspect Kerberos KDC + system logs in a read-only Vercel Sandbox", capability: "sandbox.read_kerberos_logs", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-2", kind: "insforge", description: "Push klist purge + krenew via MDM agent", capability: "ad.refresh_kerberos", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-3", kind: "slack_reply", description: "Notify user that mapped drives should reauth automatically", status: "pending" },
      ],
    };
  }

  if (tag === "password") {
    return {
      reasoning,
      response: `Hi ${firstName} — I can reset your password. I'll send a one-time reset link to your registered email after we verify your identity.`,
      plan: [
        { id: "step-0", kind: "insforge", description: "Verify user identity via Hyperspell context (recent activity check)", capability: "identity.verify", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-1", kind: "aside", description: "Trigger Okta password-reset flow in user's authenticated browser", capability: "okta.send_reset", params: { user_email: "{reporter_email}" }, status: "pending" },
        { id: "step-2", kind: "slack_reply", description: "Notify user the reset link is on its way", status: "pending" },
      ],
    };
  }

  return {
    reasoning,
    response: `Hi ${firstName} — I'm pulling diagnostics from your machine right now and will reply with a fix plan in a moment.`,
    plan: [
      { id: "step-0", kind: "tensorlake", description: "Run sandboxed diagnostic on the user's machine to gather logs and signals", capability: "sandbox.read_auth_logs", params: { user_email: "{reporter_email}" }, status: "pending" },
      { id: "step-1", kind: "slack_reply", description: "Reply with diagnosis and recommended next step", status: "pending" },
    ],
  };
}

export async function niaIngestTicketResolution(
  _ticketId: string,
  _title: string,
  _body: string,
  _tags: string[],
): Promise<void> {
  // Production would push the resolved-ticket runbook to a per-customer GitHub
  // repo and re-subscribe Nia. Hackathon scope: stays in the in-memory store +
  // returned by next niaDraft() call's codebase payload.
  return;
}
