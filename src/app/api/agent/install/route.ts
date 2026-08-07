import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Serves scripts/vm/install-agent.ps1 so a fresh machine can bootstrap with one
 * line instead of a hand-copied file.
 *
 * Unauthenticated on purpose, and safe to be: the installer contains no secret.
 * The operator passes `-Token` themselves, and it is written only to the guest's
 * own ACL'd config. This is the distinction the deleted `public/setup.ps1`
 * failed — that file had the shared token baked into its body.
 *
 * The agent source at /api/agent/script stays bearer-gated.
 */
export async function GET() {
  try {
    const file = path.join(process.cwd(), "scripts", "vm", "install-agent.ps1");
    const source = await readFile(file, "utf8");
    return new NextResponse(source, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    console.error("[agent/install] could not read install-agent.ps1:", (err as Error).message);
    return NextResponse.json({ error: "installer unavailable" }, { status: 500 });
  }
}
