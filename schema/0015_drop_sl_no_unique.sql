-- Drop the sl_no unique constraint from migration 0005.
--
-- Reason: sl_no represents a coupon number, not a per-person identifier.
-- Family clusters (mother + son + daughter on one coupon) legitimately
-- share one sl_no. The unique index was blocking 216 valid chanter rows
-- at import time.
--
-- Downstream effect: SL-based search may return multiple people for a
-- shared coupon. The Members-tab UI already handles multi-row results.

DROP INDEX IF EXISTS people_sl_no_unique;
