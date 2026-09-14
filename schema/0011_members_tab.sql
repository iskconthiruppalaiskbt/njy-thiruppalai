-- Migration 0011 - Members tab feature gate
--
-- Adds the `members_tab` feature gate that controls visibility of the
-- new top-level "Members" nav tab (a searchable list for editing
-- member details). Defaults to hk_leader,njy_leader,njy_coordinator
-- so leaders drill into their coords' members and coords manage their
-- own Sangha.

INSERT OR IGNORE INTO feature_gates (feature_key, allowed_roles, description, updated_at) VALUES
  ('members_tab', 'hk_leader,njy_leader,njy_coordinator', 'Members: Top-level tab for editing member details', datetime('now'));
