"use client";

import { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";

interface ArcPrompt {
  reporter: string;
  reporterEmail: string;
  subject: string;
  body: string;
}

const ARC: ArcPrompt[] = [
  {
    reporter: "Alex Reyes",
    reporterEmail: "alex@acme.test",
    subject: "Can't access Figma anymore",
    body: "I switched teams yesterday and now Figma says I don't have access. Was working fine on Monday.",
  },
  {
    reporter: "Priya Shah",
    reporterEmail: "priya@acme.test",
    subject: "VPN super slow today",
    body: "VPN is dropping every few minutes and pages take forever to load. Usually it's fine. Can someone look?",
  },
  {
    reporter: "Jordan Lee",
    reporterEmail: "jordan@acme.test",
    subject: "Locked out of Salesforce",
    body: "Got locked out after a failed login. Need a password reset please.",
  },
  {
    reporter: "Alex Reyes",
    reporterEmail: "alex@acme.test",
    subject: "Monitor flickers when I plug in the dock",
    body: "External display flickers and goes black for a second when I connect to the dock. Started today. No software updates recently.",
  },
];

export function DemoArcButton({ onSwitchTab }: { onSwitchTab: (tab: "console") => void }) {
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState(0);

  const run = async () => {
    if (running) return;
    setRunning(true);
    onSwitchTab("console");
    try {
      for (let i = 0; i < ARC.length; i++) {
        setStep(i + 1);
        const res = await fetch("/api/demo/ticket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...ARC[i], autoApprove: true }),
        });
        if (!res.ok) break;
        const { ticketId } = (await res.json()) as { ticketId: string };
        await waitForTerminal(ticketId, 45_000);
        if (i < ARC.length - 1) await sleep(1500);
      }
    } finally {
      setRunning(false);
      setStep(0);
    }
  };

  return (
    <button
      onClick={run}
      disabled={running}
      title="Fires Figma → VPN → Salesforce → novel ticket through the full pipeline"
      className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-emerald-500/15 hover:bg-emerald-500/25 disabled:opacity-60 disabled:cursor-not-allowed text-emerald-200 border border-emerald-500/30 transition-colors"
    >
      {running ? (
        <>
          <Loader2 size={12} className="animate-spin" />
          <span>
            Demo arc {step}/{ARC.length}
          </span>
        </>
      ) : (
        <>
          <Sparkles size={12} />
          <span>Run demo arc</span>
        </>
      )}
    </button>
  );
}

async function waitForTerminal(ticketId: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (res.ok) {
      const data = (await res.json()) as { tickets: Array<{ id: string; status: string }> };
      const t = data.tickets.find((x) => x.id === ticketId);
      if (t && (t.status === "resolved" || t.status === "escalated")) return;
    }
    await sleep(500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
