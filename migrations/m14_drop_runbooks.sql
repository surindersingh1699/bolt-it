-- M14: drop the runbook library.
--
-- Runbooks were the org-wide knowledge store: seeded resolutions plus one
-- auto-extracted entry per resolved ticket, dumped into the planner's prompt.
-- They are gone. What the agent knows now is per-employee `user_memory`
-- (facts + episodes, see m12) and, at deeper tiers, external lookup via
-- kb.web_search.
--
-- Also drops tickets.runbook_source_id, which pointed at the cited runbook.

ALTER TABLE tickets DROP COLUMN IF EXISTS runbook_source_id;

DROP TABLE IF EXISTS runbooks;
