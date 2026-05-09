CREATE TABLE IF NOT EXISTS agent_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  step_id TEXT,
  kind TEXT NOT NULL,
  target_user_email TEXT NOT NULL,
  instructions TEXT NOT NULL,
  allowlisted_command TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  claimed_at BIGINT,
  completed_at BIGINT,
  output TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS agent_jobs_workspace_status_idx
  ON agent_jobs(workspace_id, status, created_at);

ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_jobs FROM anon, authenticated;
