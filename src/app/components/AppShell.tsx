"use client";

import { useState } from "react";
import { useAppState } from "./StateProvider";
import { Console } from "./Console";
import { SlackChat } from "./SlackChat";
import { LogAnalyzer } from "./LogAnalyzer";
import { DeflectionDashboard } from "./DeflectionDashboard";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { FleetTab } from "./FleetTab";
import { logoutAction } from "@/app/actions/auth";
import clsx from "clsx";
import { LayoutGrid, MessageSquare, LogOut, Mail, ScrollText, ShieldCheck, Users } from "lucide-react";
import { PublicUser } from "@/lib/types";

type Tab = "console" | "slack" | "logs" | "fleet";

const ALL_TABS: { id: Tab; label: string; icon: React.ReactNode; itStaffOnly?: boolean }[] = [
  { id: "console", label: "Console", icon: <LayoutGrid size={14} /> },
  { id: "fleet", label: "Users & Devices", icon: <Users size={14} />, itStaffOnly: true },
  { id: "slack", label: "Chat", icon: <MessageSquare size={14} /> },
  { id: "logs", label: "Analyze logs", icon: <ScrollText size={14} /> },
];

interface AppShellProps {
  currentUser: PublicUser;
  workspaceName: string;
}

export function AppShell({ currentUser, workspaceName }: AppShellProps) {
  const [tab, setTab] = useState<Tab>(currentUser.isITStaff ? "console" : "slack");
  const { stats, tickets } = useAppState();
  const TABS = ALL_TABS.filter((t) => !t.itStaffOnly || currentUser.isITStaff);

  return (
    <div className="h-screen max-h-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-hidden">
      <header className="border-b border-neutral-800 px-6 py-3 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-neutral-950 font-bold text-sm">
            IT
          </div>
          <span className="font-semibold tracking-tight">AI-Native IT Support</span>
          <span className="text-xs text-neutral-500 ml-2 hidden sm:inline">
            for {workspaceName} · LangGraph orchestration · per-step risk gating
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <AgentStatusBadge />
          <nav className="flex gap-1">
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
                {t.id === "slack" && tickets.length > 0 && (
                  <span className="text-[10px] text-neutral-500 ml-1">{tickets.length}</span>
                )}
              </button>
            ))}
          </nav>
          <UserBadge user={currentUser} />
        </div>
      </header>
      <DeflectionDashboard stats={stats} tickets={tickets} />
      <main className="flex-1 min-h-0 overflow-hidden">
        {tab === "console" && <Console currentUser={currentUser} />}
        {tab === "fleet" && currentUser.isITStaff && <FleetTab currentUser={currentUser} />}
        {tab === "slack" && <SlackChat currentUser={currentUser} />}
        {tab === "logs" && <LogAnalyzer currentUser={currentUser} />}
      </main>
    </div>
  );
}

function UserBadge({ user }: { user: PublicUser }) {
  return (
    <div className="flex items-center gap-2 pl-3 border-l border-neutral-800">
      <div className="text-right hidden md:block">
        <div className="text-xs text-neutral-200 leading-tight">{user.name}</div>
        <div className="text-[10px] text-neutral-500 flex items-center gap-1 justify-end">
          {user.isITStaff && <ShieldCheck size={9} className="text-emerald-400" />}
          {user.isITStaff ? "IT staff" : user.team}
        </div>
      </div>
        <form action={logoutAction}>
          <button
            type="submit"
            className="text-[11px] text-neutral-400 hover:text-neutral-100 bg-neutral-900 hover:bg-neutral-800 px-2 py-1.5 rounded flex items-center gap-1 transition-colors"
            title="Sign out"
          >
            <LogOut size={12} />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </form>
    </div>
  );
}
