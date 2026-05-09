ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slack_team_name TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slack_access_token TEXT;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS slack_connected_at BIGINT;
