-- M11: proof-of-effect for device jobs.
--
-- The agent now returns an execution envelope (before probe, commands with
-- real exit codes, after probe, computed diff) instead of a prose blob. The
-- envelope is what lets the server tell "the fix landed" apart from "the agent
-- finished talking", and it is the record we study runs from later.

ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS envelope JSONB;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS effect_changed BOOLEAN;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS effect_summary TEXT;

-- Jobs that ran but moved nothing on the device are the interesting ones.
CREATE INDEX IF NOT EXISTS agent_jobs_effect_idx
  ON agent_jobs(workspace_id, effect_changed, completed_at DESC);
