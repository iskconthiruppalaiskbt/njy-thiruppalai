-- Migration 0012 - Coord read/write access to Member Details
--
-- Plan 4 adds the Members tab to the coordinator's nav (see 0011).
-- Coordinators land on #/member/:id when they tap "Edit" on any row
-- from that tab, but the underlying endpoints (GET/POST /api/member/:id)
-- are gated by `member_details_full` which shipped with only hk_leader
-- in its allowed_roles list — coords hit 403 forbidden:member_details_full.
--
-- Widening this single gate is the simplest path: there is no
-- `member_details_basic` gate today, and the Member Details form does
-- not expose HK-only admin fields separately, so gating "basic" vs
-- "full" would require a new UI slice. Coord's Members tab is already
-- scoped to their own Sangha at the list level (members_tab defaults
-- in 0011), so widening the gate does not leak members they shouldn't
-- see — the search endpoints stay role-scoped elsewhere.

UPDATE feature_gates
   SET allowed_roles = 'hk_leader,njy_leader,njy_coordinator',
       updated_at    = datetime('now')
 WHERE feature_key = 'member_details_full';
