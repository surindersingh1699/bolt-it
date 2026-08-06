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
    <div className="overflow-y-auto bg-white divide-y divide-neutral-200">
      <section>
        <SectionHeader icon={<UserIcon size={14} />} label="Users" count={fleet.users.length} />
        <ul className="divide-y divide-neutral-200">
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
        <ul className="divide-y divide-neutral-200">
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
    <div className="px-4 py-2 sticky top-0 bg-white/95 backdrop-blur border-b border-neutral-200 flex items-center gap-2">
      <span className="text-neutral-500">{icon}</span>
      <span className="text-xs uppercase tracking-wider text-neutral-500">{label}</span>
      <span className="ml-auto text-xs text-neutral-400">{count}</span>
    </div>
  );
}

function UserRow({ user, active, onClick }: { user: UserView; active: boolean; onClick: () => void }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={clsx(
          "w-full text-left px-4 py-2.5 hover:bg-neutral-50 transition-colors",
          active && "bg-neutral-50",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm text-neutral-800">{user.name}</span>
          {user.isITStaff && (
            <span className="text-[9px] uppercase tracking-wider text-emerald-600">IT</span>
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
          "w-full text-left px-4 py-2.5 hover:bg-neutral-50 transition-colors",
          active && "bg-neutral-50",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-mono text-neutral-800">{device.hostname}</span>
          {device.isLiveNow && <Radio size={10} className="text-blue-600 animate-pulse" />}
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
    <div className="px-4 py-3 border-b border-blue-200 bg-blue-50">
      <div className="flex items-center gap-2 mb-1">
        <Radio size={11} className="text-blue-600 animate-pulse" />
        <span className="text-sm font-mono text-blue-800">{device.hostname}</span>
        <span className="ml-auto text-[10px] text-blue-600 uppercase tracking-wider">
          unclaimed · live
        </span>
      </div>
      <div className="text-xs text-neutral-500 mb-2">{device.os} · connected just now</div>
      {currentUser.isITStaff ? (
        <div className="flex flex-col gap-2">
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="w-full min-w-0 rounded border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-800"
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
            className="w-full rounded-full bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-40"
          >
            {pending ? "assigning…" : "Assign this machine"}
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-neutral-500">Sign in as IT staff to assign this device.</div>
      )}
      {error && <div className="text-[11px] text-rose-700 mt-1">{error}</div>}
    </div>
  );
}
