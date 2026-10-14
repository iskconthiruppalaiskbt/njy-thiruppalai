-- Performance indexes to cut D1 row reads.
--
-- Cause: nearly every coord-scoped query filters by
-- people.assigned_to_user_id (peopleAssignedTo, countChantDaysForCoord,
-- countTouchesForCoord, peopleCountByCoord, followUpsCountByCoordOnDate,
-- membersConsistentByCoord, oneMonthDailyCountFor). Without an index on
-- that column, SQLite was doing a full scan of `people` per call, and
-- for the chant-days / touches joins it was often scanning the whole
-- date range of daily_chant_log / person_touch_log too.
--
-- With 300 coords × ~15 subqueries per Overall board hit × many hits
-- per day, this is what drove the Oct 2026 cycle to 180B rows read
-- (vs ~25B expected). Partial index excludes NULL assignments (pool
-- members), which keeps it small — only assigned rows are ever filtered
-- by assigned_to_user_id in the hot paths.

CREATE INDEX IF NOT EXISTS people_assigned_to_idx
  ON people(assigned_to_user_id)
  WHERE assigned_to_user_id IS NOT NULL;
