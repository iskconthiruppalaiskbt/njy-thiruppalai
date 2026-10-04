-- 0021_people_status_changed_at.sql
--
-- Timestamp recording WHEN the lifecycle status column was last changed.
-- Needed for the "Unreachable auto-return after 30 days" rule: an
-- Unreachable member whose status was set >30 days ago gets quietly
-- restored to the Unassigned Pool (status=NULL, assigned_to_user_id=NULL)
-- so Director can try reaching them via a different coord. Uninterested
-- stays permanent — only Unreachable auto-expires.
--
-- The existing `updated_at` column is unsuitable because ANY field edit
-- (phone, pincode, notes…) bumps it, which would reset the 30-day clock.
-- A dedicated column keeps the expiry rule honest.
ALTER TABLE people ADD COLUMN status_changed_at TEXT;
-- Partial index: only rows whose status actually matters for the sweep.
-- Keeps the index small and the daily cleanup query fast.
CREATE INDEX IF NOT EXISTS people_status_changed_at_idx
  ON people(status_changed_at)
  WHERE status IS NOT NULL;

-- One-shot data cleanup for ghost rows (pre-fix era): members marked
-- as blocked (dropped / unreachable / uninterested / not_interested)
-- that still carry an assigned_to_user_id because the status-change
-- handler back then didn't clear it. These were the source of the
-- "40/40 shown vs 36/40 real" count mismatch Director reported.
-- Also back-fill status_changed_at = updated_at for existing blocked
-- rows so the 30-day Unreachable sweep has a timestamp to work from
-- (approximate but close enough — the alternative is NULL which
-- makes the sweep skip them forever).
UPDATE people
SET assigned_to_user_id = NULL
WHERE assigned_to_user_id IS NOT NULL
  AND (not_interested = 1
       OR status IN ('dropped','unreachable','uninterested'));

UPDATE people
SET status_changed_at = updated_at
WHERE status IN ('dropped','unreachable','uninterested')
  AND status_changed_at IS NULL;
