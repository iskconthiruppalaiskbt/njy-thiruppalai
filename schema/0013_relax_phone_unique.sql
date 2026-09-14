-- Relax the phone-unique constraint so family members sharing a phone can
-- coexist as separate people records.
--
-- Prior constraint: UNIQUE(phone) WHERE active=1  (from 0001_init.sql)
-- New constraint:   UNIQUE(phone, legal_name) WHERE active=1
--
-- Rationale: Sri Krsna-Janmastami 2026 coupon distribution intentionally
-- collects family clusters (mother + son + daughter) under one shared
-- mobile number. Each is a distinct chanter with a distinct name; the
-- old index dropped 1,843 of them at import time via INSERT OR IGNORE.

DROP INDEX IF EXISTS people_phone_active;

CREATE UNIQUE INDEX IF NOT EXISTS people_phone_name_active
  ON people(phone, legal_name) WHERE active = 1;
