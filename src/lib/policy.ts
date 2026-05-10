import { PlanStep, StepRisk, Ticket, RiskSource } from "./types";
import { extractJsonObject } from "./integrations/json";

interface ClassifyResult {
  risk: StepRisk;
  reason: string;
  source: RiskSource;
}

const ALLOWLIST_LOW = new Set([
  "slack.send_message",
  "okta.list_groups",
  "ad.lookup_user",
  "identity.verify",
  "diag.network_probe",
  "sandbox.read_auth_logs",
  "sandbox.read_kerberos_logs",
]);

const ALLOWLIST_HIGH = new Set([
  "ad.unlock_account",
  "okta.send_reset",
  "mdm.push_vpn_config",
  "ad.refresh_kerberos",
]);

function classifyDeterministic(step: PlanStep): ClassifyResult | null {
  if (step.kind === "slack_reply") {
    return { risk: "low", reason: "slack_reply: user-visible message only", source: "allowlist" };
  }
  const cap = step.capability;
  if (!cap) return null;
  if (ALLOWLIST_LOW.has(cap)) {
    return { risk: "low", reason: `${cap}: read-only or notification`, source: "allowlist" };
  }
  if (ALLOWLIST_HIGH.has(cap)) {
    return { risk: "high", reason: `${cap}: writes to identity/device state`, source: "allowlist" };
  }
  return null;
}

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "https://ai-gateway.vercel.sh/v1";
const JUDGE_MODEL = process.env.POLICY_JUDGE_MODEL || "anthropic/claude-haiku-4-5";

async function classifyWithJudge(step: PlanStep, ticket: Ticket): Promise<ClassifyResult | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;

  const systemPrompt = `You are a security policy classifier for an IT support agent. Classify a single proposed action into a risk tier.

Tiers:
- "low": read-only, notification, or trivially reversible (lookups, log reads, slack messages).
- "medium": single-user state change, easily reversible (group add, password reset link).
- "high": touches credentials, security groups, devices/MDM, billing, prod infra, or affects multiple users.

Output ONLY JSON: { "risk": "low"|"medium"|"high", "reason": "one short sentence" }`;

  const userPrompt = `Ticket subject: ${ticket.subject}
Reporter: ${ticket.reporterEmail}

Proposed step:
- kind: ${step.kind}
- capability: ${step.capability ?? "(none)"}
- description: ${step.description}
- params: ${JSON.stringify(step.params ?? {})}

Classify the risk.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8_000);
  let res: Response;
  try {
    res = await fetch(`${AI_GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    console.warn("[Policy] judge fetch failed:", (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    console.warn(`[Policy] judge returned ${res.status}`);
    return null;
  }

  const data: { choices?: Array<{ message?: { content?: string } }> } = await res
    .json()
    .catch(() => ({}));
  const content = data?.choices?.[0]?.message?.content ?? "";
  const jsonStr = extractJsonObject(content);
  if (!jsonStr) return null;

  let parsed: { risk?: string; reason?: string };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  const risk = normalizeRisk(parsed.risk);
  if (!risk) return null;
  return {
    risk,
    reason: (parsed.reason ?? "judge classification").slice(0, 200),
    source: "judge",
  };
}

function normalizeRisk(r: string | undefined): StepRisk | null {
  if (r === "low" || r === "medium" || r === "high") return r;
  return null;
}

function approvalModeFor(risk: StepRisk): "auto" | "human" {
  return risk === "high" ? "human" : "auto";
}

export async function classifyPlan(plan: PlanStep[], ticket: Ticket): Promise<PlanStep[]> {
  const out: PlanStep[] = [];
  for (const step of plan) {
    const det = classifyDeterministic(step);
    let result: ClassifyResult;
    if (det) {
      result = det;
    } else {
      const judged = await classifyWithJudge(step, ticket);
      result = judged ?? {
        risk: "high",
        reason: "Unclassified capability — defaulting to human approval",
        source: "fallback",
      };
    }
    const approvalMode = approvalModeFor(result.risk);
    const policyLog = `[Policy] step ${step.id}: ${result.risk} (${result.source}) — ${result.reason}`;
    out.push({
      ...step,
      risk: result.risk,
      approvalMode,
      riskReason: result.reason,
      riskSource: result.source,
      log: [...(step.log ?? []), policyLog],
    });
  }
  return out;
}
