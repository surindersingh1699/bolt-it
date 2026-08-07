// External knowledge: web search and page extraction, backed by Tavily.
//
// "Undocumented at this company" is not "undocumented anywhere". An unfamiliar
// error code or a regression in a specific app build is usually written down by
// a vendor — this is how the agent reaches that.
//
// This module is TRANSPORT ONLY. It returns raw external text in a structured
// shape and makes no claim about it. Nothing here ever reaches a planner prompt
// directly: research.ts is the only consumer, and it distils this into short
// attributed claims before anything enters graph state. That boundary is the
// point — raw page text is attacker-influenceable, and the planner's output
// becomes commands on an employee's machine.
//
// Page extraction is additionally domain-allowlisted — see below.

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";

const SEARCH_TIMEOUT_MS = 10_000;
const EXTRACT_TIMEOUT_MS = 15_000;

// Sites whose pages we are willing to pull in full. Subdomains count. Search
// itself is unrestricted — it returns short snippets — but fetching a whole page
// is how a hostile document would get its full text in front of the planner, so
// that path stays on vendors a technician would already trust.
const FETCH_DOMAIN_ALLOWLIST = [
  "microsoft.com",
  "windows.com",
  "apple.com",
  "jamf.com",
  "atlassian.com",
  "mozilla.org",
  "google.com",
  "chromium.org",
  "adobe.com",
  "citrix.com",
  "vmware.com",
  "cisco.com",
  "slack.com",
  "zoom.us",
  "dell.com",
  "hp.com",
  "lenovo.com",
  "ubuntu.com",
  "redhat.com",
  "debian.org",
  "stackoverflow.com",
  "superuser.com",
  "serverfault.com",
  "askubuntu.com",
  ...(process.env.KB_EXTRA_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
];

// Belt and braces alongside the allowlist: an allowlisted host can never be one
// of these, so this only fires if the allowlist is widened carelessly later.
const BLOCKED_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localdomain|\[?::1\]?|0\.0\.0\.0)$/i;
const PRIVATE_IPV4 =
  /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function tavilyHeaders(): Record<string, string> {
  const key = process.env.TAVILY_API_KEY;
  return {
    "Content-Type": "application/json",
    // Keyless mode means this works with no signup at all. A real key raises the
    // rate limit and is what any non-toy deployment should use.
    ...(key ? { Authorization: `Bearer ${key}` } : { "X-Tavily-Access-Mode": "keyless" }),
  };
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: tavilyHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}` };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : e.message };
  } finally {
    clearTimeout(timer);
  }
}

interface TavilyResult {
  title?: string;
  url?: string;
  link?: string;
  content?: string;
  snippet?: string;
  raw_content?: string;
  score?: number;
}

function resultUrl(r: TavilyResult): string {
  return r.url ?? r.link ?? "";
}

function resultText(r: TavilyResult): string {
  return r.content ?? r.snippet ?? r.raw_content ?? "";
}

function hostAllowedForFetch(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: `protocol ${url.protocol} is not allowed` };
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOST.test(host) || PRIVATE_IPV4.test(host)) {
    return { ok: false, reason: "target is a private or loopback address" };
  }
  const allowed = FETCH_DOMAIN_ALLOWLIST.some((d) => host === d || host.endsWith(`.${d}`));
  if (!allowed) {
    return { ok: false, reason: `${host} is not on the fetch domain allowlist` };
  }
  return { ok: true, url };
}

/** One external result, exactly as the provider returned it. No interpretation. */
export interface WebResult {
  title: string;
  url: string;
  text: string;
}

export interface WebSearchRaw {
  ok: boolean;
  /** The provider's own one-paragraph answer, when it offered one. */
  answer?: string;
  results: WebResult[];
  error?: string;
}

/** Never throws — a lookup that fails returns ok:false (CLAUDE.md rule 4). */
export async function webSearchRaw(query: string): Promise<WebSearchRaw> {
  const trimmed = String(query ?? "").trim();
  if (!trimmed) return { ok: false, results: [], error: "no query supplied" };

  try {
    const res = await postJson(
      TAVILY_SEARCH_URL,
      { query: trimmed.slice(0, 400), search_depth: "basic", max_results: 5, include_answer: true },
      SEARCH_TIMEOUT_MS,
    );
    if (!res.ok) return { ok: false, results: [], error: res.error };

    const data = res.data as { answer?: string; results?: TavilyResult[] };
    const results: WebResult[] = (data.results ?? [])
      .filter((r) => resultUrl(r))
      .slice(0, 5)
      .map((r) => ({
        title: r.title ?? "(untitled)",
        url: resultUrl(r),
        text: resultText(r).replace(/\s+/g, " ").trim().slice(0, 800),
      }));

    if (results.length === 0 && !data.answer) {
      return { ok: false, results: [], error: `"${trimmed}" returned nothing usable` };
    }
    return { ok: true, answer: data.answer?.slice(0, 700), results };
  } catch (err) {
    return { ok: false, results: [], error: (err as Error).message };
  }
}

export interface PageRaw {
  ok: boolean;
  url?: string;
  text?: string;
  error?: string;
}

/**
 * Pull a whole page. Domain-allowlisted, because a full document is how a
 * hostile page would get its entire text into the pipeline — search snippets
 * are short and come from an unrestricted set, a full extract does not.
 */
export async function fetchPageRaw(rawUrl: string): Promise<PageRaw> {
  const check = hostAllowedForFetch(String(rawUrl ?? "").trim());
  if (!check.ok) return { ok: false, error: `refused to fetch — ${check.reason}` };

  try {
    const res = await postJson(
      TAVILY_EXTRACT_URL,
      { urls: check.url.toString(), format: "text", extract_depth: "basic" },
      EXTRACT_TIMEOUT_MS,
    );
    if (!res.ok) return { ok: false, error: res.error };

    const body = res.data ? resultText((res.data as { results?: TavilyResult[] }).results?.[0] ?? {}) : "";
    if (!body) return { ok: false, error: `${check.url.host} returned no extractable content` };

    return {
      ok: true,
      url: check.url.toString(),
      text: body.replace(/\s+/g, " ").trim().slice(0, 6000),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export const __testing = { hostAllowedForFetch };
