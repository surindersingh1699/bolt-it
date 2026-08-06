// Wipe the database back to one person in one workspace: no tickets, no device
// jobs, no per-user memory, no leftover demo workspaces, and a directory
// containing only the account you keep.
//
//   node scripts/reset-workspace.mjs            # dry run, prints what would go
//   node scripts/reset-workspace.mjs --yes      # actually deletes
//
// The kept account's row is never touched, so its password still works.
// Override with KEEP_EMAIL= / KEEP_WORKSPACE=.
//
// Reads NEXT_PUBLIC_INSFORGE_URL / INSFORGE_API_KEY from .env.local. With
// InsForge unset there is nothing to do — the in-memory store starts empty on
// every restart anyway.

import { readFileSync } from "node:fs";
import { createClient } from "@insforge/sdk";

const KEEP_WORKSPACE = process.env.KEEP_WORKSPACE || "acme.test";
const KEEP_EMAIL = (process.env.KEEP_EMAIL || "sabysurinder@gmail.com").toLowerCase();

/** Belongs to a ticket run, not to a person. All of it goes, every workspace. */
const RUN_DATA_TABLES = ["tickets", "agent_jobs", "user_memory"];

function loadEnvLocal() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // no .env.local — rely on the ambient environment
  }
}

loadEnvLocal();

const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL;
const key = process.env.INSFORGE_API_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY;
if (!baseUrl || !key) {
  console.log("InsForge is not configured — nothing persisted, nothing to reset.");
  process.exit(0);
}

const apply = process.argv.includes("--yes");
const db = createClient({ baseUrl, anonKey: key }).database;

async function rows(table) {
  const { data, error } = await db.from(table).select("*");
  if (error) {
    console.log(`${table}: skipped (${error.message ?? JSON.stringify(error)})`);
    return null;
  }
  return data ?? [];
}

async function deleteBy(table, column, value) {
  const { error } = await db.from(table).delete().eq(column, value);
  if (error) console.log(`${table}: ${column}=${value} failed — ${error.message ?? JSON.stringify(error)}`);
  return !error;
}

for (const table of RUN_DATA_TABLES) {
  const data = await rows(table);
  if (!data) continue;
  if (!apply) {
    console.log(`${table}: all ${data.length} row(s) would be deleted`);
    continue;
  }
  let deleted = 0;
  for (const id of new Set(data.map((r) => r.workspace_id))) {
    if (await deleteBy(table, "workspace_id", id)) deleted++;
  }
  console.log(`${table}: cleared ${deleted} workspace(s), ${data.length} row(s)`);
}

for (const table of ["ad_users", "ad_accounts"]) {
  const data = await rows(table);
  if (!data) continue;
  const doomed = data.filter(
    (r) => String(r.email ?? "").toLowerCase() !== KEEP_EMAIL || r.workspace_id !== KEEP_WORKSPACE,
  );
  if (!apply) {
    console.log(`${table}: ${doomed.length} of ${data.length} row(s) would be deleted`);
    continue;
  }
  let deleted = 0;
  for (const row of doomed) {
    const { error } = await db
      .from(table)
      .delete()
      .eq("workspace_id", row.workspace_id)
      .eq("email", row.email);
    if (error) console.log(`${table}: ${row.email} failed — ${error.message ?? JSON.stringify(error)}`);
    else deleted++;
  }
  console.log(`${table}: deleted ${deleted} row(s), kept ${data.length - doomed.length}`);
}

// Groups accumulate a duplicate row per seed run. Collapse to the two the app
// actually reads, with the kept account as the only member.
{
  const data = await rows("ad_groups");
  if (data) {
    if (!apply) {
      console.log(`ad_groups: ${data.length} row(s) would be replaced by 2 (members: ${KEEP_EMAIL})`);
    } else {
      for (const id of new Set(data.map((r) => r.workspace_id))) await deleteBy("ad_groups", "workspace_id", id);
      const seed = [
        { id: "everyone", name: "Everyone", description: "All employees" },
        {
          id: "it-staff",
          name: "IT Staff",
          description: "IT operations & support — can approve agent plans",
        },
      ].map((g) => ({ ...g, workspace_id: KEEP_WORKSPACE, members: [KEEP_EMAIL] }));
      const { error } = await db.from("ad_groups").insert(seed);
      if (error) console.log(`ad_groups: INSERT failed — ${error.message ?? JSON.stringify(error)}`);
      else console.log(`ad_groups: replaced ${data.length} row(s) with 2`);
    }
  }
}

{
  const data = await rows("workspaces");
  if (data) {
    const doomed = data.filter((w) => w.id !== KEEP_WORKSPACE);
    if (!apply) {
      console.log(`workspaces: ${doomed.length} of ${data.length} would be deleted (keeping ${KEEP_WORKSPACE})`);
    } else {
      let deleted = 0;
      for (const w of doomed) if (await deleteBy("workspaces", "id", w.id)) deleted++;
      console.log(`workspaces: deleted ${deleted} row(s), kept ${data.length - doomed.length}`);
    }
  }
}

console.log(apply ? "\nDone. Restart the app." : "\nDry run. Re-run with --yes to delete.");
