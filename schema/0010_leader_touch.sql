-- Migration 0010 — Leader Touch actions ledger
--
-- Ledger of per-leader "Leader Touch" points feeding the 3-bucket
-- prorated leader leaderboard (60% Team Performance / 25% Team Coverage
-- / 15% Leader Touch). Each row is one atomic touch — a broadcast
-- fired, a WA group updated, a coord contacted, an event attended, or
-- a coord onboarded. Points and the exact action are captured so the
-- breakdown can be shown in the UI.
--
-- Uniqueness rules encoded via a composite index on
-- (leader_user_id, action_key, day_iso, ref_id):
--   • ref_id defaults to '' so first-of-day actions (broadcast,
--     wa_group_saved) collapse to a single row per day.
--   • per-coord actions (contact_coord) set ref_id to the coord's id,
--     so up to one row per (leader, coord, day).
--   • per-event actions (event_attended) set ref_id to the event id,
--     so up to one row per (leader, event).
--
-- Point totals per action key are enforced in application code (see
-- lib/handlers.js), so a schema-only look at this table can't tell you
-- the rate — but the `points` column preserves what was awarded at
-- write time, so retroactive rate changes don't rewrite history.

CREATE TABLE IF NOT EXISTS leader_touch_actions (
  id             TEXT PRIMARY KEY,
  leader_user_id TEXT NOT NULL,
  action_key     TEXT NOT NULL,
  awarded_at     TEXT NOT NULL,
  day_iso        TEXT NOT NULL,
  points         INTEGER NOT NULL DEFAULT 0,
  ref_id         TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leader_touch_dedup
  ON leader_touch_actions(leader_user_id, action_key, day_iso, ref_id);

CREATE INDEX IF NOT EXISTS idx_leader_touch_by_leader_day
  ON leader_touch_actions(leader_user_id, day_iso);
