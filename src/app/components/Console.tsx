"use client";

import { TicketQueue } from "./TicketQueue";
import { ActiveTicket } from "./ActiveTicket";
import { KnowledgeSidebar } from "./KnowledgeSidebar";

export function Console() {
  return (
    <div className="grid grid-cols-[300px_1fr_360px] h-[calc(100vh-99px)] divide-x divide-neutral-800">
      <TicketQueue />
      <ActiveTicket />
      <KnowledgeSidebar />
    </div>
  );
}
