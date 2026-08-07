import { NextResponse } from "next/server";
import { redactDeep, redactSecrets } from "@/lib/redact";
import { storeAgentScreenshot } from "@/lib/attachments";
import { z } from "zod";
import { getAgentJob, updateAgentJob, updateStep } from "@/lib/data";
import { deriveJobStatus, formatProofLines } from "@/lib/evidence";
import { ExecutionEnvelope } from "@/lib/types";

export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const expected = process.env.LOCAL_AGENT_TOKEN;
  if (!expected) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${expected}`;
}

interface Params {
  params: Promise<{ id: string }>;
}

const probeSchema = z.object({
  label: z.string().max(120),
  command: z.string().max(1000),
  exitCode: z.number(),
  facts: z.record(z.string().max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])),
});

const commandSchema = z.object({
  argv: z.array(z.string().max(2000)).max(16),
  exitCode: z.number(),
  stdout: z.string().max(4000),
  stderr: z.string().max(2000),
  durationMs: z.number(),
});

const envelopeSchema = z.object({
  jobId: z.string().max(64),
  command: z.string().max(500),
  host: z.string().max(253),
  os: z.string().max(200),
  agentVersion: z.string().max(64),
  startedAt: z.number(),
  finishedAt: z.number(),
  durationMs: z.number(),
  expectsChange: z.boolean(),
  simulated: z.boolean().optional(),
  probes: z.array(probeSchema).max(12),
  commands: z.array(commandSchema).max(24),
  effect: z.object({
    changed: z.boolean(),
    diff: z
      .array(
        z.object({
          field: z.string().max(64),
          before: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
          after: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
        }),
      )
      .max(32),
    summary: z.string().max(1000),
  }),
  journalPath: z.string().max(500).optional(),
  // These two were MISSING, and zod strips unknown keys by default — so the
  // agent wrote the undo command onto the machine, put it on the envelope, and
  // the schema silently dropped it in transit. `formatProofLines` has rendered
  // both since it was written and never once had them to render.
  changeRecordPath: z.string().max(500).optional(),
  revertCommand: z.string().max(1000).optional(),
  // The rollback transaction's own result.
  rolledBack: z.boolean().optional(),
  rollbackOk: z.boolean().optional(),
  rollbackError: z.string().max(1000).optional(),
  simulatedDependencyUnmet: z.array(z.string().max(64)).max(16).optional(),
});

const bodySchema = z.object({
  ok: z.boolean().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  agentHost: z.string().max(253).optional(),
  agentOs: z.string().max(200).optional(),
  envelope: envelopeSchema.optional(),
  /**
   * The agent's own classification of a failure.
   *
   * The device knows things the server cannot infer. A screenshot that did not
   * happen is either "the employee declined" (policy_block) or "there was
   * nobody to ask, because the helper never reached their session"
   * (dependency_unavailable). Those have different owners, and collapsing them
   * would make a broken Session 0 helper look exactly like a person saying no —
   * on every screenshot, forever, with nobody ever finding it.
   */
  failureKind: z.enum(["policy_block", "dependency_unavailable", "execution"]).optional(),
  /** Base64 JPEG, uploaded to the private bucket and never persisted inline. */
  screenshotBase64: z.string().max(12_000_000).optional(),
  consent: z
    .object({
      promptedAt: z.number(),
      response: z.enum(["allow", "deny", "timeout"]),
    })
    .optional(),
});

export async function POST(req: Request, { params }: Params) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const raw = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const body = parsed.data;

  const job = await getAgentJob(id);
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Redacted a SECOND time, here, after parsing and before anything is
  // persisted. The agent already redacted on the way out; doing it again is what
  // makes the guarantee survive an agent that is older, modified, or simply
  // buggy. The client is not the only thing between a credential and the
  // database.
  const envelope = (body.envelope ? redactDeep(body.envelope) : undefined) as
    | ExecutionEnvelope
    | undefined;
  // The device's own before/after evidence decides the verdict — not the fact
  // that the agent finished talking.
  const status = deriveJobStatus(body.ok !== false, envelope);
  const completedAt = Date.now();
  const patch = {
    status,
    completedAt,
    output: redactSecrets(body.output ?? "").slice(0, 8000),
    error: body.error ? redactSecrets(body.error).slice(0, 2000) : undefined,
    envelope,
    effectChanged: envelope?.effect.changed,
    effectSummary: envelope?.effect.summary,
  };
  await updateAgentJob(id, patch);

  // A screenshot goes to the same PRIVATE bucket as an employee's own
  // attachment, never inline into the job output or the device journal — a
  // base64 image in a log line is both useless to read and impossible to delete
  // later.
  const extraLog: string[] = [];
  if (body.screenshotBase64) {
    const stored = await storeAgentScreenshot(job.ticketId, body.screenshotBase64).catch(() => null);
    extraLog.push(
      stored
        ? `[Screenshot] Captured with the employee's consent and stored privately (${Math.round(stored.bytes / 1024)} KB)`
        : `[Screenshot] Captured but could not be stored — not attaching`,
    );
  }
  if (body.consent) {
    extraLog.push(
      `[Consent] The employee was asked on their own machine at ` +
        `${new Date(body.consent.promptedAt).toISOString()} and answered "${body.consent.response}"`,
    );
  }

  if (job.stepId) {
    await updateStep(job.ticketId, job.stepId, {
      log: [...formatProofLines({ ...job, ...patch }), ...extraLog],
      ...(body.failureKind && body.ok === false
        ? { failure: { kind: body.failureKind, detail: redactSecrets(body.error ?? "") || "device reported a failure" } }
        : {}),
    });
  }

  return NextResponse.json({ ok: true, id, status });
}
