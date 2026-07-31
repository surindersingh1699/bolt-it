// Per-ticket conversation transcript. Every message the agent would post to
// the Slack thread is also recorded here, so the in-app SlackChat tab shows
// the complete conversation even when no real Slack channel is wired.

export interface ChatMsg {
  from: "agent";
  text: string;
  at: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __TICKET_CHAT__: Map<string, ChatMsg[]> | undefined;
}

const store: Map<string, ChatMsg[]> = globalThis.__TICKET_CHAT__ ?? new Map();
if (!globalThis.__TICKET_CHAT__) globalThis.__TICKET_CHAT__ = store;

export function appendChat(ticketId: string, text: string): void {
  const list = store.get(ticketId) ?? [];
  list.push({ from: "agent", text, at: Date.now() });
  store.set(ticketId, list);
}

export function getChat(ticketId: string): ChatMsg[] {
  return store.get(ticketId) ?? [];
}

// Same classification the real Slack webhook uses for thread replies.
export function classifyConfirmation(text: string): "yes" | "no" | "ambiguous" {
  const t = text.toLowerCase().trim();
  if (/^(yes|y|yep|yeah|fixed|works|working|resolved|thanks|thank you|ty|done|all good|good|great|perfect|that did it|that worked)\b/.test(t)) {
    return "yes";
  }
  if (/^(no|n|nope|nah|still|broken|not (?:working|fixed)|same|didn't (?:work|help))\b/.test(t)) {
    return "no";
  }
  return "ambiguous";
}
