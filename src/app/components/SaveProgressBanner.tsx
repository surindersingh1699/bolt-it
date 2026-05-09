import Link from "next/link";
import { ArrowRight } from "lucide-react";

export function SaveProgressBanner() {
  return (
    <div className="bg-emerald-950 border-b border-emerald-800 px-6 py-2 flex items-center gap-3">
      <span className="text-[11px] text-emerald-200">
        <strong className="text-emerald-100">Demo mode</strong> — your tickets and runbooks are saved
        in a temporary workspace. Sign up to bring them with you and invite your team.
      </span>
      <Link
        href="/signup?from=demo"
        className="ml-auto text-[11px] bg-emerald-500 hover:bg-emerald-400 text-neutral-950 font-medium px-3 py-1.5 rounded flex items-center gap-1.5 transition-colors"
      >
        Save & invite your team
        <ArrowRight size={12} />
      </Link>
    </div>
  );
}
