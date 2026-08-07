// Add one directory account. There is no signup route, so this is how a person
// gets into the workspace — the employee sitting at the VM, for instance, who
// needs a non-IT-staff login to see the employee view rather than the inbox.
//
//   node scripts/add-user.mjs --email sabys@acme.test --name "Sabys" --password "vm"
//   node scripts/add-user.mjs --email me@acme.test --name "Me" --it-staff
//
// Omit --password and one is generated and printed. Re-running for an existing
// email replaces that account's password.

import { readFileSync } from "node:fs";
import { createClient } from "@insforge/sdk";

function loadEnvLocal() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // rely on the ambient environment
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

// Same scheme as src/lib/password.ts — sha256(salt ‖ password), "<salt>$<hash>".
async function hashPassword(plain) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  const bytes = new Uint8Array([...salt, ...new TextEncoder().encode(plain)]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `${hex(salt)}$${hex(hash)}`;
}

loadEnvLocal();

const email = (arg("email") ?? "").toLowerCase();
const name = arg("name");
if (!email || !name) {
  console.error('Usage: node scripts/add-user.mjs --email a@b.test --name "A B" [--password x] [--it-staff] [--team T] [--title T]');
  process.exit(1);
}

const isITStaff = process.argv.includes("--it-staff");
const password = arg("password") ?? `pw-${Math.random().toString(36).slice(2, 10)}`;
const workspaceId = process.env.WORKSPACE_ID || "acme.test";
const team = arg("team", isITStaff ? "IT" : "Staff");
const title = arg("title", isITStaff ? "IT support" : "Employee");

const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL;
const key = process.env.INSFORGE_API_KEY || process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY;
if (!baseUrl || !key) {
  console.error("InsForge is not configured — nothing to write to.");
  process.exit(1);
}

const db = createClient({ baseUrl, anonKey: key }).database;
const now = Date.now();
const groups = isITStaff ? ["everyone", "it-staff"] : ["everyone"];

// Replace rather than duplicate: re-running this is how you reset a password.
for (const table of ["ad_users", "ad_accounts"]) {
  await db.from(table).delete().eq("workspace_id", workspaceId).eq("email", email);
}

const u = await db.from("ad_users").insert([
  {
    email,
    workspace_id: workspaceId,
    name,
    password_hash: await hashPassword(password),
    team,
    title,
    groups,
    is_it_staff: isITStaff,
    created_at: now,
  },
]);
if (u.error) {
  console.error("ad_users insert failed:", u.error.message ?? JSON.stringify(u.error));
  process.exit(1);
}

const a = await db.from("ad_accounts").insert([
  {
    email,
    workspace_id: workspaceId,
    status: "active",
    failed_login_count: 0,
    password_changed_at: now,
    password_expires_at: now + 365 * 24 * 3600 * 1000,
  },
]);
if (a.error) {
  console.error("ad_accounts insert failed:", a.error.message ?? JSON.stringify(a.error));
  process.exit(1);
}

// Group membership is what the directory reads for "who is IT"; keep it true.
const existing = await db.from("ad_groups").select("*").eq("workspace_id", workspaceId);
for (const g of existing.data ?? []) {
  if (!groups.includes(g.id)) continue;
  const members = Array.isArray(g.members) ? g.members : [];
  if (members.includes(email)) continue;
  await db
    .from("ad_groups")
    .update({ members: [...members, email] })
    .eq("workspace_id", workspaceId)
    .eq("id", g.id);
}

console.log(`Created ${name} <${email}>${isITStaff ? " (IT staff)" : ""}`);
console.log(`Password: ${password}`);
