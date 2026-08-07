// The agent writes its replies in Slack's mrkdwn (docs/TIERS.md: "Slack plain
// text"), so the chat surface has to render it or the reader sees the markup —
// "_Ticket T-6970_" instead of an italic ticket reference.
//
// Deliberately only the three inline spans the agent actually emits. Anything
// else stays literal text, which is the safe failure: an unrecognised marker
// reads as itself rather than swallowing the line.

export type Span = { kind: "text" | "bold" | "italic" | "code"; text: string };

// Markers only count at a word boundary, so identifiers the agent quotes from a
// machine — snake_case_name, a path with underscores — stay intact.
const PATTERN = /(?<![A-Za-z0-9])(\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`)(?![A-Za-z0-9])/g;

const KIND: Record<string, Span["kind"]> = { "*": "bold", _: "italic", "`": "code" };

/** Split one line of mrkdwn into styled spans. Never throws; never drops text. */
export function parseMrkdwn(input: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of input.matchAll(PATTERN)) {
    const at = match.index;
    if (at > last) spans.push({ kind: "text", text: input.slice(last, at) });
    const token = match[0];
    spans.push({ kind: KIND[token[0]], text: token.slice(1, -1) });
    last = at + token.length;
  }
  if (last < input.length) spans.push({ kind: "text", text: input.slice(last) });
  return spans;
}
