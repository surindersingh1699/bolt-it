import { Fragment } from "react";
import { User as UserIcon, Monitor, Radio } from "lucide-react";
import type { FleetView } from "@/lib/fleet";
import { HealthBadge } from "./HealthBadge";
import type { FleetSelection } from "./FleetList";

export function FleetDetail({ fleet, selected }: { fleet: FleetView; selected: FleetSelection }) {
  if (!selected) {
    return (
      <div className="flex items-center justify-center h-full text-neutral-500 text-sm">
        Select a user or device to view details
      </div>
    );
  }

  if (selected.type === "user") {
    const user = fleet.users.find((u) => u.email === selected.email);
    if (!user) return null;
    return (
      <div className="px-6 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <UserIcon size={18} className="text-neutral-500" />
          <div>
            <div className="text-lg font-semibold text-neutral-900">{user.name}</div>
            <div className="text-xs text-neutral-500">{user.email}</div>
          </div>
          <span className="ml-auto">
            <HealthBadge tier={user.health} />
          </span>
        </div>
        <DetailGrid
          rows={[
            ["Team", user.team],
            ["Title", user.title],
            ["Manager", user.manager ?? "—"],
            ["IT staff", user.isITStaff ? "yes" : "no"],
            ["Account status", user.accountStatus ?? "unknown"],
            ["Last login", user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "—"],
            ["Groups", user.groups.join(", ") || "—"],
          ]}
        />
      </div>
    );
  }

  const device = fleet.devices.find((d) => d.id === selected.id);
  if (!device) return null;
  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center gap-3">
        <Monitor size={18} className="text-neutral-500" />
        <div>
          <div className="text-lg font-semibold font-mono text-neutral-900">{device.hostname}</div>
          <div className="text-xs text-neutral-500">{device.os}</div>
        </div>
        {device.isLiveNow && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-blue-600">
            <Radio size={11} className="animate-pulse" />
            live now
          </span>
        )}
        {!device.isLiveNow && (
          <span className="ml-auto">
            <HealthBadge tier={device.health} />
          </span>
        )}
      </div>
      <DetailGrid
        rows={[
          ["Owner", device.ownerName ? `${device.ownerName} (${device.ownerEmail})` : "unassigned"],
          ["Source", device.source],
          ["First seen", new Date(device.firstSeenAt).toLocaleString()],
          ["Last seen", new Date(device.lastSeenAt).toLocaleString()],
          ["Claimed by", device.claimedBy ?? "—"],
        ]}
      />
    </div>
  );
}

function DetailGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <div className="text-neutral-500">{label}</div>
          <div className="text-neutral-800">{value}</div>
        </Fragment>
      ))}
    </div>
  );
}
