-- M15: incident memory — cross-user history keyed by problem class.
--
-- user_memory answers "what do we know about this person". This answers "what
-- do we know about this problem". A printer fault is a printer fault whoever
-- files it, and the capability that actually fixed the last one is the single
-- most useful thing the planner can be told.
--
-- One row per ticket, written once at the end. `resolved_by` holds only the
-- capability that moved the machine, per before/after device evidence — the
-- success rates computed from this table are therefore grounded in what the
-- hardware did, not in any model's estimate of itself.
--
-- `category` is assigned by classifyIncident() in src/lib/incidents.ts, a pure
-- function of the ticket text. Retrieval is an equality match on it: no vector
-- index, no embedding call, and an explainable answer to "why did you try that".

CREATE TABLE IF NOT EXISTS incident_memory (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  category TEXT NOT NULL,
  symptom TEXT NOT NULL,
  tier INTEGER NOT NULL,
  capabilities_used JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolved_by TEXT,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  failure_kind TEXT,
  created_at BIGINT NOT NULL
);

-- The read path is always (workspace, category) newest-first.
CREATE INDEX IF NOT EXISTS incident_memory_lookup_idx
  ON incident_memory(workspace_id, category, created_at DESC);

ALTER TABLE incident_memory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON incident_memory FROM anon, authenticated;
