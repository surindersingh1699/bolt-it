import { ShieldCheck, AlertTriangle, AlertCircle, HelpCircle } from "lucide-react";
import type { HealthTier } from "@/lib/fleet";

const STYLES: Record<HealthTier, { cls: string; Icon: typeof ShieldCheck; label: string }> = {
  healthy: { cls: "bg-emerald-50 text-emerald-700 border-emerald-200", Icon: ShieldCheck, label: "healthy" },
  attention: { cls: "bg-amber-50 text-amber-700 border-amber-200", Icon: AlertTriangle, label: "attention" },
  critical: { cls: "bg-rose-50 text-rose-700 border-rose-200", Icon: AlertCircle, label: "critical" },
  unknown: { cls: "bg-neutral-100 text-neutral-600 border-neutral-200", Icon: HelpCircle, label: "unknown" },
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
