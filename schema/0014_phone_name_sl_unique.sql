-- Further relax uniqueness so every distinct SL coupon row imports as its
-- own chanter record, even when phone and legal_name match another row.
--
-- Prior (0013): UNIQUE(phone, legal_name) WHERE active=1
-- New:          UNIQUE(phone, legal_name, sl_no) WHERE active=1
--
-- Rationale: 216 source rows share both phone AND normalized name with
-- another row. These could be family members with the same name (rare
-- but possible: father-and-son sharing a phone AND both named "Krishna
-- Das"), or genuine duplicate entries. Treating sl_no as the tiebreaker
-- preserves the coupon distribution's authoritative row count while
-- still catching a same-coupon-number double-import.

DROP INDEX IF EXISTS people_phone_name_active;

CREATE UNIQUE INDEX IF NOT EXISTS people_phone_name_sl_active
  ON people(phone, legal_name, sl_no) WHERE active = 1;
