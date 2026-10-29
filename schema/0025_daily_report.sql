-- Director's on-demand Daily Report.
--
-- daily_report: one saved copy per PAST day, so re-opening a day reads
--   one row instead of recomputing. Today is never saved (still
--   changing). A chant backfill for a past day deletes that day's row
--   (see /api/roll/chant) so the next view recomputes.
-- report_log: one row per Generate click — who, which day, and the
--   rows D1 actually read — so a spike in row reads can be traced.
--
-- The two indexes let the report filter leader actions and status
-- changes by date instead of scanning those tables.
--
-- Apply (migration tracking on prod is broken past 0007, see HANDOFF §14b):
--   npx wrangler d1 execute njy --remote --file schema/0025_daily_report.sql

CREATE TABLE IF NOT EXISTS daily_report (
  day_iso       TEXT PRIMARY KEY,                 -- YYYY-MM-DD (IST)
  payload       TEXT NOT NULL,                    -- JSON
  rows_read     INTEGER NOT NULL DEFAULT 0,
  generated_at  TEXT NOT NULL,
  generated_by  TEXT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS report_log (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  day_iso       TEXT NOT NULL,                    -- the day the report was for
  requested_at  TEXT NOT NULL,                    -- UTC ISO
  rows_read     INTEGER NOT NULL DEFAULT 0,
  from_cache    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS report_log_requested_idx
  ON report_log(requested_at);

CREATE INDEX IF NOT EXISTS leader_touch_day_idx
  ON leader_touch_actions(day_iso);
CREATE INDEX IF NOT EXISTS person_stage_log_changed_idx
  ON person_stage_log(changed_at);
