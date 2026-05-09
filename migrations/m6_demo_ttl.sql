ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_used_at BIGINT;
UPDATE workspaces SET last_used_at = updated_at WHERE last_used_at IS NULL;
CREATE INDEX IF NOT EXISTS workspaces_demo_last_used_idx
  ON workspaces(is_demo, last_used_at)
  WHERE is_demo = true;
