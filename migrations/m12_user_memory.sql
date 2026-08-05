-- M12: per-user memory (replaces the Hyperspell integration).
--
-- facts   — keyed, upserted in place: nickname, office, timezone, device, …
-- episodes— one row per ticket, append-only: what we last helped them with.
--
-- Deliberately one small table in the same database as everything else, so
-- there is no second memory system to keep in sync.

CREATE TABLE IF NOT EXISTS user_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  kind TEXT NOT NULL,
  fact_key TEXT,
  value TEXT NOT NULL,
  ticket_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS user_memory_lookup_idx
  ON user_memory(workspace_id, user_email, kind, updated_at DESC);

ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_memory FROM anon, authenticated;
