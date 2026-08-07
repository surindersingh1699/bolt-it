/**
 * Every model call this system makes, other than the safety reviewer and the
 * research distiller which own their own.
 *
 * Two planning roles live here and they are deliberately asymmetric:
 *
 *   runStrategist — opus, called rarely. Reads the problem, the screenshot and
 *                   the machine's readings; produces a diagnosis and authorises
 *                   actions. This is the judgement.
 *   runOperator   — sonnet, called often. Carries the authorised actions out,
 *                   binds real parameters, works around mechanical obstacles,
 *                   and hands back when done or blocked. This is the labour.
 *
 * Diagnosis is worth an opus call. Discovering that the app is registered as
 * "Microsoft Outlook" and not "Outlook" is not, and most of a ticket's rounds
 * are the second kind.
 *
 * Everything the employee reads goes through `communicate` — one prompt, one
 * voice, every moment including chat. There is no separate "final reply" writer
 * any more: there were three, they drifted, and the thinnest of them owned the
 * only conversation the employee could actually have.
 */

import { PlanStep } from "../types";
import { DeviceFacts, deviceFactsAsContext } from "../observe";
import { ResearchFinding, researchAsContext } from "../research";
import { capabilityAllowed, normalizeKind } from "../capabilities";
import {
  CapabilityRequest,
  MAX_AUTHORIZED_STEPS,
  RejectedHypothesis,
  STRATEGIST_MODEL,
  STRATEGIST_TIMEOUT_MS,
  Strategy,
  strategistSystemPrompt,
} from "../strategist";
import {
  MAX_OPERATOR_STEPS,
  OPERATOR_MODEL,
  OPERATOR_TIMEOUT_MS,
  OperatorDecision,
  authorizeOperatorSteps,
  operatorSystemPrompt,
} from "../operator";
import {
  CHAT_INTENTS,
  CHAT_MODEL,
  COMMUNICATOR_MODEL,
  COMMUNICATOR_PROMPT,
  ChatIntent,
  CommunicationMoment,
  momentInstruction,
} from "../desk";
import { ChatMsg } from "../chat";
import { extractJsonObject } from "./json";
import { GatewayContent, gatewayChat } from "./gateway";

const str = (v: unknown, n: number): string => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** Turn a model's raw step objects into PlanSteps. Shared by both roles. */
function parseSteps(raw: unknown, idPrefix: string): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => {
    const s = (p ?? {}) as Record<string, unknown>;
    return {
      id: `${idPrefix}-${i}`,
      kind: normalizeKind(typeof s.kind === "string" ? s.kind : undefined),
      description: str(s.description, 300),
      capability: typeof s.capability === "string" ? s.capability : undefined,
      params: (s.params as Record<string, unknown>) ?? undefined,
      status: "pending" as const,
    };
  });
}

export interface StrategistInput {
  ticketId: string;
  subject: string;
  body: string;
  reporter: string;
  reporterEmail: string;
  /** Which strategist call this is, 1-based. */
  round: number;
  maxRounds: number;
  deviceFacts?: DeviceFacts;
  research?: ResearchFinding[];
  /** Everything carried out so far, with the device's own verdict. */
  evidence: ReplyEvidence[];
  /** One line per previous strategist call. */
  priorDiagnoses: string[];
  /** What the operator reported back, if it has run. */
  operatorNotes: string[];
  /**
   * What the employee said after an attempt landed. Freshest evidence on the
   * ticket, and the only kind that can outrank a VERIFIED CHANGE.
   */
  followUps?: string[];
  /**
   * Data URIs for screenshots the reporter attached. Sent on the FIRST call
   * only: the strategist writes down what it saw in its diagnosis, so paying
   * the image tokens again on every later call buys nothing.
   */
  images?: string[];
}

/**
 * The expensive call. Returns null when there is no usable answer — the caller
 * fails closed to a human handoff rather than inventing a plan.
 */
export async function runStrategist(input: StrategistInput): Promise<Strategy | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;

  const evidenceText = input.evidence.map((e, i) => renderEvidence(e, i, 25, 1500)).join("\n\n");
  const lastRound = input.round >= input.maxRounds;

  const text = `## The employee's report
Subject: ${input.subject}
Body: ${input.body}
Reporter: ${input.reporter} <${input.reporterEmail}>${
    input.images?.length ? `\nThey attached ${input.images.length} screenshot(s), shown below.` : ""
  }
${
  // Placed here, directly under the original report, rather than after the
  // execution log: it is the newest thing anyone knows about this ticket and
  // the one piece of evidence that can contradict the machine's own verdict.
  input.followUps?.length
    ? `\n## What the employee said after the last attempt\n${input.followUps
        .map((f) => `- "${f}"`)
        .join("\n")}\nThey are telling you the problem is still there. Whatever ran before did not fix it, however the device probes read.\n`
    : ""
}${deviceFactsAsContext(input.deviceFacts ?? null)}${researchAsContext(input.research ?? [])}

## What you concluded earlier
${
  input.priorDiagnoses.length
    ? input.priorDiagnoses.map((d, i) => `- look ${i + 1}: ${d}`).join("\n")
    : "(nothing yet — this is your first look at it)"
}

## What the operator reported back
${input.operatorNotes.length ? input.operatorNotes.map((n) => `- ${n}`).join("\n") : "(the operator has not run yet)"}

## What has actually run, with the device's own verdict
${evidenceText || "(nothing has been executed yet)"}

This is look ${input.round} of ${input.maxRounds}.${
    lastRound
      ? " It is your LAST. If the evidence does not support resolving it, set stuck:true and write the handoff précis for the technician."
      : ""
  }

Produce the JSON object.`;

  // Screenshots ride on the first look only — see StrategistInput.images.
  const user: GatewayContent =
    input.round === 1 && input.images?.length
      ? [
          { type: "text", text },
          ...input.images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ]
      : text;

  const content = await gatewayChat({
    model: STRATEGIST_MODEL,
    system: strategistSystemPrompt(),
    user,
    temperature: 0.2,
    timeoutMs: STRATEGIST_TIMEOUT_MS,
    call: "strategist",
    ticketId: input.ticketId,
  });
  if (!content) return null;

  const jsonStr = extractJsonObject(content);
  if (!jsonStr) {
    console.warn("[Strategist] no parsable JSON in response");
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    console.warn("[Strategist] JSON malformed");
    return null;
  }

  const proposed = parseSteps(parsed.steps, `s${input.round}`);

  // Enforced in code, not merely described in the prompt. A capability that is
  // not in the closed set is not quietly dropped — dropping it would leave an
  // authorisation that no longer means what the model intended. With no deeper
  // rung to escalate to, overreach is a handoff signal.
  const overreach = proposed.filter((s) => s.kind !== "reply" && !capabilityAllowed(s.capability));
  const steps = proposed
    .filter((s) => !overreach.includes(s) && s.kind !== "reply")
    .slice(0, MAX_AUTHORIZED_STEPS);

  console.log(
    `[Strategist] look ${input.round}: authorised ${steps.length} step(s), ` +
      `confidence=${parsed.confidence ?? 0}${parsed.resolved ? " claims RESOLVED" : ""}`,
  );

  return {
    diagnosis: str(parsed.diagnosis, 300),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    resolved: Boolean(parsed.resolved),
    reasoning: str(parsed.reasoning, 800),
    customerSummary: str(parsed.customer_summary, 600),
    steps,
    rejectedHypotheses: parseRejectedHypotheses(parsed.rejected_hypotheses),
    researchQuestion: str(parsed.research_question, 300) || null,
    capabilityRequest: parseCapabilityRequest(parsed.capability_request),
    stuck: Boolean(parsed.stuck) || overreach.length > 0,
    stuckReason:
      overreach.length > 0
        ? `asked for ${overreach.map((s) => s.capability).join(", ")}, which this system does not have`
        : str(parsed.stuck_reason, 600),
  };
}

export interface OperatorInput {
  ticketId: string;
  subject: string;
  body: string;
  /** The strategist's diagnosis, for context only — the operator does not revisit it. */
  diagnosis: string;
  /** The authorised action set. The operator may not run a change outside it. */
  authorized: PlanStep[];
  /** Everything run so far this strategy, with the device's own verdict. */
  evidence: ReplyEvidence[];
  round: number;
  maxRounds: number;
  deviceFacts?: DeviceFacts;
}

/**
 * The cheap call. Returns null when there is no usable answer; the caller
 * treats that as "blocked" and hands back to the strategist rather than
 * guessing at parameters.
 */
export async function runOperator(input: OperatorInput): Promise<OperatorDecision | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;

  const evidenceText = input.evidence.map((e, i) => renderEvidence(e, i, 20, 1200)).join("\n\n");
  const authorizedText = input.authorized.length
    ? input.authorized
        .map((s) => `- ${s.capability} — ${s.description}${s.params ? ` (suggested params: ${JSON.stringify(s.params)})` : ""}`)
        .join("\n")
    : "(nothing authorised — you may only run read-only checks)";

  const text = `## The employee's problem
${input.subject}
${input.body}

## The engineer's diagnosis
${input.diagnosis || "(none stated)"}

## AUTHORISED actions
These are the only changes you may make. You may correct their parameters and reorder them.
${authorizedText}
${deviceFactsAsContext(input.deviceFacts ?? null)}

## What you have run so far, with the device's own verdict
${evidenceText || "(nothing yet — this is your first round on this strategy)"}

This is round ${input.round} of ${input.maxRounds} on this strategy.${
    input.round >= input.maxRounds
      ? " It is your LAST — after this, hand back to the engineer whatever the state."
      : ""
  }

Produce the JSON object.`;

  const content = await gatewayChat({
    model: OPERATOR_MODEL,
    system: operatorSystemPrompt(),
    user: text,
    temperature: 0.1,
    timeoutMs: OPERATOR_TIMEOUT_MS,
    call: "operator",
    ticketId: input.ticketId,
  });
  if (!content) return null;

  const jsonStr = extractJsonObject(content);
  if (!jsonStr) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    console.warn("[Operator] JSON malformed");
    return null;
  }

  const proposed = parseSteps(parsed.steps, `o${input.round}`);
  // The boundary that stops a cheap model becoming a second planner. See
  // authorizeOperatorSteps in operator.ts.
  const { steps, rejected } = authorizeOperatorSteps(proposed, input.authorized);

  const note = str(parsed.note, 300);
  return {
    steps: steps.slice(0, MAX_OPERATOR_STEPS),
    strategyComplete: Boolean(parsed.strategy_complete),
    // Overreach is not silently dropped: the operator wanted something it may
    // not have, which is a question for the engineer, not a thing to ignore.
    blocked: Boolean(parsed.blocked) || rejected.length > 0,
    blockedReason:
      rejected.length > 0
        ? `the operator tried to run ${rejected
            .map((s) => s.capability ?? s.kind)
            .join(", ")}, which was not authorised — decide whether that is the right action`
        : str(parsed.blocked_reason, 600),
    note,
  };
}


/**
 * A rejected hypothesis with no stated reason is not a decision record, it is
 * noise — the whole value is in what ruled it out, so those are dropped.
 */
function parseRejectedHypotheses(raw: unknown): RejectedHypothesis[] {
  if (!Array.isArray(raw)) return [];
  const out: RejectedHypothesis[] = [];
  for (const item of raw.slice(0, 6)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const hypothesis = typeof r.hypothesis === "string" ? r.hypothesis.trim() : "";
    const ruledOutBy = typeof r.ruled_out_by === "string" ? r.ruled_out_by.trim() : "";
    if (!hypothesis || !ruledOutBy) continue;
    out.push({ hypothesis: hypothesis.slice(0, 200), ruledOutBy: ruledOutBy.slice(0, 200) });
  }
  return out;
}

export function parseCapabilityRequest(raw: unknown): CapabilityRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const command = typeof r.command === "string" ? r.command.trim() : "";
  // Without a name and a command there is nothing a human could act on.
  if (!name || !command) return null;
  const probeFields = Array.isArray(r.probe_fields)
    ? r.probe_fields.map((f) => String(f)).filter(Boolean)
    : [];
  return {
    name: name.slice(0, 80),
    kind: typeof r.kind === "string" ? r.kind : "device",
    why: typeof r.why === "string" ? r.why.slice(0, 300) : "",
    command: command.slice(0, 300),
    probeFields,
    expectsChange: r.expects_change !== false,
    reversible: typeof r.reversible === "string" ? r.reversible.slice(0, 300) : "",
    // Unstated risk resolves to "high", matching the reviewer's fail-closed
    // posture: an unclassified new mutation is not treated as a safe one.
    risk: r.risk === "low" || r.risk === "medium" || r.risk === "high" ? r.risk : "high",
    expectedEffect: typeof r.expected_effect === "string" ? r.expected_effect.slice(0, 300) : "",
  };
}

/**
 * The service-desk voice. Composes and formats; it does not interpret. The
 * technical claim is authored by the model that held the evidence and arrives
 * here as `agentSummary`, which the prompt forbids strengthening.
 */
export interface CommunicateArgs {
  moment: CommunicationMoment;
  reporterFirstName: string;
  subject: string;
  body: string;
  /** The engineer's own customer_summary — carried across, never strengthened. */
  agentSummary?: string;
  /** What is about to run, in human terms. */
  plannedSteps?: string[];
  /** What has actually been observed so far. */
  evidence?: ReplyEvidence[];
  /** Accumulated findings across the ticket. */
  findings?: string[];
  /** The `chat` moment: what they just said, and everything said before it. */
  userMessage?: string;
  history?: ChatMsg[];
  /** How the diagnosis developed — `ticket.troubleshootingSummary`. */
  diagnosis?: string;
  /** Where the ticket stands, so the desk does not promise work that has stopped. */
  status?: string;
  /** Which ticket to bill this call to. */
  ticketId?: string;
}

export async function communicate(args: CommunicateArgs): Promise<string | null> {
  const chat = args.moment === "chat";
  const sections = [
    `Employee first name: ${args.reporterFirstName}`,
    `Their original message subject: ${args.subject}`,
    `Their original message body: ${args.body}`,
  ];
  if (args.status) sections.push(`Ticket status right now: ${args.status}`);
  if (args.agentSummary) {
    sections.push(
      `\nWhat the engineer working it reported (carry this meaning across faithfully; you may make it clearer, not stronger):\n${args.agentSummary}`,
    );
  }
  if (args.diagnosis) {
    sections.push(`\nHow the diagnosis developed:\n${args.diagnosis}`);
  }
  if (args.plannedSteps?.length) {
    sections.push(`\nAbout to run:\n${args.plannedSteps.map((s) => `- ${s}`).join("\n")}`);
  }
  if (args.findings?.length) {
    sections.push(`\nFindings so far:\n${args.findings.map((f) => `- ${f}`).join("\n")}`);
  }
  if (args.evidence?.length) {
    sections.push(
      `\nWhat actually ran and what it returned:\n${args.evidence
        .map((e, i) => renderEvidence(e, i, 25, 1200))
        .join("\n\n")}`,
    );
  }
  if (args.history?.length) {
    sections.push(
      `\nThe conversation so far (oldest first — do not repeat yourself):\n${args.history
        .map((m) => `${m.from === "agent" ? "You" : args.reporterFirstName}: ${m.text}`)
        .join("\n")}`,
    );
  }
  if (args.userMessage) {
    sections.push(`\nWhat they just said, which you are answering:\n${args.userMessage}`);
  }

  const text = await gatewayChat({
    // The chat turn is the one the employee is waiting on and reading closely.
    model: chat ? CHAT_MODEL : COMMUNICATOR_MODEL,
    system: `${COMMUNICATOR_PROMPT}\n\n${momentInstruction(args.moment)}`,
    user: sections.join("\n"),
    temperature: 0.3,
    // Background updates are short on purpose: the desk must stay fast enough
    // to speak while the strategist is still thinking, and a late reassurance is
    // worth less than none. A chat turn has a person waiting on it instead, so
    // it can afford the bigger model's latency.
    timeoutMs: chat ? 30_000 : 15_000,
    // Conversational turns are billed separately from background updates: they
    // run a different model, and lumping them together would hide which of the
    // two is actually spending.
    call: chat ? "reply" : "communicate",
    ticketId: args.ticketId,
  });
  return text ? text.slice(0, 1800) : null;
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

/**
 * The employee said something in the thread and is waiting on an answer.
 *
 * This is the same desk voice and the same honesty rules as every other message
 * they get — it used to be its own one-line prompt with none of them, which is
 * why chat answered half a question and then asked whether the ticket could be
 * closed. It is fed the real device evidence and the conversation so far, so it
 * can answer from what happened rather than from a truncated plan summary.
 *
 * Returns null when there is no usable answer. The caller says so honestly; it
 * never invents a reply and never treats the failure as a new ticket.
 */
export async function conversationalReply(args: {
  ticketId: string;
  firstName: string;
  subject: string;
  body: string;
  userMessage: string;
  /** Everything said in this thread so far, oldest first. */
  history: ChatMsg[];
  /** What actually ran, with the device's own verdict on each. */
  evidence: ReplyEvidence[];
  diagnosis?: string;
  status: string;
}): Promise<{ reply: string; intent: ChatIntent } | null> {
  const content = await communicate({
    ticketId: args.ticketId,
    moment: "chat",
    reporterFirstName: args.firstName,
    subject: args.subject,
    body: args.body,
    userMessage: args.userMessage,
    history: args.history,
    evidence: args.evidence,
    diagnosis: args.diagnosis,
    status: args.status,
  });
  if (!content) return null;

  const jsonStr = extractJsonObject(content);
  if (!jsonStr) return null;
  let parsed: { reply?: unknown; intent?: unknown };
  try {
    parsed = JSON.parse(jsonStr) as { reply?: unknown; intent?: unknown };
  } catch {
    return null;
  }

  const reply = str(parsed.reply, 1800);
  // No reply text is not a routing decision — it is a broken call. Returning
  // null sends the caller down its honest-fallback path instead of letting an
  // empty message stand in for an answer.
  if (!reply) return null;

  // An unrecognised intent falls back to "answer": the reply still goes out and
  // nothing is routed on a label the model invented.
  const intent = CHAT_INTENTS.includes(parsed.intent as ChatIntent)
    ? (parsed.intent as ChatIntent)
    : "answer";

  return { reply, intent };
}
