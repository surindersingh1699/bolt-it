"use client";

import { useState, useTransition } from "react";
import clsx from "clsx";
import { Radio, User as UserIcon, Monitor } from "lucide-react";
import type { FleetView, UserView, DeviceView } from "@/lib/fleet";
import { HealthBadge } from "./HealthBadge";
import { claimDevice } from "@/app/actions/fleet";
import { PublicUser } from "@/lib/types";

export type FleetSelection = { type: "user"; email: string } | { type: "device"; id: string } | null;

interface FleetListProps {
  fleet: FleetView;
  selected: FleetSelection;
  onSelect: (sel: FleetSelection) => void;
  currentUser: PublicUser;
}

export function FleetList({ fleet, selected, onSelect, currentUser }: FleetListProps) {
  return (
    <div className="overflow-y-auto bg-neutral-950 divide-y divide-neutral-900">
      <section>
        <SectionHeader icon={<UserIcon size={14} />} label="Users" count={fleet.users.length} />
        <ul className="divide-y divide-neutral-900">
          {fleet.users.map((u) => (
            <UserRow
              key={u.email}
              user={u}
              active={selected?.type === "user" && selected.email === u.email}
              onClick={() => onSelect({ type: "user", email: u.email })}
            />
          ))}
        </ul>
      </section>
      <section>
        <SectionHeader icon={<Monitor size={14} />} label="Devices" count={fleet.devices.length} />
        {fleet.unclaimedDevice && (
          <UnclaimedDeviceRow device={fleet.unclaimedDevice} users={fleet.users} currentUser={currentUser} />
        )}
        <ul className="divide-y divide-neutral-900">
          {fleet.devices.map((d) => (
            <DeviceRow
              key={d.id}
              device={d}
              active={selected?.type === "device" && selected.id === d.id}
              onClick={() => onSelect({ type: "device", id: d.id })}
            />
          ))}
        </ul>
      </section>
    </div>
  );
}

function SectionHeader({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="px-4 py-2 sticky top-0 bg-neutral-950/95 backdrop-blur border-b border-neutral-800 flex items-center gap-2">
      <span className="text-neutral-500">{icon}</span>
      <span className="text-xs uppercase tracking-wider text-neutral-500">{label}</span>
      <span className="ml-auto text-xs text-neutral-600">{count}</span>
    </div>
  );
}

function UserRow({ user, active, onClick }: { user: UserView; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={clsx(
          "w-full text-left px-4 py-2.5 hover:bg-neutral-900 transition-colors",
          active && "bg-neutral-900",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-neutral-200">{user.name}</span>
          {user.isITStaff && (
            <span className="text-[9px] uppercase tracking-wider text-emerald-400">IT</span>
          )}
          <span className="ml-auto">
            <HealthBadge tier={user.health} />
          </span>
        </div>
        <div className="text-xs text-neutral-500 mt-0.5">
          {user.team} · {user.title}
        </div>
      </button>
    </li>
  );
}

function DeviceRow({ device, active, onClick }: { device: DeviceView; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={clsx(
          "w-full text-left px-4 py-2.5 hover:bg-neutral-900 transition-colors",
          active && "bg-neutral-900",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono text-neutral-200">{device.hostname}</span>
          {device.isLiveNow && <Radio size={10} className="text-cyan-300 animate-pulse" />}
          <span className="ml-auto">
            <HealthBadge tier={device.health} />
          </span>
        </div>
        <div className="text-xs text-neutral-500 mt-0.5">
          {device.os} · {device.ownerName ?? "unassigned"}
        </div>
      </button>
    </li>
  );
}

function UnclaimedDeviceRow({
  device,
  users,
  currentUser,
}: {
  device: { hostname: string; os: string; lastPingAt: number };
  users: UserView[];
  currentUser: PublicUser;
}) {
  const [owner, setOwner] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClaim = () => {
    if (!owner) return;
    setError(null);
    startTransition(async () => {
      try {
        await claimDevice(device.hostname, device.os, owner);
      } catch (err) {
        setError((err as Error).message || "Claim failed");
      }
    });
  };

  return (
    <div className="px-4 py-3 border-b border-cyan-500/20 bg-cyan-500/5">
      <div className="flex items-center gap-2 mb-1">
        <Radio size={11} className="text-cyan-300 animate-pulse" />
        <span className="text-sm font-mono text-cyan-100">{device.hostname}</span>
        <span className="ml-auto text-[10px] text-cyan-300/80 uppercase tracking-wider">
          unclaimed · live
        </span>
      </div>
      <div className="text-xs text-neutral-500 mb-2">{device.os} · connected just now</div>
      {currentUser.isITStaff ? (
        <div className="flex items-center gap-2">
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="flex-1 bg-neutral-900 border border-neutral-800 rounded text-xs px-2 py-1.5 text-neutral-200"
          >
            <option value="">Assign to…</option>
            {users.map((u) => (
              <option key={u.email} value={u.email}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
          <button
            onClick={onClaim}
            disabled={!owner || pending}
            className="text-xs px-2.5 py-1.5 rounded bg-cyan-500/20 hover:bg-cyan-500/30 disabled:opacity-40 text-cyan-100 border border-cyan-500/30 transition-colors"
          >
            {pending ? "assigning…" : "Assign"}
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-neutral-500">Sign in as IT staff to assign this device.</div>
      )}
      {error && <div className="text-[11px] text-rose-300 mt-1">{error}</div>}
    </div>
  );
}
