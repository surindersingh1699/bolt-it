import { Citation, PlanStep } from "../types";
import { db } from "../db";

export interface NiaDraftInput {
  subject: string;
  body: string;
  reporter: string;
  reporterEmail: string;
  customerOrg: string;
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

export async function niaDraft(input: NiaDraftInput): Promise<NiaDraftResult> {
  if (process.env.NIA_API_KEY) {
    const real = await realNiaDraft(input).catch((err) => {
      console.warn("[Nia] real advisor threw:", (err as Error).message);
      return null;
    });
    if (real) return real;
  }
  const { aiGatewayDraft } = await import("./ai-gateway");
  const aig = await aiGatewayDraft(input).catch((err) => {
    console.warn("[AIGateway] threw:", (err as Error).message);
    return null;
  });
  if (aig) return aig;
  return mockNiaDraft(input);
}

async function realNiaDraft(input: NiaDraftInput): Promise<NiaDraftResult | null> {
  const runbooks = db.listRunbooks();
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
Reporter: ${input.reporter} <${input.reporterEmail}>

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
- "tensorlake" — sandboxed compute for AI-generated diagnostic scripts
- "slack_reply" — auto-reply to the user in Slack

Use the literal string "{reporter_email}" as a placeholder for the user's email in params.

If no runbook matches confidently, return matched_runbook_id: null, confidence below 0.6, and a minimal plan with a slack_reply step that acknowledges and asks for more detail.`;

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
      }),
    },
    search_scope: { repositories: [] },
    output_format: "explanation",
  };

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

export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function mockNiaDraft(input: NiaDraftInput): NiaDraftResult {
  const q = `${input.subject}\n${input.body}`.toLowerCase();
  const runbooks = db.listRunbooks();
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

function inferTag(text: string): "sso" | "vpn" | "password" | "laptop" | "generic" {
  if (text.includes("figma") || text.includes("sso")) return "sso";
  if (text.includes("vpn") || text.includes("network")) return "vpn";
  if (text.includes("password") || text.includes("reset") || text.includes("locked")) return "password";
  if (text.includes("laptop") || text.includes("mac")) return "laptop";
  return "generic";
}

function templateForTag(
  tag: "sso" | "vpn" | "password" | "laptop" | "generic",
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
    response: `Hi ${firstName} — I'm looking into this and will have an update shortly. Could you share a screenshot if anything looks unusual?`,
    plan: [
      { id: "step-0", kind: "slack_reply", description: "Acknowledge and request screenshot", status: "pending" },
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
