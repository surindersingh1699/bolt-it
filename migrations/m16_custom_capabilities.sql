-- M16: custom capabilities — fixes the agent asked for, a human ratified, and
-- the system now owns.
--
-- The escalation engineer emits a capability_request when the fix it needs is
-- not in its list: the exact command, the read-only probes that would prove the
-- fix landed, the files it touches, and how to undo it. That spec used to die
-- in the handoff artifact. Now it is registered here after one approval (or
-- immediately under AUTONOMY=full), executed in the same ticket through the
-- generic run_change handler on the device agent, and offered to every later
-- ticket in the workspace as a first-class capability.
--
-- The probes are the load-bearing part. A registered fix runs probe → act →
-- probe like every other device action, so "it worked" is always the machine's
-- own before/after diff — a capability whose effect cannot be observed cannot
-- be registered.
--
-- The safety reviewer still rules on every USE. Registration widens what can be
-- proposed, never what runs unreviewed.

CREATE TABLE IF NOT EXISTS custom_capabilities (
  -- "<workspace>:<name>" so a name is unique per workspace.
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  why TEXT NOT NULL,
  -- Exact argv the device agent will run, as a JSON array. No shell anywhere.
  command JSONB NOT NULL,
  -- Read-only probe commands (argv arrays) run before and after the fix.
  probes JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Files the fix touches; the agent backs each up before acting.
  files_touched JSONB NOT NULL DEFAULT '[]'::jsonb,
  reversible TEXT NOT NULL DEFAULT '',
  risk TEXT NOT NULL DEFAULT 'high',
  expected_effect TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL,
  approved_at BIGINT NOT NULL,
  created_from_ticket TEXT NOT NULL,
  times_used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS custom_capabilities_ws_idx
  ON custom_capabilities(workspace_id, name);

ALTER TABLE custom_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON custom_capabilities FROM anon, authenticated;
