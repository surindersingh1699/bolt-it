"use client";

import { TicketQueue } from "./TicketQueue";
import { ActiveTicket } from "./ActiveTicket";
import { KnowledgeSidebar } from "./KnowledgeSidebar";
import { PublicUser } from "@/lib/types";

export function Console({
  currentUser,
  demoMode = false,
}: {
  currentUser: PublicUser;
  demoMode?: boolean;
}) {
  return (
    <div className="grid grid-cols-[300px_1fr_360px] h-full min-h-0 divide-x divide-neutral-800">
      <TicketQueue />
      <ActiveTicket currentUser={currentUser} demoMode={demoMode} />
      <KnowledgeSidebar />
    </div>
  );
}
