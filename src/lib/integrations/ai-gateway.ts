import { listRunbooks } from "../data";
import { Citation, PlanStep } from "../types";
import { NiaDraftInput, NiaDraftResult } from "./nia";
import { extractJsonObject } from "./json";

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL || "anthropic/claude-haiku-4-5";

export async function aiGatewayDraft(input: NiaDraftInput): Promise<NiaDraftResult | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;

  const runbooks = await listRunbooks();
  const firstName = input.reporter.split(/\s+/)[0];

  const runbookContext =
    runbooks.length > 0
      ? runbooks
          .map(
            (rb) =>
              `### ${rb.id}: ${rb.title}\nTags: ${rb.tags.join(", ")}\nPrior successes: ${rb.successCount}\n${rb.body}`,
          )
          .join("\n\n---\n\n")
      : "(no prior runbooks)";

  const systemPrompt = `You are an AI IT support technician copilot. Given a user's IT issue and a library of prior runbooks, identify the best matching runbook (or none) and produce a JSON action plan to resolve the issue.

Output ONLY a single JSON object with this exact shape (no markdown, no preface):
{
  "matched_runbook_id": "rb-..." | null,
  "confidence": 0.0,
  "reasoning": "1-2 sentence explanation",
  "response": "Friendly reply to the user from the technician; address by first name",
  "plan": [
    { "kind": "insforge"|"aside"|"tensorlake"|"slack_reply", "description": "...", "capability": "namespace.action_name", "params": {} }
  ]
}

Capability kinds:
- insforge: policy-gated backend action via customer edge function
- aside: browser action in user's authenticated session (agent never holds creds)
- tensorlake: sandboxed compute for diagnostic scripts (we have a real local sandbox agent on the technician's machine)
- slack_reply: reply to user in Slack

Use the literal string "{reporter_email}" as a placeholder for the user's email in params.

CRITICAL behavior rule — DO NOT ask the user for OS, error messages, screenshots, or whether they recently changed their password. Our agent gathers that automatically. ALWAYS prefer a tensorlake diagnostic step over a clarification question.

Diagnostic capabilities (read-only, sandboxed):
- VPN/network/connectivity issues → "diag.network_probe"
- Login/lockout/auth/password → "sandbox.read_auth_logs"
- Mapped drives / Kerberos / domain auth → "sandbox.read_kerberos_logs"
- App crash / "X is not working" → "sandbox.read_auth_logs"
- "What is my hostname / computer name / RAM / OS / serial number / uptime / model?" → "diag.system_info" (runs on the user's machine via local agent and returns the actual values)

Fix capabilities (REAL execution on the user's machine via local agent — include these AFTER diagnostics when the issue calls for it):
- App crashed/frozen/not responding (Excel, Outlook, Slack, Chrome, Word, PowerPoint, Teams, etc) → "fix.restart_app" with params: { "app": "<app name as it appears in /Applications>" }
- App cache corruption suspected → "fix.clear_app_cache" with params: { "app": "<app name>" }
- Wi-Fi flaky/slow/network-dropped → "fix.toggle_wifi" (no params)

For ANY app issue (Excel crashing, Outlook not opening, etc), the plan should typically be:
  1. tensorlake diagnostic step (read logs)
  2. tensorlake fix.restart_app step (actually restart it)
  3. (optional) tensorlake fix.clear_app_cache step if logs hint at corruption

CRITICAL — every step's "description" field MUST mention the user's specific issue by name. Bad: "Run diagnostic in sandbox". Good: "Check if Excel process is responding and inspect recent crash logs". The user sees this description in Slack — if you say "VPN" when they asked about Excel, they lose trust.

Reply text (the "response" field) should NEVER ask for clarification. Always say something like:
"Hi <first name> — I'm pulling diagnostics from your machine right now and will reply with a fix plan in a moment."

If no runbook match: still produce a real diagnostic plan based on the issue category above. Set confidence below 0.6 to flag the absence of a runbook, but the plan itself must be diagnostic-driven, not question-driven.`;

  const memoryContext =
    input.memories && input.memories.length > 0
      ? `\n\n## Relevant context (Hyperspell memory search)\n${input.memories
          .map(
            (m, i) =>
              `[${i + 1}] (${m.source}, score ${m.score.toFixed(2)}) ${m.title}: ${m.summary}`,
          )
          .join("\n")}\n`
      : "";

  const userPrompt = `## Runbook library
${runbookContext}

## User report
Subject: ${input.subject}
Body: ${input.body}
Reporter: ${input.reporter} <${input.reporterEmail}> (first name: ${firstName})
Customer: ${input.customerOrg}${memoryContext}

Produce the JSON object.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(`${AI_GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_GATEWAY_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.warn("[AIGateway] fetch failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.warn(`[AIGateway] returned ${res.status}`);
    return null;
  }

  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = await res.json();
  } catch {
    console.warn("[AIGateway] response not JSON");
    return null;
  }

  const content = data?.choices?.[0]?.message?.content ?? "";
  const jsonStr = extractJsonObject(content);
  if (!jsonStr) {
    console.warn("[AIGateway] no parsable JSON in response");
    return null;
  }

  let parsed: {
    matched_runbook_id: string | null;
    confidence?: number;
    reasoning?: string;
    response?: string;
    plan?: Array<{
      kind?: string;
      description?: string;
      capability?: string;
      params?: Record<string, unknown>;
    }>;
  };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn("[AIGateway] JSON malformed");
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

  console.log(
    `[AIGateway] drafted plan via ${AI_GATEWAY_MODEL}: matched=${parsed.matched_runbook_id ?? "none"} confidence=${parsed.confidence ?? 0} steps=${plan.length}`,
  );

  return {
    citations,
    confidence: parsed.confidence ?? 0,
    reasoning: parsed.reasoning ?? "",
    response: parsed.response ?? "",
    plan,
    source: "ai-gateway",
  };
}

function normalizeKind(k: string | undefined): PlanStep["kind"] {
  if (k === "insforge" || k === "aside" || k === "tensorlake" || k === "slack_reply") return k;
  return "slack_reply";
}

export interface SlackReplyEvidence {
  stepDescription: string;
  capability?: string;
  status: PlanStep["status"];
  logLines: string[];
  agentOutput?: string;
}

/**
 * Re-write the Slack reply using the *actual* findings from the executed steps,
 * not the placeholder draft generated at planning time. Returns null if the LLM
 * is unavailable or returns an unusable response — caller should fall back to
 * the original draft.
 */
export async function synthesizeSlackReply(args: {
  reporterFirstName: string;
  subject: string;
  body: string;
  evidence: SlackReplyEvidence[];
}): Promise<string | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;
  if (args.evidence.length === 0) return null;

  const evidenceText = args.evidence
    .map((e, i) => {
      const header = `### Step ${i + 1}: ${e.stepDescription} [${e.capability ?? e.status}]`;
      const log = e.logLines.length > 0 ? `Logs:\n${e.logLines.slice(0, 30).join("\n")}` : "Logs: (none)";
      const out = e.agentOutput ? `\nLocal-agent output:\n${e.agentOutput.slice(0, 2000)}` : "";
      return `${header}\n${log}${out}`;
    })
    .join("\n\n");

  const systemPrompt = `You write the final Slack reply an IT support copilot sends to the user after running a diagnostic/fix plan.

Rules:
- Reply directly to the user by first name. Warm, concise, plain text. No markdown headers.
- If the user asked a *question* (hostname, RAM, OS, etc.), answer it with the EXACT values from the local-agent output. Do not paraphrase or invent.
- If the user reported a *problem* and you ran fixes, state what you did and what the next step on their side is (reconnect, reopen, etc.).
- If the diagnostics produced no useful data (the local agent isn't running, or the step returned generic mock output), say so honestly — do not pretend you collected data you didn't.
- 2–6 short sentences. No corporate fluff.

Output ONLY the Slack message text, nothing else.`;

  const userPrompt = `User's first name: ${args.reporterFirstName}
User's original message subject: ${args.subject}
User's original message body: ${args.body}

What we actually executed and observed:

${evidenceText}

Write the Slack reply.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  let res: Response;
  try {
    res = await fetch(`${AI_GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_GATEWAY_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.warn("[AIGateway] synthesizeSlackReply fetch failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.warn(`[AIGateway] synthesizeSlackReply returned ${res.status}`);
    return null;
  }

  const data = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) return null;
  return text.slice(0, 1800);
}
