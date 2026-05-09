import { UserContext } from "../types";

const MOCK_USERS: Record<string, UserContext> = {
  "alex@acme.test": {
    email: "alex@acme.test",
    name: "Alex Reyes",
    team: "design",
    recentApps: ["figma", "notion", "slack"],
  },
  "priya@acme.test": {
    email: "priya@acme.test",
    name: "Priya Shah",
    team: "engineering",
    recentApps: ["github", "linear", "datadog", "vpn"],
  },
  "jordan@acme.test": {
    email: "jordan@acme.test",
    name: "Jordan Lee",
    team: "sales",
    recentApps: ["salesforce", "outreach", "slack"],
  },
};

export async function getUserContext(email: string): Promise<UserContext | null> {
  if (process.env.HYPERSPELL_API_KEY) {
    const res = await fetch(`https://api.hyperspell.com/v1/users/${encodeURIComponent(email)}/context`, {
      headers: { Authorization: `Bearer ${process.env.HYPERSPELL_API_KEY}` },
    }).catch(() => null);
    if (res?.ok) return res.json();
  }
  return MOCK_USERS[email.toLowerCase()] ?? null;
}
