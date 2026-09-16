-- 0019 — duplicate_requests
--
-- Coord flags a member as a duplicate of another member (by SL). The
-- Director reviews the queue and either merges (deactivates one row,
-- keeps the other) or rejects the request. Leader sees a read-only
-- notice on their Team page but has no gating action.
--
-- Lifecycle:
--   pending  — freshly flagged by a coord, waiting for the Director
--   merged   — Director picked a winner; the OTHER row got active=0
--   rejected — Director closed as invalid
--
-- flagged_person_id       — the row the coord thinks is the duplicate
-- duplicate_of_person_id  — the OTHER row (may be NULL if only an SL
--                           number was captured and the server could not
--                           resolve it at submission time)
-- duplicate_of_sl         — raw SL text the coord typed, kept for audit
--                           and for the queue display even if the person
--                           lookup was fuzzy or failed
-- merged_kept_id          — populated on merge: the row the Director kept
-- merged_deactivated_id   — populated on merge: the row set active=0
CREATE TABLE IF NOT EXISTS duplicate_requests (
  id                     TEXT PRIMARY KEY,
  flagged_person_id      TEXT NOT NULL REFERENCES people(id),
  duplicate_of_person_id TEXT REFERENCES people(id),
  duplicate_of_sl        TEXT,
  note                   TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending',
  requested_by           TEXT NOT NULL REFERENCES users(id),
  reviewed_by            TEXT REFERENCES users(id),
  resolution_note        TEXT,
  merged_kept_id         TEXT REFERENCES people(id),
  merged_deactivated_id  TEXT REFERENCES people(id),
  created_at             TEXT NOT NULL,
  updated_at             TEXT
);
CREATE INDEX IF NOT EXISTS dup_req_status_idx    ON duplicate_requests(status);
CREATE INDEX IF NOT EXISTS dup_req_flagged_idx   ON duplicate_requests(flagged_person_id);
CREATE INDEX IF NOT EXISTS dup_req_requester_idx ON duplicate_requests(requested_by);
