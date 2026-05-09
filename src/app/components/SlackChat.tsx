"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { useAppState } from "./StateProvider";
import { createTicket } from "@/app/actions/tickets";
import { Bot, Hash, Send } from "lucide-react";
import { PublicUser, Ticket } from "@/lib/types";

const QUICK_PROMPTS: { subject: string; body: string }[] = [
  {
    subject: "Can't access Figma anymore",
    body: "I switched teams yesterday and now Figma says I don't have access. Was working fine on Monday.",
  },
  {
    subject: "VPN super slow today",
    body: "VPN is dropping every few minutes and pages take forever to load. Usually it's fine. Can someone look?",
  },
  {
    subject: "Locked out of Salesforce",
    body: "Got locked out after a failed login. Need a password reset please.",
  },
  {
    subject: "Mapped drives keep prompting for password",
    body: "Every time I open the intranet or a mapped drive, Windows asks for my password again. Started after I came back from PTO.",
  },
];

interface ChatLine {
  id: string;
  user: PublicUser;
  text: string;
  ts: number;
}

type ChannelLine =
  | {
      id: string;
      kind: "user";
      name: string;
      email: string;
      text: string;
      ts: number;
      ticket?: Ticket;
    }
  | {
      id: string;
      kind: "agent";
      text: string;
      ts: number;
      ticket: Ticket;
    };

export function SlackChat({ currentUser }: { currentUser: PublicUser }) {
  const { tickets } = useAppState();
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const [lines, setLines] = useState<ChatLine[]>([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines.length, tickets.length]);

  const submit = (subject: string, body: string) => {
    const line: ChatLine = {
      id: `line-${Math.random().toString(36).slice(2)}`,
      user: currentUser,
      text: body,
      ts: Date.now(),
    };
    setLines((prev) => [...prev, line]);
    startTransition(async () => {
      await createTicket({
        reporter: currentUser.name,
        reporterEmail: currentUser.email,
        subject,
        body,
        channel: "slack",
      });
    });
  };

  const send = () => {
    if (!draft.trim()) return;
    const subject = draft.split(/[.\n!?]/)[0].slice(0, 80) || "IT issue";
    const body = draft;
    setDraft("");
    submit(subject, body);
  };

  const ticketsByLine = new Map(tickets.map((t) => [`${t.reporterEmail}|${t.body}`, t]));
  const ticketLines = tickets
    .filter((t) => t.channel === "slack")
    .flatMap(ticketToChannelLines)
    .sort((a, b) => a.ts - b.ts);
  const optimisticLines: ChannelLine[] = lines
    .filter((line) => !ticketsByLine.has(`${line.user.email}|${line.text}`))
    .map((line) => ({
      id: line.id,
      kind: "user" as const,
      name: line.user.name,
      email: line.user.email,
      text: line.text,
      ts: line.ts,
    }));
  const channelLines = [...ticketLines, ...optimisticLines].sort((a, b) => a.ts - b.ts);

  return (
    <div className="grid grid-cols-[240px_1fr] h-full min-h-0">
      <aside className="bg-neutral-950 border-r border-neutral-800 px-3 py-4 overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wider text-neutral-500 px-2 mb-2">
          Posting as
        </div>
        <div className="px-2 py-2 rounded bg-neutral-900 border border-neutral-800 mb-5">
          <div className="flex items-center gap-2">
            <Avatar name={currentUser.name} />
            <div className="min-w-0">
              <div className="text-xs font-medium truncate">{currentUser.name}</div>
              <div className="text-[10px] text-neutral-500 truncate">{currentUser.email}</div>
            </div>
          </div>
          <div className="text-[10px] text-neutral-500 mt-1">
            {currentUser.title} · {currentUser.team}
            {currentUser.isITStaff && <span className="text-emerald-300"> · IT</span>}
          </div>
        </div>

        <div className="text-[10px] uppercase tracking-wider text-neutral-500 px-2 mb-2">
          Quick prompts
        </div>
        <ul className="space-y-1.5">
          {QUICK_PROMPTS.map((q, i) => (
            <li key={i}>
              <button
                onClick={() => submit(q.subject, q.body)}
                disabled={pending}
                className="w-full text-left px-2 py-1.5 rounded text-xs text-neutral-300 bg-neutral-900 hover:bg-neutral-800 transition-colors disabled:opacity-50"
              >
                {q.subject}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="flex min-h-0 flex-col bg-neutral-950">
        <div className="shrink-0 border-b border-neutral-800 px-6 py-3 flex items-center gap-2">
          <Hash size={14} className="text-neutral-500" />
          <span className="font-medium text-sm">it-support</span>
          <span className="text-xs text-neutral-500 ml-2">
            Customers report IT issues here. The agent watches and triages.
          </span>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {channelLines.length === 0 && (
            <div className="text-sm text-neutral-500 max-w-md">
              No messages yet. Click a quick prompt on the left or type your own message below as{" "}
              <span className="text-neutral-300">{currentUser.name}</span>. Each message becomes
              an IT ticket. Switch to the Console tab to watch the agent work it.
            </div>
          )}
          {channelLines.map((line) =>
            line.kind === "agent" ? (
              <AgentLine key={line.id} line={line} />
            ) : (
              <UserLine key={line.id} line={line} />
            ),
          )}
        </div>

        <div className="shrink-0 border-t border-neutral-800 bg-neutral-950 px-6 py-3">
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
              placeholder={`Message #it-support as ${currentUser.name}…`}
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

function ticketToChannelLines(ticket: Ticket): ChannelLine[] {
  const lines: ChannelLine[] = [
    {
      id: `${ticket.id}-user`,
      kind: "user",
      name: ticket.reporter,
      email: ticket.reporterEmail,
      text: ticket.body,
      ts: ticket.createdAt,
      ticket,
    },
  ];

  if (ticket.status === "drafting" || ticket.status === "new") {
    lines.push({
      id: `${ticket.id}-agent-working`,
      kind: "agent",
      text: "Got it. I am checking the company runbooks and user context now.",
      ts: ticket.updatedAt,
      ticket,
    });
    return lines;
  }

  if (ticket.draftResponse) {
    lines.push({
      id: `${ticket.id}-agent-reply`,
      kind: "agent",
      text: ticket.draftResponse,
      ts: ticket.resolvedAt ?? ticket.updatedAt,
      ticket,
    });
  }

  return lines;
}

function UserLine({ line }: { line: Extract<ChannelLine, { kind: "user" }> }) {
  return (
    <div className="flex items-start gap-3">
      <Avatar name={line.name} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm">{line.name}</span>
          <span className="text-[10px] text-neutral-500">
            {new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <p className="text-sm text-neutral-200 leading-relaxed">{line.text}</p>
        {line.ticket && (
          <div className="mt-1.5 text-[11px] text-neutral-500 flex items-center gap-2">
            <span className="bg-neutral-900 border border-neutral-800 px-1.5 py-0.5 rounded font-mono">
              {line.ticket.id}
            </span>
            <span>→</span>
            <span>{ticketStatusLabel(line.ticket)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function AgentLine({ line }: { line: Extract<ChannelLine, { kind: "agent" }> }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 h-7 rounded bg-emerald-500/20 text-emerald-200 flex items-center justify-center shrink-0">
        <Bot size={14} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm">MSP Copilot</span>
          <span className="text-[10px] text-neutral-500">
            {new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </span>
        </div>
        <p className="text-sm text-neutral-200 leading-relaxed">{line.text}</p>
        <div className="mt-1.5 text-[11px] text-emerald-300 flex items-center gap-2">
          <span className="bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded font-mono">
            {line.ticket.id}
          </span>
          <span>{line.ticket.status === "resolved" ? "delivered to Slack thread" : ticketStatusLabel(line.ticket)}</span>
        </div>
      </div>
    </div>
  );
}

function ticketStatusLabel(ticket: Ticket): string {
  if (ticket.status === "resolved") {
    return `resolved in ${Math.round((ticket.resolutionTimeMs ?? 0) / 1000)}s`;
  }
  if (ticket.status === "escalated") return "escalated";
  return `${ticket.status.replace("_", " ")}...`;
}

function Avatar({ name }: { name: string }) {
  const letter = name.charAt(0).toUpperCase();
  const palette = [
    "bg-emerald-500/30 text-emerald-200",
    "bg-violet-500/30 text-violet-200",
    "bg-amber-500/30 text-amber-200",
    "bg-cyan-500/30 text-cyan-200",
    "bg-rose-500/30 text-rose-200",
    "bg-sky-500/30 text-sky-200",
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const cls = palette[Math.abs(h) % palette.length];
  return (
    <div
      className={`w-7 h-7 rounded text-xs font-semibold flex items-center justify-center shrink-0 ${cls}`}
    >
      {letter}
    </div>
  );
}
