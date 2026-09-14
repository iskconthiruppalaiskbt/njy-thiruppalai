-- Migration 0009 — Feature-gate expansion
--
-- Adds a per-sub-feature gate for every UI unit and endpoint listed in
-- docs/FEATURE_GATES.md. Existing gates from 0001 and 0007 are kept as-is
-- (this file uses INSERT OR IGNORE so re-running is safe, and never
-- overwrites a role list HK has already customised in prod).
--
-- Default role lists mirror CURRENT behavior in code, so applying this
-- migration does NOT lock anyone out of a feature they use today.
-- hk_leader is implicitly allowed on every gate at runtime (see
-- lib/rbac.js canAccess()), so it is omitted from most lists to keep
-- the seeds compact.

INSERT OR IGNORE INTO feature_gates (feature_key, allowed_roles, description, updated_at) VALUES
  -- Header / global -----------------------------------------------------
  ('header_contact_leader_pill', 'njy_coordinator',                                        'Header: Contact Leader WhatsApp pill',   datetime('now')),
  ('header_contact_hk_pill',     'njy_leader,njy_coordinator',                             'Header: Contact HK WhatsApp pill',       datetime('now')),
  ('header_install_pwa',         'hk_leader,njy_leader,njy_coordinator,member',            'Header: Install-PWA nav button',         datetime('now')),
  ('header_language_toggle',     'hk_leader,njy_leader,njy_coordinator,member,servant_leader,circle_servant,sector_servant,manjari_servant_leader',
                                                                                           'Header: Language toggle',                datetime('now')),
  ('header_points_chip',         'njy_leader,njy_coordinator',                             'Header: Points chip',                    datetime('now')),

  -- My Roll -------------------------------------------------------------
  ('myroll_mark_chanted_today',    'njy_coordinator,njy_leader',                           'My Roll: Mark chanted today',            datetime('now')),
  ('myroll_mark_chanted_past_date','njy_coordinator,njy_leader',                           'My Roll: Backfill past chant days',      datetime('now')),
  ('myroll_add_note',              'njy_coordinator,njy_leader',                           'My Roll: Add private note on chanter',   datetime('now')),
  ('myroll_change_status',         'njy_coordinator,njy_leader',                           'My Roll: Change chanter status',         datetime('now')),
  ('myroll_reassign_member',       'njy_leader',                                           'My Roll: Reassign chanter to another coord', datetime('now')),
  ('myroll_manage_dropdown',       'njy_coordinator,njy_leader',                           'My Roll: Manage/edit member drawer',     datetime('now')),
  ('myroll_broadcast_button',      'njy_coordinator,njy_leader',                           'My Roll: Broadcast today message CTA',   datetime('now')),
  ('myroll_wa_group_button',       'njy_coordinator,njy_leader',                           'My Roll: WhatsApp group CTA',            datetime('now')),
  ('myroll_care_moments_panel',    'njy_coordinator',                                      'My Roll: Care-moments Needs-attention',  datetime('now')),
  ('myroll_history_strip',         'njy_coordinator,njy_leader',                           'My Roll: Per-chanter history drawer',    datetime('now')),

  -- Team (leader) -------------------------------------------------------
  ('team_view_coords_list',        'njy_leader',                                           'Team: View my coordinators list',        datetime('now')),
  ('team_drill_into_coord',        'njy_leader',                                           'Team: Drill into a coordinator roll',    datetime('now')),
  ('team_broadcast_to_coords',     'njy_leader',                                           'Team: Broadcast to my coordinators',     datetime('now')),
  ('team_wa_group_of_coords',      'njy_leader',                                           'Team: Coord-group WhatsApp CTA',         datetime('now')),

  -- HK ------------------------------------------------------------------
  ('hk_reassign_leader',           'hk_leader',                                            'HK: Reassign a leader/coord',            datetime('now')),

  -- Duties --------------------------------------------------------------
  ('duties_view_list',             'hk_leader,njy_leader,njy_coordinator,member,servant_leader,circle_servant,sector_servant,manjari_servant_leader',
                                                                                           'Duties: View my duties list',            datetime('now')),
  ('duties_mark_done',             'hk_leader,njy_leader,njy_coordinator,member,servant_leader,circle_servant,sector_servant,manjari_servant_leader',
                                                                                           'Duties: Mark done',                      datetime('now')),
  ('duties_delete',                'hk_leader',                                            'Duties: Delete a duty',                  datetime('now')),

  -- Events --------------------------------------------------------------
  ('events_view_list',             'hk_leader,njy_leader,njy_coordinator',                 'Events: View list',                      datetime('now')),
  ('events_edit',                  'hk_leader',                                            'Events: Edit event details',             datetime('now')),
  ('events_delete',                'hk_leader',                                            'Events: Delete an event',                datetime('now')),

  -- BV ------------------------------------------------------------------
  ('bv_add_group',                 'hk_leader',                                            'BV: Add a group',                        datetime('now')),
  ('bv_delete_group',              'hk_leader',                                            'BV: Delete a group',                     datetime('now')),
  ('bv_edit_group',                'hk_leader',                                            'BV: Edit a group',                       datetime('now')),

  -- Janmashtami ---------------------------------------------------------
  ('janmashtami_view_page',        'hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Access the tab',            datetime('now')),
  ('janmashtami_quick_add',        'hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Quick-add rapid form',      datetime('now')),
  ('janmashtami_upload_csv',       'hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Upload Excel/CSV widget',   datetime('now')),
  ('janmashtami_paste_rows',       'hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Paste-many textarea',       datetime('now')),
  ('janmashtami_download_template','hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Download Excel template',   datetime('now')),
  ('janmashtami_preview',          'hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Preview stage of upload',   datetime('now')),
  ('janmashtami_commit_import',    'hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Commit/import button',      datetime('now')),
  ('janmashtami_progress_counters','hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Sticky progress counters',  datetime('now')),
  ('janmashtami_today_entries',    'hk_leader,njy_leader,njy_coordinator',                 'Janmashtami: Today entries card',        datetime('now')),

  -- Leaderboard ---------------------------------------------------------
  ('leaderboard_coord_daily',      'hk_leader,njy_leader,njy_coordinator',                 'Leaderboard: Coord daily',               datetime('now')),
  ('leaderboard_coord_overall',    'hk_leader,njy_leader,njy_coordinator',                 'Leaderboard: Coord overall',             datetime('now')),
  ('leaderboard_leaders_daily',    'hk_leader,njy_leader',                                 'Leaderboard: Leaders daily',             datetime('now')),
  ('leaderboard_leaders_overall',  'hk_leader,njy_leader',                                 'Leaderboard: Leaders overall',           datetime('now')),
  ('leaderboard_sort_toggle',      'hk_leader,njy_leader,njy_coordinator',                 'Leaderboard: Sort toggle',               datetime('now')),

  -- Settings ------------------------------------------------------------
  ('settings_change_password',     'hk_leader,njy_leader,njy_coordinator,servant_leader,manjari_servant_leader',
                                                                                           'Settings: Change my password',           datetime('now')),
  ('settings_wa_templates',        'hk_leader,njy_leader,njy_coordinator',                 'Settings: Edit WA template snippets',    datetime('now')),
  ('settings_view_profile',        'hk_leader,njy_leader,njy_coordinator,servant_leader,manjari_servant_leader,member',
                                                                                           'Settings: View my profile block',        datetime('now')),
  ('settings_wa_group_link',       'hk_leader,njy_leader,njy_coordinator',                 'Settings: Save WA group invite link',    datetime('now')),

  -- Admin ---------------------------------------------------------------
  ('admin_points_rules_edit',      'hk_leader',                                            'Admin: Edit points rules',               datetime('now')),
  ('admin_roles_manage',           'hk_leader',                                            'Admin: Change a user role',              datetime('now')),

  -- Sadhana -------------------------------------------------------------
  ('sadhana_entry_submit',         'hk_leader,manjari_servant_leader,servant_leader,circle_servant,sector_servant,member',
                                                                                           'Sadhana: Submit today entry',            datetime('now')),
  ('sadhana_delete_entry',         'hk_leader,manjari_servant_leader,servant_leader',      'Sadhana: Delete an entry',               datetime('now')),
  ('sadhana_browse',               'hk_leader,manjari_servant_leader,servant_leader,circle_servant,sector_servant',
                                                                                           'Sadhana: Browse other charts',           datetime('now'));
