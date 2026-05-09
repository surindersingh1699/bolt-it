import { createClient } from "@insforge/sdk";

type InsforgeClient = ReturnType<typeof createClient>;

let client: InsforgeClient | null = null;

/**
 * Returns an InsForge client.
 *
 * Server-side (typeof window === "undefined"): if `INSFORGE_API_KEY` is set,
 * use it — that's the privileged service-role key, required for tables that
 * have had `anon` revoked (post-M7 RLS lockdown).
 *
 * Otherwise (client-side, or no API key): fall back to the public anon key.
 */
export function getInsforge(): InsforgeClient | null {
  if (client) return client;
  const baseUrl = process.env.NEXT_PUBLIC_INSFORGE_URL;
  const anonKey = process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY;
  if (!baseUrl || !anonKey) return null;
  const apiKey = typeof window === "undefined" ? process.env.INSFORGE_API_KEY : undefined;
  const bearer = apiKey ?? anonKey;
  client = createClient({ baseUrl, anonKey: bearer });
  return client;
}

export const isInsforgeEnabled = (): boolean =>
  Boolean(process.env.NEXT_PUBLIC_INSFORGE_URL && process.env.NEXT_PUBLIC_INSFORGE_ANON_KEY);
