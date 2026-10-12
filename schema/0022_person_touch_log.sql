-- 0022_person_touch_log.sql
--
-- Per-day touch log for cumulative Follow-Ups scoring. Before this
-- table existed, the overall board counted follow-ups by scanning
-- the current roll for people with last_marked_at >= PHASE1_START —
-- which only counts each person ONCE (max = 40 × 5 = 200 pts for a
-- full roll). Directors reported this capped at 200 across every
-- top coord even after months of outreach.
--
-- Now every touch (via /api/roll/mark bead-cycle or
-- /api/roll/mark-contacted broadcast-sent) upserts a row keyed on
-- (person_id, touch_date). The daily board counts rows where
-- touch_date = today; the overall board counts rows across the
-- whole phase. Multiple touches on the same person on the same day
-- still count as one (the upsert enforces that), but touches on
-- distinct days accumulate.
CREATE TABLE IF NOT EXISTS person_touch_log (
  person_id    TEXT NOT NULL REFERENCES people(id),
  touch_date   TEXT NOT NULL,                      -- YYYY-MM-DD
  touched_by   TEXT REFERENCES users(id),          -- coord/leader/HK who marked
  created_at   TEXT NOT NULL,
  PRIMARY KEY (person_id, touch_date)
);
-- Fast per-coord-per-day lookup joins through people.assigned_to_user_id.
CREATE INDEX IF NOT EXISTS person_touch_log_date_idx
  ON person_touch_log(touch_date);

-- One-shot backfill from last_marked_at so the overall board doesn't
-- collapse to zero on first deploy. Each person with any last_marked_at
-- in Phase 1+ gets ONE log row at that date. The future accumulates
-- properly from here; the backfill is just the floor.
INSERT OR IGNORE INTO person_touch_log (person_id, touch_date, touched_by, created_at)
SELECT id,
       substr(last_marked_at, 1, 10) AS touch_date,
       last_marked_by,
       datetime('now')
FROM people
WHERE last_marked_at IS NOT NULL
  AND substr(last_marked_at, 1, 10) >= '2026-08-18';
