-- The three job columns that were never there.
--
-- `enqueueAgentJob` has always built a job carrying the device it is bound to
-- and the binaries a technician approved for its ticket. Neither survived the
-- trip through InsForge, because neither had a column — so both features worked
-- exactly as long as the in-memory fallback was the store, and silently did
-- nothing the moment the real one was.
--
--   device_id / device_hostname — per-device routing. Without them every job
--     comes back unbound, and "hand this job only to the machine it names" has
--     nothing to compare against.
--   granted_binaries — the read-only diagnostics approved for THIS ticket.
--     Without them the agent is handed an approved job with no approval on it,
--     refuses the read again, and the graph parks on the same approval: a
--     technician clicking Approve into a loop, which is what T-4935 did four
--     times before it was stopped by hand.
--
-- JSONB rather than TEXT[] for granted_binaries: the row mapper writes the
-- array as-is and every other array-shaped column in this schema is JSONB.

ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS device_hostname TEXT;
ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS granted_binaries JSONB;

-- The jobs route reads queued work for one device on every poll, every 3s, per
-- machine. That is the hottest query in the system.
CREATE INDEX IF NOT EXISTS agent_jobs_device_queue_idx
  ON agent_jobs(workspace_id, status, device_id, created_at);
