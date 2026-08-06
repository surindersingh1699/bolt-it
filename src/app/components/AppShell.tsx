"use client";

import { useState } from "react";
import clsx from "clsx";
import { LogOut } from "lucide-react";
import { logoutAction } from "@/app/actions/auth";
import { PublicUser } from "@/lib/types";
import { useAppState } from "./StateProvider";
import { AgentStatusBadge } from "./AgentStatusBadge";
import { InboxView } from "./InboxView";
import { MyTicketView } from "./MyTicketView";
import { FleetTab } from "./FleetTab";
import { LogAnalyzer } from "./LogAnalyzer";
import { MetricsView } from "./MetricsView";
import { avatarColor, GROUPS, groupOf, initialsOf, TicketGroup } from "./ticket-view";

type View = { kind: "tickets"; group: TicketGroup } | { kind: "fleet" | "logs" | "metrics" };

interface AppShellProps {
  currentUser: PublicUser;
  workspaceName: string;
}

export function AppShell({ currentUser, workspaceName }: AppShellProps) {
  if (!currentUser.isITStaff) {
    return (
      <div className="flex h-screen max-h-screen flex-col overflow-hidden bg-white">
        <TopBar currentUser={currentUser} workspaceName={workspaceName} showAgent={false} />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <MyTicketView currentUser={currentUser} />
        </main>
      </div>
    );
  }
  return <StaffShell currentUser={currentUser} workspaceName={workspaceName} />;
}

function StaffShell({ currentUser, workspaceName }: AppShellProps) {
  const { tickets } = useAppState();
  const [view, setView] = useState<View>({ kind: "tickets", group: "approval" });

  const countIn = (group: TicketGroup) => tickets.filter((t) => groupOf(t.status) === group).length;

  return (
    <div className="flex h-screen max-h-screen flex-col overflow-hidden bg-[#f6f8fc]">
      <TopBar currentUser={currentUser} workspaceName={workspaceName} showAgent />

      <div className="flex min-h-0 flex-1 pb-4 pl-2 pr-4">
        <nav className="w-[248px] flex-none overflow-y-auto pr-3 pt-2">
          {GROUPS.map((g) => (
            <NavItem
              key={g.id}
              label={g.label}
              count={countIn(g.id)}
              active={view.kind === "tickets" && view.group === g.id}
              onClick={() => setView({ kind: "tickets", group: g.id })}
            />
          ))}
          <div className="my-3 ml-5 border-t border-neutral-200" />
          <NavItem
            label="People & devices"
            active={view.kind === "fleet"}
            onClick={() => setView({ kind: "fleet" })}
          />
          <NavItem label="Analyse logs" active={view.kind === "logs"} onClick={() => setView({ kind: "logs" })} />
          <NavItem
            label="How the agent is doing"
            active={view.kind === "metrics"}
            onClick={() => setView({ kind: "metrics" })}
          />
        </nav>

        <div className="flex min-w-0 flex-1 overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          {view.kind === "tickets" && <InboxView group={view.group} currentUser={currentUser} />}
          {view.kind === "fleet" && <FleetTab currentUser={currentUser} />}
          {view.kind === "logs" && <LogAnalyzer currentUser={currentUser} />}
          {view.kind === "metrics" && <MetricsView currentUser={currentUser} />}
        </div>
      </div>
    </div>
  );
}

function TopBar({
  currentUser,
  workspaceName,
  showAgent,
}: {
  currentUser: PublicUser;
  workspaceName: string;
  showAgent: boolean;
}) {
  return (
    <header className="flex flex-none items-center gap-4 px-5 py-3">
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-blue-600 text-[17px] font-bold text-white">
          b
        </div>
        <span className="text-[18px] text-neutral-900">Bolt-it</span>
        <span className="hidden text-[13px] text-neutral-400 sm:inline">{workspaceName}</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        {showAgent && <AgentStatusBadge />}
        <div className="hidden text-right md:block">
          <div className="text-[12.5px] leading-tight text-neutral-800">{currentUser.name}</div>
          <div className="text-[11px] text-neutral-400">
            {currentUser.isITStaff ? "IT staff" : currentUser.team}
          </div>
        </div>
        <span
          className={clsx(
            "flex h-9 w-9 items-center justify-center rounded-full text-[12px] font-semibold text-white",
            avatarColor(currentUser.name),
          )}
        >
          {initialsOf(currentUser.name)}
        </span>
        <form action={logoutAction}>
          <button
            type="submit"
            title="Sign out"
            className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-neutral-200/70 hover:text-neutral-700"
          >
            <LogOut size={15} />
          </button>
        </form>
      </div>
    </header>
  );
}

function NavItem({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-3 rounded-full py-2.5 pl-5 pr-4 text-left text-[13.5px] transition-colors",
        active ? "bg-blue-50 font-medium text-blue-700" : "text-neutral-700 hover:bg-neutral-200/60",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span className={clsx("flex-none text-[12px]", active ? "text-blue-700" : "text-neutral-500")}>
          {count}
        </span>
      )}
    </button>
  );
}
