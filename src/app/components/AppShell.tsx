"use client";

import { useState } from "react";
import { useAppState } from "./StateProvider";
import { Console } from "./Console";
import { SlackChat } from "./SlackChat";
import { RunbooksTab } from "./RunbooksTab";
import { DeflectionDashboard } from "./DeflectionDashboard";
import clsx from "clsx";
import { LayoutGrid, MessageSquare, BookOpen } from "lucide-react";

type Tab = "console" | "slack" | "runbooks";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "console", label: "Console", icon: <LayoutGrid size={14} /> },
  { id: "slack", label: "Slack (demo)", icon: <MessageSquare size={14} /> },
  { id: "runbooks", label: "Runbooks", icon: <BookOpen size={14} /> },
];

export function AppShell() {
  const [tab, setTab] = useState<Tab>("console");
  const { stats, runbooks, tickets } = useAppState();

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col">
      <header className="border-b border-neutral-800 px-6 py-3 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-neutral-950 font-bold text-sm">
            IT
          </div>
          <span className="font-semibold tracking-tight">AI-Native IT Support</span>
          <span className="text-xs text-neutral-500 ml-2 hidden sm:inline">
            for Acme Corp · Slack-native · zero standing access
          </span>
        </div>
        <nav className="flex gap-1 ml-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                "px-3 py-1.5 text-xs rounded-md flex items-center gap-1.5 transition-colors",
                tab === t.id
                  ? "bg-neutral-800 text-neutral-100"
                  : "text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900",
              )}
            >
              {t.icon}
              {t.label}
              {t.id === "runbooks" && (
                <span className="text-[10px] text-neutral-500 ml-1">{runbooks.length}</span>
              )}
              {t.id === "slack" && tickets.length > 0 && (
                <span className="text-[10px] text-neutral-500 ml-1">{tickets.length}</span>
              )}
            </button>
          ))}
        </nav>
      </header>
      <DeflectionDashboard stats={stats} />
      <main className="flex-1 overflow-hidden">
        {tab === "console" && <Console />}
        {tab === "slack" && <SlackChat />}
        {tab === "runbooks" && <RunbooksTab />}
      </main>
    </div>
  );
}
