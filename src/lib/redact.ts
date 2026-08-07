/**
 * Server-side redaction — the second application, not the first.
 *
 * The agent redacts before upload. This runs again after the envelope is parsed
 * and before anything is persisted, which is what makes the guarantee survive a
 * modified, older, or simply buggy agent: the client is not the only thing
 * standing between a credential and the database.
 *
 * The pattern list is the same list. `redact.test.ts` asserts that this file and
 * `scripts/redact.mjs` have not drifted apart, because two copies that can
 * disagree are worse than one that cannot.
 */

export const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "private-key"],
  [/AKIA[0-9A-Z]{16}/g, "aws-key"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "github-token"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic-key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "slack-token"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, "jwt"],
  [/\bAuthorization\s*:\s*\S+/gi, "auth-header"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, "url-credentials"],
  [/\b(?:Password|Pwd|User Id|Uid)\s*=\s*[^;\s]+/gi, "connection-string"],
  [/\bCookie\s*:\s*\S+/gi, "cookie-header"],
  [/\b[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}\b/g, "product-key"],
  // Negative lookahead so this does not swallow a placeholder a more
  // specific rule already wrote — without it, "token: ghp_..." becomes
  // "[REDACTED:credential]" and the useful half of the label is lost.
  [/\b(password|passwd|secret|api[_-]?key|token|bearer)\b\s*[=:]\s*(?!\[REDACTED:)\S+/gi, "credential"],
];

export function redactSecrets(text: unknown): string {
  let out = String(text ?? "");
  for (const [re, label] of SECRET_PATTERNS) out = out.replace(re, `[REDACTED:${label}]`);
  return out;
}

/**
 * Redact every string anywhere in a structure.
 *
 * Applied to the whole envelope rather than to chosen fields, because "which
 * fields carry device output" is precisely the judgement that went wrong when
 * redaction covered two read paths out of ten. A field added later is covered
 * by default rather than by somebody remembering.
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redactSecrets(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, depth + 1);
    return out as unknown as T;
  }
  return value;
}
