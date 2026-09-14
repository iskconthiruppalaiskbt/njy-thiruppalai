// 3-bucket prorated leader scoring model.
//
// Each NJY Leader's score decomposes into three normalised buckets:
//
//   Team Performance (60%)  — coord roll-up: sum(coord pts) / coord_count
//   Team Coverage    (25%)  — % of the leader's coords with ANY activity
//                             today (chants OR follow-ups OR any point-
//                             earning event), scaled 0-100
//   Leader Touch     (15%)  — leader-personal actions logged in
//                             leader_touch_actions (see schema 0010)
//                             raw sum, capped at TOUCH_NORM for the bar.
//
// The final score is a weighted combination of the three bars. Buckets
// are exposed individually so the UI can render three mini progress
// bars, and the composite is exposed as `total_score` for ranking.
//
// The intent (per user's spec): prorate so a leader with 6 coords and
// three active isn't buried under a leader with 15 coords and three
// active. Coverage % + per-coord average both accomplish that.

// Normalising constant for the Leader-Touch bar. 30 pts/day = a
// leader who fires broadcast (+5), updates their coord WA group (+5),
// contacts 3 coords via mesh WA (+9), and attends one event (+10) =
// 29 pts. So 30 is roughly a "great day" ceiling — anything at/above
// hits the 100% bar. Overall board uses TOUCH_NORM_OVERALL for the
// cumulative window (rough guess of a leader's full campaign ceiling).
export const TOUCH_NORM_DAILY   = 30;
export const TOUCH_NORM_OVERALL = 30 * 60;   // ~two months of daily peaks

// Weights per spec. If you change these, also nudge the frontend hint.
export const WEIGHTS = Object.freeze({
  team_performance: 0.60,
  team_coverage:    0.25,
  leader_touch:     0.15,
});

// Normalise the touch pts to a 0-100 bar, capped at 100. Guards div/0.
function normalise(pts, ceiling) {
  if (!ceiling) return 0;
  const v = Math.round((100 * (pts || 0)) / ceiling);
  return Math.max(0, Math.min(100, v));
}

// Compute a leader's 3-bucket breakdown given the raw inputs. The
// caller precomputes the per-coord pts + activity flags in ONE pass
// over the aggregate maps (see handlers.js leaders/daily) so this
// function is pure math — no store access.
//
// Inputs:
//   coordPtsList     — array of per-coord raw pts (numeric)
//   coordActiveList  — parallel array of booleans (true if that coord
//                      earned ANY pts today / in the window)
//   touchPts         — raw sum of the leader's own touch points
//   touchNorm        — normalising ceiling for the touch bar
//
// Output shape mirrored on both daily and overall boards so the
// frontend can render identically across tabs.
export function computeLeaderBuckets({ coordPtsList, coordActiveList, touchPts, touchNorm }) {
  const coordCount = coordPtsList.length;
  const teamRawPts = coordPtsList.reduce((s, x) => s + (x || 0), 0);
  const activeCoords = coordActiveList.filter(Boolean).length;

  // Team Performance = per-coord average of raw pts. Prorated by
  // dividing by coord count so team-size doesn't dominate.
  const team_performance = coordCount ? Math.round(teamRawPts / coordCount) : 0;

  // Team Coverage = % of the leader's coords with any activity.
  // Already prorated (it's a percentage) so a small strong team can
  // hit 100 while a big lazy team scrapes 20.
  const team_coverage = coordCount ? Math.round((100 * activeCoords) / coordCount) : 0;

  // Leader Touch = raw sum, no proration (it's an absolute count of
  // the leader's own actions and doesn't scale with team size).
  const leader_touch = Math.max(0, touchPts || 0);
  const leader_touch_bar = normalise(leader_touch, touchNorm);

  // For the composite, put all three bars on the SAME 0-100 scale.
  // Team performance is bounded by TEAM_PERF_NORM = 100 (per-coord
  // average of 100 = full bar; anything larger clamps to 100 for the
  // bar display but the raw number remains available in tooltips).
  const team_performance_bar = Math.max(0, Math.min(100, team_performance));

  const total_score = Math.round(
    WEIGHTS.team_performance * team_performance_bar
    + WEIGHTS.team_coverage    * team_coverage
    + WEIGHTS.leader_touch     * leader_touch_bar,
  );

  return {
    coord_count: coordCount,
    active_coords: activeCoords,
    team_raw_pts: teamRawPts,
    // Raw values (for tooltips / breakdown display):
    team_performance,
    team_coverage,
    leader_touch,
    // Normalised 0-100 bars (for the mini progress bars):
    team_performance_bar,
    team_coverage_bar: team_coverage,
    leader_touch_bar,
    total_score,
  };
}

// Per-action-key points and uniqueness rules for the leader_touch_actions
// ledger. Kept here so endpoints and the docs page stay in sync.
export const LEADER_TOUCH_RULES = Object.freeze({
  broadcast_daily:      { points: 5,  cap: 1,  scope: "day",       label: "Broadcast fired" },
  wa_group_saved_daily: { points: 5,  cap: 1,  scope: "day",       label: "WA group updated" },
  // contact_coord removed — mesh WA pill still opens wa.me but no longer awards points (no UI trigger was ever wired to POST /api/leader/contact-log).
  event_attended:       { points: 10, cap: 5,  scope: "target",    label: "Event attended in person" },
  coord_onboarded:      { points: 5,  cap: 99, scope: "target",    label: "New coord onboarded" },
});
