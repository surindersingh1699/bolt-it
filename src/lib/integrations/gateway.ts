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

/**
 * One piece of a multimodal turn. The endpoint behind AI_GATEWAY_URL is
 * OpenAI-compatible, which means `content` already accepts either a bare string
 * or these parts — carrying a screenshot needs no new dependency and no second
 * transport, only a wider type here.
 */
export type GatewayContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type GatewayContent = string | GatewayContentPart[];

export interface GatewayRequest {
  model: string;
  system: string;
  /** A plain string, or content parts when an image rides along. */
  user: GatewayContent;
  temperature?: number;
  timeoutMs?: number;
  /** Which call this is, for the cost breakdown. */
  call: UsageCall;
  /** Ticket to bill. Omitted only for calls that belong to no ticket. */
  ticketId?: string;
}

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Models that reject `temperature` outright.
 *
 * The Claude 5 family answers a request carrying it with a 400 and
 * "`temperature` is deprecated for this model" — not a warning, not a silently
 * ignored field. Every call here passes a temperature, so without this the
 * repo's own defaults (`claude-opus-5` for the strategist, `claude-sonnet-5`
 * for the operator, reviewer and chat) fail on every single call.
 *
 * That failure is invisible from the outside: `gatewayChat` returns null,
 * callers fail closed, and the employee reads the deterministic fallback text.
 * The system looks like a bad writer rather than a disconnected one — which is
 * exactly how this went unnoticed until someone read the replies closely.
 *
 * Matched on the model id rather than kept as a list of exact slugs, so a new
 * member of the family (`claude-fable-5`, dated variants) is covered on arrival.
 */
const TEMPERATURE_UNSUPPORTED = /(^|\/)claude-[a-z]+-5(-|$)/;

export function supportsTemperature(model: string): boolean {
  return !TEMPERATURE_UNSUPPORTED.test(model);
}

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
        // Omitted, not defaulted, for models that refuse it — see
        // TEMPERATURE_UNSUPPORTED. Sending it is a 400, not a warning.
        ...(supportsTemperature(req.model) ? { temperature: req.temperature ?? 0.2 } : {}),
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // The provider's own reason, not just the status. A bare "returned 400"
      // is indistinguishable between a wrong model id, a rejected parameter and
      // an expired key — three problems with three different fixes, and the
      // employee sees the same fallback text for all of them.
      const why = await res.text().catch(() => "");
      console.warn(
        `[Gateway] ${req.call} (${req.model}) returned ${res.status}${why ? `: ${why.slice(0, 300)}` : ""}`,
      );
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
