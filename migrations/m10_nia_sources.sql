ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS nia_sources JSONB DEFAULT '[]'::jsonb;
