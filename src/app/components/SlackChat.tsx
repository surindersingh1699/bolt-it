"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { useAppState } from "./StateProvider";
import { createTicket } from "@/app/actions/tickets";
import { Hash, Send } from "lucide-react";

interface DemoUser {
  email: string;
  name: string;
  avatar: string;
}

const USERS: DemoUser[] = [
  { email: "alex@acme.test", name: "Alex Reyes", avatar: "A" },
  { email: "priya@acme.test", name: "Priya Shah", avatar: "P" },
  { email: "jordan@acme.test", name: "Jordan Lee", avatar: "J" },
];

const QUICK_PROMPTS = [
  { user: USERS[0], subject: "Can't access Figma anymore", body: "I switched teams yesterday and now Figma says I don't have access. Was working fine on Monday." },
  { user: USERS[1], subject: "VPN super slow today", body: "VPN is dropping every few minutes and pages take forever to load. Usually it's fine. Can someone look?" },
  { user: USERS[2], subject: "Locked out of Salesforce", body: "Got locked out after a failed login. Need a password reset please." },
];

interface ChatLine {
  id: string;
  user: DemoUser;
  text: string;
  ts: number;
}

export function SlackChat() {
  const { tickets } = useAppState();
  const [activeUser, setActiveUser] = useState<DemoUser>(USERS[0]);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines.length, tickets.length]);

  const send = () => {
    if (!draft.trim()) return;
    const line: ChatLine = {
      id: `line-${Math.random().toString(36).slice(2)}`,
      user: activeUser,
      text: draft,
      ts: Date.now(),
    };
    setLines((prev) => [...prev, line]);
    const subject = draft.split(/[.\n!?]/)[0].slice(0, 80) || "IT issue";
    const body = draft;
    setDraft("");
    startTransition(async () => {
      await createTicket({
        reporter: activeUser.name,
        reporterEmail: activeUser.email,
        subject,
        body,
        channel: "slack",
      });
    });
  };

  const sendQuick = (q: typeof QUICK_PROMPTS[number]) => {
    setActiveUser(q.user);
    const line: ChatLine = {
      id: `line-${Math.random().toString(36).slice(2)}`,
      user: q.user,
      text: q.body,
      ts: Date.now(),
    };
    setLines((prev) => [...prev, line]);
    startTransition(async () => {
      await createTicket({
        reporter: q.user.name,
        reporterEmail: q.user.email,
        subject: q.subject,
        body: q.body,
        channel: "slack",
      });
    });
  };

  const ticketsByLine = new Map(
    tickets.map((t) => [`${t.reporterEmail}|${t.body}`, t]),
  );

  return (
    <div className="grid grid-cols-[240px_1fr] h-[calc(100vh-99px)]">
      <aside className="bg-neutral-950 border-r border-neutral-800 px-3 py-4 overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 px-2 mb-2">
          Demo users (post as)
        </div>
        <ul className="space-y-1">
          {USERS.map((u) => (
            <li key={u.email}>
              <button
                onClick={() => setActiveUser(u)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 transition-colors ${
                  activeUser.email === u.email
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900"
                }`}
              >
                <Avatar letter={u.avatar} />
                <span className="text-xs">{u.name}</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="text-[10px] uppercase tracking-wider text-neutral-500 px-2 mt-6 mb-2">
          Quick demo prompts
        </div>
        <ul className="space-y-1.5">
          {QUICK_PROMPTS.map((q, i) => (
            <li key={i}>
              <button
                onClick={() => sendQuick(q)}
                disabled={pending}
                className="w-full text-left px-2 py-1.5 rounded text-xs text-neutral-300 bg-neutral-900 hover:bg-neutral-800 transition-colors disabled:opacity-50"
              >
                <div className="text-[11px] text-neutral-500 mb-0.5">{q.user.name}</div>
                {q.subject}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex flex-col bg-neutral-950">
        <div className="border-b border-neutral-800 px-6 py-3 flex items-center gap-2">
          <Hash size={14} className="text-neutral-500" />
          <span className="font-medium text-sm">it-support</span>
          <span className="text-xs text-neutral-500 ml-2">
            Customers report IT issues here. The agent watches and triages.
          </span>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {lines.length === 0 && (
            <div className="text-sm text-neutral-500 max-w-md">
              No messages yet. Click a quick prompt on the left or type your own message below as{" "}
              <span className="text-neutral-300">{activeUser.name}</span>.
              Each message becomes an IT ticket. Switch to the Console tab to watch the agent work it.
            </div>
          )}
          {lines.map((line) => {
            const ticket = ticketsByLine.get(`${line.user.email}|${line.text}`);
            return (
              <div key={line.id} className="flex items-start gap-3">
                <Avatar letter={line.user.avatar} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium text-sm">{line.user.name}</span>
                    <span className="text-[10px] text-neutral-500">
                      {new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <p className="text-sm text-neutral-200 leading-relaxed">{line.text}</p>
                  {ticket && (
                    <div className="mt-1.5 text-[11px] text-neutral-500 flex items-center gap-2">
                      <span className="bg-neutral-900 border border-neutral-800 px-1.5 py-0.5 rounded font-mono">
                        {ticket.id}
                      </span>
                      <span>→</span>
                      <span>
                        {ticket.status === "resolved"
                          ? `resolved in ${Math.round((ticket.resolutionTimeMs ?? 0) / 1000)}s`
                          : ticket.status === "escalated"
                            ? "escalated"
                            : `${ticket.status.replace("_", " ")}…`}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-neutral-800 px-6 py-3">
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`Message #it-support as ${activeUser.name}…`}
              className="flex-1 bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm placeholder:text-neutral-600 focus:outline-none focus:border-neutral-700"
              disabled={pending}
            />
            <button
              onClick={send}
              disabled={pending || !draft.trim()}
              className="bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-neutral-950 px-4 rounded flex items-center gap-1.5 text-sm font-medium transition-colors"
            >
              <Send size={14} />
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Avatar({ letter }: { letter: string }) {
  const colors: Record<string, string> = {
    A: "bg-emerald-500/30 text-emerald-200",
    P: "bg-violet-500/30 text-violet-200",
    J: "bg-amber-500/30 text-amber-200",
  };
  return (
    <div
      className={`w-7 h-7 rounded text-xs font-semibold flex items-center justify-center shrink-0 ${
        colors[letter] ?? "bg-neutral-800 text-neutral-300"
      }`}
    >
      {letter}
    </div>
  );
}
