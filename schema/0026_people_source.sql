-- 0026_people_source.sql
--
-- Where a member came from, so a bulk-loaded batch can be told apart
-- from the original data. NULL = original data / added in the app.
-- First use: 'visitors' — Pragalath Prabhu's daily temple visitors list
-- (04-11-2026), loaded for HG Murari Gaurahari Dasa's coordinators.
-- Shown as a "VISITOR" badge on roll and Members rows. No index: it is
-- only read off rows already being fetched, never filtered on in SQL.

ALTER TABLE people ADD COLUMN source TEXT;
