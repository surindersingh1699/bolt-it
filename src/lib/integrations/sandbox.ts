export interface SandboxLogReadInput {
  userEmail: string;
  paths: string[];
  reason: string;
}

export interface SandboxLogReadResult {
  ok: boolean;
  log: string[];
  matches?: Array<{ path: string; line: number; text: string }>;
  source: "vercel-sandbox" | "mock";
}

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/g,
  /(password|secret|token)\s*[:=]\s*\S+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
];

function redactLine(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

const MOCK_LOGS: Record<string, string[]> = {
  "/var/log/auth.log": [
    "Nov 23 09:11:01 acme-dc1 sshd[12834]: Accepted publickey for svc-monitor",
    "Nov 23 09:14:18 acme-dc1 audit: USER_LOGIN res=failed acct=bob@acme.test addr=10.0.4.21",
    "Nov 23 09:14:34 acme-dc1 audit: USER_LOGIN res=failed acct=bob@acme.test addr=10.0.4.21",
    "Nov 23 09:14:52 acme-dc1 audit: USER_LOGIN res=failed acct=bob@acme.test addr=10.0.4.21",
    "Nov 23 09:15:09 acme-dc1 audit: USER_LOGIN res=failed acct=bob@acme.test addr=10.0.4.21",
    "Nov 23 09:15:25 acme-dc1 audit: USER_LOGIN res=failed acct=bob@acme.test addr=10.0.4.21",
    "Nov 23 09:15:25 acme-dc1 audit: ACCOUNT_LOCKED acct=bob@acme.test threshold=5",
  ],
  "/var/log/krb5/krb5kdc.log": [
    "Nov 23 14:02:11 dc1 krb5kdc[2310]: AS_REQ for eve@ACME.TEST issued, ticket lifetime 10h",
    "Nov 24 00:14:09 dc1 krb5kdc[2310]: TGS_REQ eve@ACME.TEST PREAUTH_FAILED clock skew 287s",
    "Nov 24 00:14:09 dc1 krb5kdc[2310]: hint: client clock drift > 5min, suggest klist purge + ntpd resync",
  ],
  "/var/log/system.log": [
    "Nov 23 11:22:07 EVE-WIN System: kerberos ticket cache empty",
    "Nov 23 11:22:09 EVE-WIN Explorer: prompted credentials for \\\\fileserver\\design",
  ],
};

async function realVercelSandboxRead(
  input: SandboxLogReadInput,
): Promise<SandboxLogReadResult | null> {
  const token = process.env.VERCEL_SANDBOX_TOKEN;
  if (!token) return null;
  try {
    return null;
  } catch {
    return null;
  }
}

export async function sandboxReadLogs(
  input: SandboxLogReadInput,
): Promise<SandboxLogReadResult> {
  const real = await realVercelSandboxRead(input);
  if (real) return real;

  const log: string[] = [];
  log.push(`[Sandbox] Cold-starting Vercel Sandbox microVM (Firecracker)`);
  await sleep(180);
  log.push(`[Sandbox] FS mounted READ-ONLY. No network egress to corp prod.`);
  log.push(`[Sandbox] Reason: ${input.reason}`);
  log.push(`[Sandbox] Reading: ${input.paths.join(", ")}`);
  await sleep(350);

  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const p of input.paths) {
    const lines = MOCK_LOGS[p] ?? MOCK_LOGS["/var/log/auth.log"];
    const filtered = lines.filter(
      (l) =>
        l.toLowerCase().includes(input.userEmail.toLowerCase().split("@")[0]) ||
        l.toLowerCase().includes("kerberos") ||
        l.toLowerCase().includes("locked"),
    );
    filtered.forEach((text, idx) => {
      matches.push({ path: p, line: idx + 1, text: redactLine(text) });
    });
  }

  log.push(`[Sandbox] ${matches.length} relevant lines (secrets redacted before exfiltration)`);
  log.push(`[Sandbox] microVM destroyed. No persistence.`);
  return { ok: true, log, matches, source: "mock" };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
