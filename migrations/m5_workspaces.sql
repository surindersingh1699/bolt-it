CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  slack_team_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

ALTER TABLE tickets     ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'acme.test';
ALTER TABLE runbooks    ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'acme.test';
ALTER TABLE ad_users    ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'acme.test';
ALTER TABLE ad_groups   ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'acme.test';
ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'acme.test';

CREATE INDEX IF NOT EXISTS tickets_workspace_idx    ON tickets(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runbooks_workspace_idx   ON runbooks(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS ad_users_workspace_idx   ON ad_users(workspace_id, email);
CREATE INDEX IF NOT EXISTS ad_groups_workspace_idx  ON ad_groups(workspace_id);
CREATE INDEX IF NOT EXISTS ad_accounts_workspace_idx ON ad_accounts(workspace_id, email);

INSERT INTO workspaces (id, display_name, is_demo, created_at, updated_at)
VALUES ('acme.test', 'Acme Corp', false, 1778355000000, 1778355000000)
ON CONFLICT (id) DO NOTHING;
