/**
 * Per-ticket cost accounting.
 *
 * Every model call this system makes is recorded here: which call it was, which
 * model served it, how many tokens each way, how long it took, and whether it
 * came back at all. The question this exists to answer without guessing is
 * "where did the money go" — and the answer is only available if the model and
 * the call site are on the same row. Strategist calls are few and expensive;
 * operator calls are many and cheap, and the ratio between them is the whole
 * design bet.
 *
 * In-memory, same posture as [trace.ts](./trace.ts): the UI reads it live via
 * /api/state. It is deliberately not a billing ledger. Prices move, per-account
 * rates differ, and a hard-coded price table would quietly go wrong and be
 * believed. Tokens are counted exactly because the gateway reports them;
 * currency is derived at the edge from a rate table the operator controls.
 */

export type UsageCall =
  /** The expensive one: diagnosis and what to authorise. Called rarely. */
  | "strategist"
  /** The cheap one: carrying the strategy out. Called often. */
  | "operator"
  | "review"
  /** The plan-level intent check: does this follow from what was reported? */
  | "intent"
  | "communicate"
  | "reply"
  /** The research distiller — the one call that reads untrusted web text. */
  | "research";

export interface UsageEvent {
  ticketId: string;
  call: UsageCall;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /** Wall clock, including transport — the number a waiting employee feels. */
  latencyMs: number;
  /** False when the call errored, timed out, or returned nothing usable. */
  ok: boolean;
  at: number;
}

export interface UsageTotals {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Summed model latency. Not elapsed ticket time — calls run concurrently. */
  modelMs: number;
  byModel: Record<string, { calls: number; totalTokens: number; modelMs: number }>;
  byCall: Record<string, { calls: number; totalTokens: number; modelMs: number }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __TICKET_USAGE__: Map<string, UsageEvent[]> | undefined;
}

const usage: Map<string, UsageEvent[]> = globalThis.__TICKET_USAGE__ ?? new Map();
if (!globalThis.__TICKET_USAGE__) globalThis.__TICKET_USAGE__ = usage;

/**
 * Record one model call. Never throws: accounting must not be able to fail a
 * ticket, and a swallowed metric is a smaller problem than a crashed graph.
 */
export function recordUsage(event: Omit<UsageEvent, "at">): void {
  try {
    const list = usage.get(event.ticketId) ?? [];
    list.push({ ...event, at: Date.now() });
    usage.set(event.ticketId, list);
  } catch {
    // deliberately ignored
  }
}

export function getUsage(ticketId: string): UsageEvent[] {
  return usage.get(ticketId) ?? [];
}

/**
 * Pulls the OpenAI-shaped `usage` block off a gateway response.
 *
 * A provider that reports no usage yields zeroes rather than an estimate. A
 * fabricated token count is worse than a missing one: it looks authoritative
 * and it silently skews every average computed over it.
 */
export function tokensFrom(raw: unknown): { promptTokens: number; completionTokens: number } {
  const u = (raw as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u) return { promptTokens: 0, completionTokens: 0 };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    promptTokens: n(u.prompt_tokens ?? u.input_tokens),
    completionTokens: n(u.completion_tokens ?? u.output_tokens),
  };
}

export function summarizeUsage(events: UsageEvent[]): UsageTotals {
  const totals: UsageTotals = {
    calls: events.length,
    failedCalls: events.filter((e) => !e.ok).length,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    modelMs: 0,
    byModel: {},
    byCall: {},
  };

  for (const e of events) {
    const tokens = e.promptTokens + e.completionTokens;
    totals.promptTokens += e.promptTokens;
    totals.completionTokens += e.completionTokens;
    totals.totalTokens += tokens;
    totals.modelMs += e.latencyMs;

    const m = (totals.byModel[e.model] ??= { calls: 0, totalTokens: 0, modelMs: 0 });
    m.calls += 1;
    m.totalTokens += tokens;
    m.modelMs += e.latencyMs;

    const c = (totals.byCall[e.call] ??= { calls: 0, totalTokens: 0, modelMs: 0 });
    c.calls += 1;
    c.totalTokens += tokens;
    c.modelMs += e.latencyMs;
  }

  return totals;
}
