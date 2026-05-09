import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureSeeded } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  ensureSeeded();
  return NextResponse.json({
    tickets: db.listTickets(),
    runbooks: db.listRunbooks(),
    stats: db.deflectionStats(),
  });
}
