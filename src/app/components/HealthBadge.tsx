import { ShieldCheck, AlertTriangle, AlertCircle, HelpCircle } from "lucide-react";
import type { HealthTier } from "@/lib/fleet";

const STYLES: Record<HealthTier, { cls: string; Icon: typeof ShieldCheck; label: string }> = {
  healthy: { cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", Icon: ShieldCheck, label: "healthy" },
  attention: { cls: "bg-amber-500/15 text-amber-300 border-amber-500/30", Icon: AlertTriangle, label: "attention" },
  critical: { cls: "bg-rose-500/15 text-rose-300 border-rose-500/30", Icon: AlertCircle, label: "critical" },
  unknown: { cls: "bg-neutral-800 text-neutral-500 border-neutral-700", Icon: HelpCircle, label: "unknown" },
};

export function HealthBadge({ tier }: { tier: HealthTier }) {
  const { cls, Icon, label } = STYLES[tier];
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border flex items-center gap-1 w-fit ${cls}`}>
      <Icon size={9} />
      {label}
    </span>
  );
}
