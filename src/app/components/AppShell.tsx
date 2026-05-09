"use client";

import { useState } from "react";
import { useAppState } from "./StateProvider";
import { Console } from "./Console";
import { SlackChat } from "./SlackChat";
import { RunbooksTab } from "./RunbooksTab";
import { DeflectionDashboard } from "./DeflectionDashboard";
import { DemoArcButton } from "./DemoArcButton";
import { SaveProgressBanner } from "./SaveProgressBanner";
import { logoutAction } from "@/app/actions/auth";
import clsx from "clsx";
import { LayoutGrid, MessageSquare, BookOpen, LogOut, Mail, ShieldCheck } from "lucide-react";
import { PublicUser } from "@/lib/types";

type Tab = "console" | "slack" | "runbooks";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "console", label: "Console", icon: <LayoutGrid size={14} /> },
  { id: "slack", label: "Slack (demo)", icon: <MessageSquare size={14} /> },
  { id: "runbooks", label: "Runbooks", icon: <BookOpen size={14} /> },
];

interface AppShellProps {
  currentUser: PublicUser;
  workspaceName: string;
  demoMode?: boolean;
}

export function AppShell({ currentUser, workspaceName, demoMode = false }: AppShellProps) {
  const [tab, setTab] = useState<Tab>(currentUser.isITStaff ? "console" : "slack");
  const { stats, runbooks, tickets } = useAppState();

  return (
    <div className="h-screen max-h-screen bg-neutral-950 text-neutral-100 flex flex-col overflow-hidden">
      {demoMode && <SaveProgressBanner />}
      <header className="border-b border-neutral-800 px-6 py-3 flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-emerald-400 to-teal-600 flex items-center justify-center text-neutral-950 font-bold text-sm">
            IT
          </div>
          <span className="font-semibold tracking-tight">AI-Native IT Support</span>
          <span className="text-xs text-neutral-500 ml-2 hidden sm:inline">
            for {workspaceName} · Slack-native · zero standing access
          </span>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <DemoArcButton onSwitchTab={setTab} />
          <a
            href="mailto:sabysurinder@gmail.com"
            className="hidden lg:flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-neutral-800 bg-neutral-900 text-neutral-300 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
            title="Contact for a demo"
          >
            <Mail size={12} />
            Contact
          </a>
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
                {t.id === "runbooks" && (
                  <span className="text-[10px] text-neutral-500 ml-1">{runbooks.length}</span>
                )}
                {t.id === "slack" && tickets.length > 0 && (
                  <span className="text-[10px] text-neutral-500 ml-1">{tickets.length}</span>
                )}
              </button>
            ))}
          </nav>
          <UserBadge user={currentUser} demoMode={demoMode} />
        </div>
      </header>
      <DeflectionDashboard stats={stats} />
      <main className="flex-1 min-h-0 overflow-hidden">
        {tab === "console" && <Console currentUser={currentUser} demoMode={demoMode} />}
        {tab === "slack" && <SlackChat currentUser={currentUser} />}
        {tab === "runbooks" && <RunbooksTab />}
      </main>
    </div>
  );
}

function UserBadge({ user, demoMode }: { user: PublicUser; demoMode: boolean }) {
  return (
    <div className="flex items-center gap-2 pl-3 border-l border-neutral-800">
      <div className="text-right hidden md:block">
        <div className="text-xs text-neutral-200 leading-tight">{user.name}</div>
        <div className="text-[10px] text-neutral-500 flex items-center gap-1 justify-end">
          {user.isITStaff && <ShieldCheck size={9} className="text-emerald-400" />}
          {demoMode ? "Demo guest" : user.isITStaff ? "IT staff" : user.team}
        </div>
      </div>
      {demoMode ? (
        <a
          href="/signup?from=demo"
          className="text-[11px] text-neutral-950 bg-emerald-500 hover:bg-emerald-400 px-2 py-1.5 rounded flex items-center gap-1 transition-colors"
          title="Sign up to keep this workspace"
        >
          <span className="hidden sm:inline">Sign up</span>
        </a>
      ) : (
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
      )}
    </div>
  );
}
