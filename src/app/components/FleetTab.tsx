"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useFleetState } from "./useFleetState";
import { FleetList, FleetSelection } from "./FleetList";
import { FleetDetail } from "./FleetDetail";
import { PublicUser } from "@/lib/types";

export function FleetTab({ currentUser }: { currentUser: PublicUser }) {
  const fleet = useFleetState();
  const [selected, setSelected] = useState<FleetSelection>(null);

  if (!fleet) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-500 text-sm gap-2">
        <Loader2 size={14} className="animate-spin" />
        Loading fleet…
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[320px_1fr] h-full min-h-0">
      <div className="border-r border-neutral-800 min-h-0">
        <FleetList fleet={fleet} selected={selected} onSelect={setSelected} currentUser={currentUser} />
      </div>
      <div className="overflow-y-auto min-h-0">
        <FleetDetail fleet={fleet} selected={selected} />
      </div>
    </div>
  );
}
