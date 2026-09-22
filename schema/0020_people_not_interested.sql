-- 0020_people_not_interested.sql
--
-- Flag a person as "not interested". Set from Member Details by a
-- Leader / Director when a chanter tells the coord they don't want
-- to be part of NJY. The row STAYS in the people table (history +
-- audit) but every assignment path filters them out:
--   • coord rolls (peopleAssignedTo) — they vanish from the coord's list
--   • Members-tab Unassigned Pool — never surfaced there
--   • Auto-fill picker (client-side) — never picked
--   • Bulk-assign — never picked
-- Marking also clears assigned_to_user_id so no coord is on the hook.
-- Un-marking (not_interested=0) restores them to the Unassigned Pool.
ALTER TABLE people ADD COLUMN not_interested INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS people_not_interested_idx ON people(not_interested);
