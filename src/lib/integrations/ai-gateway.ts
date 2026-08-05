import { listRunbooks } from "../data";
import { Citation, PlanStep } from "../types";
import { FACT_KEYS, UserFact, UserMemory, memoryAsContext } from "../memory";
import { DraftInput, DraftResult, normalizeKind } from "./draft";
import { extractJsonObject } from "./json";

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_MODEL = process.env.AI_GATEWAY_MODEL || "anthropic/claude-haiku-4-5";
// Conversational replies in the Slack thread; defaults to the same model the
// planner uses (the endpoint decides valid ids — plain "gpt-4o-mini" against
// api.openai.com, "openai/gpt-4o-mini" against the Vercel AI Gateway).
const AI_GATEWAY_CHAT_MODEL = process.env.AI_GATEWAY_CHAT_MODEL || AI_GATEWAY_MODEL;

export async function aiGatewayDraft(input: DraftInput): Promise<DraftResult | null> {
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
    { "kind": "device"|"backend"|"reply", "description": "...", "capability": "<one capability id from the list below>", "params": {} }
  ]
}

"capability" MUST be copied verbatim from this list — never invent one, never emit a
placeholder like "namespace.action_name". Every capability below is really implemented;
there are no others. If nothing fits, use kind "reply" with no capability.

kind "backend" (account state in our directory):
  ad.lookup_user, ad.unlock_account, ad.reset_password, ad.refresh_kerberos
kind "device" (really executed on the user's machine by the local agent):
  diag.system_info, diag.app_status, diag.app_logs,
  fix.restart_app, fix.clear_app_cache, fix.toggle_wifi
kind "reply" (message to the user, no capability)

Use the literal string "{reporter_email}" as a placeholder for the user's email in params.

CRITICAL behavior rule — DO NOT ask the user for OS, error messages, screenshots, or whether they recently changed their password. Our agent gathers that automatically. ALWAYS prefer a device diagnostic step over a clarification question.

Diagnostic capabilities (read-only, run on the user's real machine):
- App crash / "X is not working" / "X keeps freezing" → "diag.app_status" then "diag.app_logs" with params { "app": "<app name>" }
- Login/lockout/password/Kerberos/mapped drives → "ad.lookup_user" (reads their account state)
- "What is my hostname / computer name / RAM / OS / serial number / uptime / model?" → "diag.system_info" (returns the actual values)
- Network/VPN complaints → "diag.system_info" plus "fix.toggle_wifi" if a link reset is warranted. We have no VPN-specific probe; do not pretend otherwise.

Fix capabilities (REAL execution on the user's machine via the local agent — include these AFTER diagnostics when the issue calls for it):
- App crashed/frozen/not responding (Excel, Outlook, Slack, Chrome, Word, PowerPoint, Teams, etc) → "fix.restart_app" with params: { "app": "<app name as it appears in /Applications>" }
- App cache corruption suspected → "fix.clear_app_cache" with params: { "app": "<app name>" }
- Wi-Fi flaky/slow/network-dropped → "fix.toggle_wifi" (no params; cycles the machine's primary adapter)

For ANY app issue (Excel crashing, Outlook not opening, etc), the plan should typically be:
  1. device diag.app_status / diag.app_logs step (see the real state)
  2. device fix.restart_app step (actually restart it)
  3. (optional) device fix.clear_app_cache step if the logs hint at corruption

CRITICAL — every step's "description" field MUST mention the user's specific issue by name. Bad: "Run diagnostic in sandbox". Good: "Check if Excel process is responding and inspect recent crash logs". The user sees this description in Slack — if you say "VPN" when they asked about Excel, they lose trust.

Reply text (the "response" field) should NEVER ask for clarification. Always say something like:
"Hi <first name> — I'm pulling diagnostics from your machine right now and will reply with a fix plan in a moment."

If no runbook match: still produce a real diagnostic plan based on the issue category above. Set confidence below 0.6 to flag the absence of a runbook, but the plan itself must be diagnostic-driven, not question-driven.`;

  const memoryContext = memoryAsContext(input.memory ?? null);

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
        source: "runbook",
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

export interface ReplyEvidence {
  stepDescription: string;
  capability?: string;
  status: PlanStep["status"];
  logLines: string[];
  agentOutput?: string;
  /** Verdict from the device's own before/after probes, when a job ran. */
  deviceEffect?: string;
}

/** Renders one evidence block, leading with the device verdict so the model sees it first. */
function renderEvidence(e: ReplyEvidence, index: number, logLimit: number, outputLimit: number): string {
  const header = `### Step ${index + 1}: ${e.stepDescription} [${e.capability ?? e.status}] -> ${e.status}`;
  const effect = `Device evidence: ${e.deviceEffect ?? "(no device job for this step)"}`;
  const log = e.logLines.length > 0 ? `Logs:\n${e.logLines.slice(0, logLimit).join("\n")}` : "Logs: (none)";
  const out = e.agentOutput ? `\nLocal-agent output:\n${e.agentOutput.slice(0, outputLimit)}` : "";
  return `${header}\n${effect}\n${log}${out}`;
}

export interface VerdictResult {
  resolved: boolean;
  confidence: number;
  reasoning: string;
  /** Next things to try when unresolved; capability ids from the allowed list. */
  nextSteps: PlanStep[];
  /** What the agent believes is going on, in one line, for the ticket log. */
  hypothesis: string;
}

/**
 * The troubleshooting-loop brain: given the original complaint and everything
 * actually observed so far, decide whether the issue is resolved, and if not
 * propose the NEXT round of steps (diagnostics or fixes) to try. This is what
 * makes the agent iterate like a technician instead of firing one plan and
 * declaring victory.
 */
export async function verifyAndReplan(args: {
  subject: string;
  body: string;
  attempt: number;
  maxAttempts: number;
  evidence: ReplyEvidence[];
  priorFindings: string[];
  /** Company knowledge: directory profile line, device line, user memory. */
  userContext?: string;
  deviceContext?: string;
  memory?: UserMemory;
}): Promise<VerdictResult | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;

  // Same institutional knowledge the initial draft gets — the retry loop
  // should reason from company runbooks first, general IT knowledge second.
  const runbooks = await listRunbooks();
  const runbookContext =
    runbooks.length > 0
      ? runbooks
          .map((rb) => `### ${rb.id}: ${rb.title} (worked ${rb.successCount}x)\nTags: ${rb.tags.join(", ")}\n${rb.body.slice(0, 600)}`)
          .join("\n\n")
      : "(no runbooks yet)";

  const evidenceText = args.evidence.map((e, i) => renderEvidence(e, i, 25, 1500)).join("\n\n");

  const systemPrompt = `You are the reasoning loop of an IT support agent, acting like an experienced technician.

You are given: the user's original problem, what has been executed so far, and the real output collected from the user's machine.

Decide:
1. Is the problem actually RESOLVED based on the EVIDENCE? Be strict — a fix step "succeeding" does not mean the problem is gone. Prefer evidence that verifies end state (e.g. "running: yes" from an app status check) over evidence that an action was merely attempted.
2. If NOT resolved, what is the next best round of steps? Think like a technician: verify the current state, read the app's own error logs, check related files/config, then apply the next most likely fix. Don't repeat a step that already ran unless you now have a reason to expect a different outcome.

Ground your reasoning in COMPANY KNOWLEDGE first: if a runbook below matches this class of problem, follow its resolution sequence and name the runbook id in your reasoning. Use the user's profile/device context to tailor steps (right app names, right machine). Where company knowledge is silent, fall back to your own general IT knowledge — say so explicitly in the reasoning (e.g. "no runbook covers this; based on general knowledge...").

Attempt ${args.attempt} of ${args.maxAttempts}. If this is the final attempt, set resolved=false and return an empty nextSteps array — the agent will hand off to a human with your findings.

Every step carries a "Device evidence" line, computed from probes the agent took on the user's machine before and after the action. It is the ONLY trustworthy signal — prose in the logs is not.
- "VERIFIED CHANGE — <field before → after>": the machine really changed. This is the only evidence that can support resolved=true.
- "NO EFFECT": the commands ran but the machine is byte-for-byte the same. The fix did not land. Treat it as a failed attempt and try something different — never repeat the identical step.
- "FAILED": the command errored on the device; read the exit code and stderr in the logs before choosing the next step.

Return ONLY JSON:
{
  "resolved": true|false,
  "confidence": 0.0-1.0,
  "hypothesis": "one line: what you believe is actually wrong",
  "reasoning": "2-3 sentences citing the specific evidence",
  "nextSteps": [
    { "kind": "device"|"backend"|"reply", "description": "...", "capability": "<id from allowed list>", "params": {} }
  ]
}

Allowed capability ids (copy verbatim, never invent):
diag.app_status, diag.app_logs, diag.system_info,
fix.restart_app, fix.clear_app_cache, fix.toggle_wifi,
ad.lookup_user, ad.unlock_account, ad.reset_password, ad.refresh_kerberos

Use kind "device" for any diag.*/fix.* capability (these run on the user's machine via the local agent) and kind "backend" for ad.* capabilities.
Use params {"app":"<AppName>"} for app-scoped capabilities.
Return at most 3 nextSteps. Never include a reply step — the agent writes the reply itself.`;

  const memoryContext = memoryAsContext(args.memory ?? null) || "(no memory yet)";

  const userPrompt = `Original problem: ${args.subject}
Details: ${args.body}

## Company knowledge
Runbook library:
${runbookContext}

User profile: ${args.userContext ?? "(unknown)"}
User's device: ${args.deviceContext ?? "(no registered device)"}
User memory:
${memoryContext}

Findings from earlier attempts:
${args.priorFindings.length ? args.priorFindings.map((f, i) => `- attempt ${i + 1}: ${f}`).join("\n") : "(none — this is the first attempt)"}

What ran in THIS attempt and what it returned:
${evidenceText || "(nothing executed)"}`;

  try {
    const res = await fetch(`${AI_GATEWAY_URL}/chat/completions`, {
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
    });
    if (!res.ok) {
      console.warn(`[AIGateway] verifyAndReplan returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    // extractJsonObject returns the JSON *string* — it still needs parsing.
    const jsonStr = extractJsonObject(text);
    if (!jsonStr) return null;
    let parsed: {
      resolved?: boolean;
      confidence?: number;
      reasoning?: string;
      hypothesis?: string;
      nextSteps?: Array<Partial<PlanStep>>;
    };
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      console.warn("[AIGateway] verifyAndReplan JSON malformed");
      return null;
    }

    const nextSteps: PlanStep[] = (parsed.nextSteps ?? [])
      .filter((s) => s.kind && s.kind !== "reply")
      .slice(0, 3)
      .map((s, i) => ({
        id: `a${args.attempt}-step-${i}`,
        kind: (s.kind ?? "device") as PlanStep["kind"],
        description: s.description ?? "Follow-up diagnostic",
        capability: s.capability,
        params: s.params,
        status: "pending" as const,
      }));

    return {
      resolved: Boolean(parsed.resolved),
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning ?? "",
      hypothesis: parsed.hypothesis ?? "",
      nextSteps,
    };
  } catch (err) {
    console.warn("[AIGateway] verifyAndReplan threw:", (err as Error).message);
    return null;
  }
}

/**
 * Re-write the Slack reply using the *actual* findings from the executed steps,
 * not the placeholder draft generated at planning time. Returns null if the LLM
 * is unavailable or returns an unusable response — caller should fall back to
 * the original draft.
 */
export async function synthesizeReply(args: {
  reporterFirstName: string;
  subject: string;
  body: string;
  evidence: ReplyEvidence[];
}): Promise<string | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;
  if (args.evidence.length === 0) return null;

  const evidenceText = args.evidence.map((e, i) => renderEvidence(e, i, 30, 2000)).join("\n\n");

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

/**
 * Free-form conversational reply in the ticket thread. Grounded strictly in
 * the ticket record; returns newIssue=true when the message is really a
 * fresh problem deserving its own ticket.
 */
export async function conversationalReply(args: {
  userMessage: string;
  firstName: string;
  ticketSummary: string;
}): Promise<{ reply: string; newIssue: boolean } | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;
  try {
    const res = await fetch(`${AI_GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_GATEWAY_CHAT_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `You are an in-house IT support agent chatting with an employee in Slack about their ticket. Warm, concise (1-4 sentences), plain text. Answer ONLY from the ticket record — what ran, what was found, current status. Never invent results. If you lack the data, say so and offer to escalate. If their message is actually a NEW unrelated IT problem, set new_issue=true and leave reply empty. Return ONLY JSON: {"reply":"...","new_issue":false}`,
          },
          {
            role: "user",
            content: `Employee first name: ${args.firstName}\n\nTicket record:\n${args.ticketSummary}\n\nEmployee's message: ${args.userMessage}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const jsonStr = extractJsonObject(data.choices?.[0]?.message?.content ?? "");
    if (!jsonStr) return null;
    const parsed = JSON.parse(jsonStr) as { reply?: string; new_issue?: boolean };
    return { reply: parsed.reply ?? "", newIssue: Boolean(parsed.new_issue) };
  } catch {
    return null;
  }
}

// ---- memory extraction -----------------------------------------------------

export interface ExtractedMemory {
  facts: Array<{ key: string; value: string }>;
  episode: string;
}

/**
 * After a ticket is finished, decide what is worth remembering about this
 * person next time. Facts are restricted to a closed key set so memory stays a
 * small profile, not a transcript. Returns null when nothing is worth storing.
 */
export async function extractUserMemory(args: {
  subject: string;
  body: string;
  outcome: string;
  knownFacts: UserFact[];
}): Promise<ExtractedMemory | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;

  const systemPrompt = `You maintain a small, durable memory profile for an IT support user — the things a good helpdesk colleague would remember about them.

Return ONLY JSON:
{
  "facts": [ { "key": "<one of the allowed keys>", "value": "short value" } ],
  "episode": "one sentence: what they needed and how it ended"
}

Allowed fact keys (use no others): ${FACT_KEYS.join(", ")}

Rules:
- Only record a fact you can actually support from the text. Never guess an office, a timezone, or a nickname.
- Facts must be durable — true next month too. "Outlook crashed today" is NOT a fact; "uses Outlook as their mail client" is.
- If a known fact is contradicted, emit the corrected value under the same key.
- Return an empty facts array when nothing durable was learned. That is the normal case.
- The episode is always one plain sentence, no names, under 25 words.`;

  const userPrompt = `Known facts: ${
    args.knownFacts.length > 0
      ? args.knownFacts.map((f) => `${f.key}=${f.value}`).join(", ")
      : "(none yet)"
  }

Ticket subject: ${args.subject}
Ticket body: ${args.body}
Outcome: ${args.outcome}

Produce the JSON.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);
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
        temperature: 0,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.warn("[AIGateway] memory extraction failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) return null;

  const data: { choices?: Array<{ message?: { content?: string } }> } = await res.json().catch(() => ({}));
  const jsonStr = extractJsonObject(data?.choices?.[0]?.message?.content ?? "");
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr) as ExtractedMemory;
    return {
      facts: (parsed.facts ?? [])
        .filter((f) => f && typeof f.key === "string" && typeof f.value === "string" && f.value.trim())
        .slice(0, 8),
      episode: typeof parsed.episode === "string" ? parsed.episode.slice(0, 300) : "",
    };
  } catch {
    return null;
  }
}
