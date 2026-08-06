/**
 * The one place this system talks to a model.
 *
 * Before this existed, every caller wrote its own fetch, its own AbortController,
 * its own status check and its own "response wasn't JSON" branch — six near
 * copies that had already drifted apart in their timeouts and their logging.
 * Worse, adding cost accounting meant editing all six identically and hoping.
 *
 * Callers now say what they want said and to which model. Transport, timeout,
 * failure shape and token accounting live here, once. A new call site gets all
 * four for free and cannot forget the last one.
 *
 * Contract: this NEVER throws and NEVER returns a partial success. Callers get
 * a string or null, and a null always means "you have no usable answer" —
 * whether the cause was a missing key, a timeout, an HTTP error, or a body that
 * was not JSON. That is what lets every caller upstream fail closed with a
 * single `if (!content)`.
 */

import { UsageCall, recordUsage, tokensFrom } from "../usage";

const AI_GATEWAY_URL = process.env.AI_GATEWAY_URL || "https://ai-gateway.vercel.sh/v1";

export interface GatewayRequest {
  model: string;
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number;
  /** Which call this is, for the cost breakdown. */
  call: UsageCall;
  /** Ticket to bill. Omitted only for calls that belong to no ticket. */
  ticketId?: string;
  /** Escalation depth being served, where there is one. */
  tier?: number;
}

const DEFAULT_TIMEOUT_MS = 25_000;

export async function gatewayChat(req: GatewayRequest): Promise<string | null> {
  if (!process.env.AI_GATEWAY_API_KEY) return null;

  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // One exit point for accounting, so a call cannot be spent without being
  // counted — including the failures, which are the expensive ones to miss.
  const bill = (ok: boolean, raw: unknown) => {
    if (!req.ticketId) return;
    const { promptTokens, completionTokens } = tokensFrom(raw);
    recordUsage({
      ticketId: req.ticketId,
      call: req.call,
      model: req.model,
      tier: req.tier,
      promptTokens,
      completionTokens,
      latencyMs: Date.now() - t0,
      ok,
    });
  };

  try {
    const res = await fetch(`${AI_GATEWAY_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: req.model,
        temperature: req.temperature ?? 0.2,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[Gateway] ${req.call} returned ${res.status}`);
      bill(false, null);
      return null;
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      console.warn(`[Gateway] ${req.call} response was not JSON`);
      bill(false, null);
      return null;
    }

    const content =
      (data as { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message
        ?.content ?? "";

    // Tokens were spent even when the content came back empty, so bill on the
    // real usage block and report the emptiness as the failure it is.
    bill(Boolean(content.trim()), data);
    return content.trim() ? content : null;
  } catch (err) {
    console.warn(`[Gateway] ${req.call} failed:`, (err as Error).message);
    bill(false, null);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
