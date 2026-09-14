-- Per-user WhatsApp group. Each NJY Coordinator (or NJY Leader / HK
-- Leader) can paste ONE group invite link + name. Used by the app to
-- offer "send invite to selected chanters" and "post to group" actions.
--
-- The link stored here is the raw WhatsApp invite URL (chat.whatsapp.com/xxx)
-- OR a temple-branded short URL our app can track click-throughs on later.
--
-- Kept nullable — coords who don't use a group leave both fields blank.

ALTER TABLE users ADD COLUMN wa_group_link TEXT;
ALTER TABLE users ADD COLUMN wa_group_name TEXT;
