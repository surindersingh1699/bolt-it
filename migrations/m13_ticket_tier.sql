-- Escalation depth the ticket reached. 1 = service desk, 2 = systems engineer,
-- 3 = escalation engineer. Null on tickets created before tiering existed.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS tier SMALLINT;
