-- Persist the fleet.
--
-- Devices were in-memory only, and no `agent_devices` table existed at all, so
-- `listDevices` returned whatever the current process happened to hold — empty
-- on a fresh server, and never the machine that enrolled against a different
-- instance. That is why `observe` reported "no registered device for the
-- reporter" while a VM sat heartbeating: a live agent and a registered device
-- were two unrelated facts, and only the second, unpersisted one gated
-- observation.
--
-- Columns mirror the Device type in src/lib/types.ts. token_hash is the SHA-256
-- of the device's own agent token (the token itself is shown once at enrollment
-- and never stored); revoked_at disables a machine without deleting its history.

CREATE TABLE IF NOT EXISTS agent_devices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  owner_email TEXT,
  source TEXT NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  agent_version TEXT,
  claimed_at BIGINT,
  claimed_by TEXT,
  token_hash TEXT,
  enrolled_at BIGINT,
  revoked_at BIGINT
);

-- `observe` finds a device by (workspace, owner); enrollment and heartbeat upsert
-- by (workspace, hostname). Both lookups get an index.
CREATE INDEX IF NOT EXISTS agent_devices_workspace_owner_idx
  ON agent_devices(workspace_id, owner_email);
CREATE INDEX IF NOT EXISTS agent_devices_workspace_hostname_idx
  ON agent_devices(workspace_id, hostname);

ALTER TABLE agent_devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agent_devices FROM anon, authenticated;
