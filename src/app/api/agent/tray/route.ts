import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { authenticateAgent } from "@/lib/device-auth";

/**
 * Serves the tray app the same way the agent itself is served, and for the same
 * reason: a file copied onto a machine by hand is a file that is out of date by
 * the next edit, and nobody notices until a demo.
 *
 * The supervisor re-pulls this on every start, so the window a person watches
 * converges on the current build exactly like the agent behind it does.
 *
 * It carries no secret: it reads the agent's loopback console and the journal
 * the agent already writes. The token gate is the same one on /api/agent/script
 * — it keeps the file off the open internet, nothing more.
 */
export async function GET(req: Request) {
  if (!(await authenticateAgent(req))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const file = path.join(process.cwd(), "scripts", "vm", "agent-tray.ps1");
    const source = await readFile(file, "utf8");
    return new NextResponse(source, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  } catch (err) {
    console.error("[agent/tray] could not read agent-tray.ps1:", (err as Error).message);
    return NextResponse.json({ error: "tray app unavailable" }, { status: 500 });
  }
}
