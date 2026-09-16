-- 0018_people_wa_status.sql
--
-- Track whether a person is reachable on WhatsApp. NULL = unknown
-- (default for existing rows and any new import), 0 = confirmed NOT
-- on WhatsApp (SMS fallback + Invite-to-WA nudge), 1 = confirmed on
-- WhatsApp. Coord/leader/HK flip this from the roll UI when a WA
-- message bounces or a member confirms via voice / SMS.
--
-- The broadcast queue excludes wa_status = 0 members from the WA
-- recipient list so a coord doesn't tap Send on a number they
-- already know won't receive it.
ALTER TABLE people ADD COLUMN wa_status INTEGER;   -- NULL / 0 / 1
CREATE INDEX IF NOT EXISTS people_wa_status_idx ON people(wa_status);
