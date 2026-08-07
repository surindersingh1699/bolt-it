/**
 * Secret redaction, in one place, imported by both ends.
 *
 * This used to live inside local-agent.mjs and was applied to exactly two of the
 * ten read paths — `fs_read` and `fs_grep`. Everything else went out raw: the
 * allowlisted-command output, the process list, the network state, and the
 * `stdout` captured on every single command record. A connection string in a
 * config file was redacted; the same string echoed by an allowlisted binary was
 * not.
 *
 * It is now applied to every field on the way out of the agent, and applied
 * AGAIN server-side after the envelope is parsed, so a modified or older agent
 * cannot write a credential into the database.
 *
 * `src/lib/redact.ts` mirrors this list, and a test asserts the two are
 * identical — two copies that can drift are worse than one that cannot.
 */

/** @type {Array<[RegExp, string]>} */
export const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private-key"],
  [/AKIA[0-9A-Z]{16}/g, "aws-key"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "github-token"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic-key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "slack-token"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "jwt"],
  // Added with the shared module. Each of these was reachable through a read
  // path that redaction did not previously cover.
  [/\bAuthorization\s*:\s*\S+/gi, "auth-header"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, "url-credentials"],
  [/\b(?:Password|Pwd|User Id|Uid)\s*=\s*[^;\s]+/gi, "connection-string"],
  [/\bCookie\s*:\s*\S+/gi, "cookie-header"],
  [/\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/g, "product-key"],
  // Generic last, so a more specific label wins when both would match.
  // Negative lookahead so this does not swallow a placeholder a more
  // specific rule already wrote — without it, "token: ghp_..." becomes
  // "[REDACTED:credential]" and the useful half of the label is lost.
  [/\b(password|passwd|secret|api[_-]?key|token|bearer)\b\s*[=:]\s*(?!\[REDACTED:)\S+/gi, "credential"],
];

/**
 * Replace anything key-shaped with a labelled placeholder.
 *
 * The label is kept on purpose: the planner still needs to know THAT a file
 * holds a credential — that is often the diagnosis — just not what it is.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const [re, label] of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
}

/**
 * Redact every string anywhere in a structure, in place-safe fashion.
 *
 * Used on the whole envelope rather than on a chosen field, because "which
 * fields carry output" is exactly the judgement that went wrong before. New
 * fields are covered by default instead of by remembering.
 *
 * @template T
 * @param {T} value
 * @param {number} [depth]
 * @returns {T}
 */
export function redactDeep(value, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === "string") return /** @type {T} */ (redactSecrets(value));
  if (Array.isArray(value)) return /** @type {T} */ (value.map((v) => redactDeep(v, depth + 1)));
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return /** @type {T} */ (out);
  }
  return value;
}
