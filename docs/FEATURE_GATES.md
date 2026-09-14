# Feature Gate Catalog

Source of truth for every UI unit and API endpoint that is (or should be)
gate-able via **Admin → Feature Gates**.

- **gate_key**: the string used in `feature_gates.feature_key` and in
  `can("...")` / `requireFeature(store, role, "...")` calls.
- **default enabled roles**: what the migration seeds so behavior does not
  regress. `hk_leader` is implicitly allowed on every gate via `canAccess`
  short-circuit, so an empty list still means "HK only".
- **UI location**: where `can(gate_key)` is (or should be) checked in
  `public/assets/app.js`.
- **API location**: the handler in `lib/handlers.js` that calls
  `requireFeature(...)` for the same gate.

Legend for default columns: **HK** = hk_leader, **NL** = njy_leader,
**NC** = njy_coordinator, **M** = member. Servant-tier roles (SL/CS/SS)
inherit from the seeded row where explicitly listed.

Existing gates from earlier migrations are marked `[existing]`. New gates
introduced by `schema/0009_feature_gates_expansion.sql` are marked `[new]`.

---

## Header / Global

| gate_key                     | description                                | UI                | API | Default        |
| ---------------------------- | ------------------------------------------ | ----------------- | --- | -------------- |
| `header_contact_leader_pill` | Contact-leader WhatsApp pill in coord roll | renderCoordRoll   |  -  | NC             |
| `header_contact_hk_pill`     | Contact-HK WhatsApp pill                   | renderCoordRoll   |  -  | HK, NL, NC     |
| `header_install_pwa`         | Install PWA nav button                     | renderNav         |  -  | HK, NL, NC, M  |
| `header_language_toggle`     | Language switcher                          | renderHeader…     |  -  | HK, NL, NC, M  |
| `header_points_chip`         | Points chip in header                      | renderHeader…     |  -  | HK, NL, NC     |

## My Roll / Team (coord home)

| gate_key                          | description                              | UI              | API                              | Default        |
| --------------------------------- | ---------------------------------------- | --------------- | -------------------------------- | -------------- |
| `coordinator_roll` [existing]     | Daily chanter roll + garland list        | renderCoordRoll | `/api/roll`                      | HK, NL, NC     |
| `myroll_mark_chanted_today`       | Tap-to-mark today                        | rollList        | `/api/roll/mark`                 | HK, NL, NC     |
| `myroll_mark_chanted_past_date`   | Backfill chant days                      | rollList        | `/api/roll/chant`                | HK, NL, NC     |
| `myroll_add_note`                 | Add a private note on a chanter          | rollList        | `/api/roll/note`                 | HK, NL, NC     |
| `myroll_change_status`            | Change status (daily / occasional / …)  | rollList        | `/api/person/:id/status`         | HK, NL, NC     |
| `myroll_reassign_member`          | Reassign chanter to another coord        | rollList        | `/api/person/:id/assign`         | HK, NL         |
| `myroll_manage_dropdown`          | Manage/edit member drawer                | rollList        | `/api/member/:id`                | HK, NL, NC     |
| `myroll_broadcast_button`         | "Broadcast today's message" CTA          | renderCoordRoll |  -                               | HK, NL, NC     |
| `myroll_wa_group_button`          | "My WhatsApp group" CTA                  | renderCoordRoll |  -                               | HK, NL, NC     |
| `myroll_care_moments_panel`       | Needs-your-attention section             | renderCareMomentPanel | `/api/roll/care-moments`   | HK, NL, NC     |
| `myroll_history_strip`            | Per-chanter history drawer               | rollList        | `/api/roll/:id/history`          | HK, NL, NC     |

## Team (leader view)

| gate_key                        | description                       | UI                        | API                        | Default    |
| ------------------------------- | --------------------------------- | ------------------------- | -------------------------- | ---------- |
| `leader_dashboard` [existing]   | NJY leader dashboard              | renderLeaderDashboard     | `/api/leader/coordinators` | HK, NL     |
| `team_view_coords_list`         | List of my coordinators           | renderLeaderDashboard     |  -                         | HK, NL     |
| `team_drill_into_coord`         | Drill into a coordinator's roll   | renderLeaderDrill         | `/api/user/:id/roll`       | HK, NL     |
| `team_broadcast_to_coords`      | Broadcast to coordinators         | renderLeaderDashboard     |  -                         | HK, NL     |
| `team_wa_group_of_coords`       | Coord-group WA link CTA           | renderLeaderDashboard     |  -                         | HK, NL     |

## HK Dashboard

| gate_key                    | description                       | UI                | API             | Default |
| --------------------------- | --------------------------------- | ----------------- | --------------- | ------- |
| `hk_dashboard` [existing]   | HK totals + leaders list          | renderHkDashboard | `/api/hk/*`     | HK      |
| `hk_reassign_leader`        | Move a leader/coord under a peer  | renderHkLeadersList | `/api/hk/leader/:id/assign` | HK    |

## Duties

| gate_key            | description             | UI            | API                        | Default        |
| ------------------- | ----------------------- | ------------- | -------------------------- | -------------- |
| `duties_view_list`  | See duties list         | renderDuties  | `/api/duties`              | HK, NL, NC, M  |
| `duties_mark_done`  | Mark a duty done        | renderDuties  | `/api/duties/:id/done`     | HK, NL, NC, M  |
| `duties_delete`     | Delete a duty           | renderDuties  | `/api/duties/:id` DELETE   | HK             |

## Events

| gate_key                          | description                    | UI                       | API                            | Default        |
| --------------------------------- | ------------------------------ | ------------------------ | ------------------------------ | -------------- |
| `event_attendance` [existing]     | Attendance capture             | renderEventAttendance    | `/api/events/:id/attendance`   | HK, NL, NC     |
| `events_view_list`                | View events list               | renderEvents             | `/api/events`                  | HK, NL, NC     |
| `admin_events` [existing]         | Admin → Events sub-tab         | renderAdminEvents        | `/api/events` POST             | HK             |
| `events_edit`                     | Edit event details             | renderAdminEvents        | `/api/events/:id` POST         | HK             |
| `events_delete`                   | Delete an event                | renderAdminEvents        | `/api/events/:id` DELETE       | HK             |

## BV Structure

| gate_key                         | description                | UI              | API                         | Default    |
| -------------------------------- | -------------------------- | --------------- | --------------------------- | ---------- |
| `bv_structure_editor` [existing] | BV structure page          | renderBvStructure | `/api/bv/structure`       | HK         |
| `bv_add_group`                   | Create a new BV group      | renderBvStructure | `/api/bv/group` POST      | HK         |
| `bv_delete_group`                | Delete a BV group          | renderBvStructure | `/api/bv/group/:id` DELETE | HK        |
| `bv_edit_group`                  | Edit BV group meta         | renderBvStructure |  -                          | HK        |

## Janmashtami

| gate_key                        | description                             | UI                | API                            | Default        |
| ------------------------------- | --------------------------------------- | ----------------- | ------------------------------ | -------------- |
| `janmashtami_view_page`         | Access the tab at all                   | renderNav / renderJanmashtami | `/api/me/janmashtami-progress` | HK, NL, NC |
| `janmashtami_quick_add`         | Path A single-row rapid form            | renderJanmashtami | `/api/janmashtami/entry`       | HK, NL, NC     |
| `janmashtami_upload_csv`        | Path B Excel/CSV upload widget          | renderJanmashtami | `/api/janmashtami/bulk`        | HK, NL, NC     |
| `janmashtami_paste_rows`        | Path C paste-many textarea              | renderJanmashtami | `/api/janmashtami/bulk`        | HK, NL, NC     |
| `janmashtami_download_template` | Download Excel template button          | renderJanmashtami |  -                             | HK, NL, NC     |
| `janmashtami_preview`           | Preview stage on Excel widget           | renderJanmashtami |  -                             | HK, NL, NC     |
| `janmashtami_commit_import`     | Confirm/import button                   | renderJanmashtami | `/api/janmashtami/bulk`        | HK, NL, NC     |
| `janmashtami_progress_counters` | Sticky tier/progress badges             | renderJanmashtami | `/api/me/janmashtami-progress` | HK, NL, NC     |
| `janmashtami_today_entries`     | Bottom-of-page recent-entries card      | renderJanmashtami | `/api/me/janmashtami-entries`  | HK, NL, NC     |

## Leaderboard

| gate_key                     | description                       | UI                | API                                     | Default    |
| ---------------------------- | --------------------------------- | ----------------- | --------------------------------------- | ---------- |
| `leaderboard_coord_daily`    | Coord daily leaderboard           | renderLeaderboard | `/api/leaderboard/daily`                | HK, NL, NC |
| `leaderboard_coord_overall`  | Coord overall leaderboard         | renderLeaderboard | `/api/leaderboard/overall`              | HK, NL, NC |
| `leaderboard_leaders_daily`  | Leaders daily leaderboard         | renderLeaderboard | `/api/leaderboard/leaders/daily`        | HK, NL     |
| `leaderboard_leaders_overall`| Leaders overall leaderboard       | renderLeaderboard | `/api/leaderboard/leaders/overall`      | HK, NL     |
| `leaderboard_sort_toggle`    | Toggle sort direction             | renderLeaderboard |  -                                      | HK, NL, NC |

## Settings

| gate_key                            | description                    | UI                     | API                          | Default            |
| ----------------------------------- | ------------------------------ | ---------------------- | ---------------------------- | ------------------ |
| `settings_change_password`          | Change my password             | renderSettings         | `/api/me/password`           | HK, NL, NC, SL, MSL |
| `settings_wa_templates`             | Edit WA template snippets      | renderSettings         | `/api/me/wa-templates`       | HK, NL, NC         |
| `web_push` [existing]               | Subscribe to browser push      | renderSettings         | `/api/webpush/subscribe`     | HK, NL, NC, SL     |
| `settings_view_profile`             | Profile block on Settings      | renderSettings         | `/api/me`                    | HK, NL, NC         |
| `settings_wa_group_link`            | Save WA group invite link      | renderSettings         | `/api/me/wa-group`           | HK, NL, NC         |

## Admin (HK umbrella)

| gate_key                              | description                     | UI                     | API                             | Default |
| ------------------------------------- | ------------------------------- | ---------------------- | ------------------------------- | ------- |
| `feature_admin` [existing]            | Admin section overall           | renderAdmin            | `/api/admin/feature-gate` etc.  | HK      |
| `admin_gates` [existing]              | Sub-tab: Feature gates          | renderAdminGates       | `/api/admin/feature-gate`       | HK      |
| `admin_users` [existing]              | Sub-tab: Users list + edit      | renderAdminUsers       | `/api/admin/users`              | HK      |
| `admin_users_bulk` [existing]         | Sub-tab: Bulk create users      | renderAdminUsersBulk   | `/api/admin/users/bulk`         | HK      |
| `admin_import_chanters` [existing]    | Sub-tab: Bulk import chanters   | renderAdminImport      | `/api/import/preview`+`commit`  | HK      |
| `admin_events` [existing]             | Sub-tab: Events CRUD            | renderAdminEvents      | `/api/events` POST              | HK      |
| `admin_points_rules_edit`             | Edit points rules               | renderPointsRules      | (client only right now)         | HK      |
| `admin_roles_manage`                  | Change a user's role            | renderAdminUsers       | `/api/admin/users/:id`          | HK      |
| `bulk_import` [existing]              | Chanter CSV endpoints           |  -                     | `/api/import/*`                 | HK      |

## Sadhana

| gate_key                       | description                       | UI                 | API                        | Default                     |
| ------------------------------ | --------------------------------- | ------------------ | -------------------------- | --------------------------- |
| `sadhana_chart` [existing]     | 124-pt daily sadhana entry        | renderSadhana      | `/api/sadhana`             | HK, MSL, SL, CS, SS, M      |
| `sadhana_entry_submit`         | Submit today's entry              | renderSadhana      | `/api/sadhana` POST        | HK, MSL, SL, CS, SS, M      |
| `sadhana_delete_entry`         | Delete an entry                   | renderSadhana      | `/api/sadhana/:id` DELETE  | HK, MSL, SL                 |
| `sadhana_browse`               | Browse other people's charts      | renderSadhanaBrowse | `/api/sadhana/:personId` | HK, MSL, SL, CS, SS         |

## Cross-cutting

| gate_key                      | description                       | UI/API                    | Default                              |
| ----------------------------- | --------------------------------- | ------------------------- | ------------------------------------ |
| `whatsapp_deeplink` [existing]| wa.me buttons on rows             | rollList / `/api/whatsapp/url` | HK, NL, NC, SL                 |
| `member_details_full` [existing] | Full member drawer             | renderMemberDetails / `/api/member/:id` | HK                        |
| `group_planning_sheet` [existing] | BV group weekly report         | renderGroupReport / `/api/group-reports/*` | HK                     |
| `action_timeline_duties` [existing] | Duty auto-generator          | duty pipeline             | HK                                   |

---

## Notes on defaults

- All new gates are seeded so **current behavior does not regress**. If
  the code today lets an NJY Coordinator do X, the new gate is seeded
  with `njy_coordinator` in its allowed list.
- `hk_leader` is intentionally omitted from many `allowed_roles`
  strings — the runtime `canAccess()` helper always returns true for HK
  Leader.
- Servant-tier roles (`servant_leader`, `sector_servant`,
  `circle_servant`, `manjari_servant_leader`) are listed only where the
  code today already grants them access. HK can widen at will from the
  admin UI.
