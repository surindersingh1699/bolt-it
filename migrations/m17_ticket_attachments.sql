-- Screenshots the reporter attached to a ticket.
--
-- Stored as JSONB rather than a join table on purpose: an attachment has no
-- life of its own. It is read once, by the strategist, on its first look at the
-- ticket it belongs to, and it is never queried across tickets.
--
-- The bytes are NOT here. They live in the private `ticket-attachments` storage
-- bucket; this column holds only the key, the public-form URL, and enough
-- metadata to decide whether a vision model can read it. That matters because
-- /api/state polls every 600ms and returns whole tickets — a base64 image in
-- this column would be shipped to the browser twice a second.
alter table tickets
  add column if not exists attachments jsonb not null default '[]'::jsonb;
