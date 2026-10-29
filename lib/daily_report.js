// Director's Daily Report — turns the raw per-day aggregates from
// store.dailyReportRaw() into totals + per-leader + per-coord rows.
// Pure function: no DB access, so it's cheap to test and the saved
// snapshot is exactly what the screen renders.
//
// Attribution is by WHO DID THE WORK (marked_by / touched_by), not by
// the member's current coordinator — reassignments since that day
// would otherwise move history between coords.

// Follow-ups were only logged per day from this date (schema 0022).
export const FOLLOW_UP_LOG_START = "2026-10-12";

const DROPPED_STATUSES = new Set(["dropped", "uninterested", "unreachable"]);

export function buildDailyReport(dayIso, raw) {
  const users = new Map(raw.users.map(u => [u.id, u]));
  const nameOf = (u) => (u && (u.display_name || u.username)) || "";

  const act = new Map();   // user_id -> { chants, follow_ups }
  const bump = (id, k, n) => {
    const a = act.get(id) || { chants: 0, follow_ups: 0 };
    a[k] += n;
    act.set(id, a);
  };

  const totals = {
    members_chanted: 0,
    follow_ups: 0, coords_active: 0, coords_total: 0,
    leaders_active: 0, leaders_total: 0,
    leader_actions: 0, leader_points: 0,
    new_daily: 0, dropped: 0,
  };

  for (const c of raw.chants) {
    totals.members_chanted += c.n;
    if (c.marked_by) bump(c.marked_by, "chants", c.n);
  }
  for (const tch of raw.touches) {
    totals.follow_ups += tch.n;
    if (tch.touched_by) bump(tch.touched_by, "follow_ups", tch.n);
  }
  const leaderActs = new Map(raw.leaderActs.map(r => [r.leader_user_id, r]));
  for (const r of raw.leaderActs) { totals.leader_actions += r.n; totals.leader_points += r.pts || 0; }

  const status_changes = {};
  for (const s of raw.stageChanges) {
    status_changes[s.to_status] = s.n;
    if (s.to_status === "daily") totals.new_daily += s.n;
    if (DROPPED_STATUSES.has(s.to_status)) totals.dropped += s.n;
  }

  const coords = raw.users.filter(u => u.role === "njy_coordinator");
  const leaders = raw.users.filter(u => u.role === "njy_leader");
  const isActive = (a) => !!a && (a.chants > 0 || a.follow_ups > 0);

  const per_coord = coords.map((c) => {
    const a = act.get(c.id) || { chants: 0, follow_ups: 0 };
    const leader = users.get(c.manager_user_id);
    return {
      user_id: c.id, name: nameOf(c),
      leader_id: leader ? leader.id : null, leader_name: nameOf(leader),
      chants: a.chants, follow_ups: a.follow_ups,
      active: isActive(a),
    };
  }).sort((x, y) => x.leader_name.localeCompare(y.leader_name) || x.name.localeCompare(y.name));

  totals.coords_total = coords.length;
  totals.coords_active = per_coord.filter(r => r.active).length;

  const per_leader = leaders.map((l) => {
    const mine = per_coord.filter(r => r.leader_id === l.id);
    const own = act.get(l.id) || { chants: 0, follow_ups: 0 };
    const la = leaderActs.get(l.id);
    const row = {
      user_id: l.id, name: nameOf(l),
      coords_total: mine.length,
      coords_active: mine.filter(r => r.active).length,
      chants: own.chants + mine.reduce((s, r) => s + r.chants, 0),
      follow_ups: own.follow_ups + mine.reduce((s, r) => s + r.follow_ups, 0),
      leader_actions: la ? la.n : 0,
      leader_points: la ? (la.pts || 0) : 0,
    };
    row.active = row.leader_actions > 0 || isActive(own);
    return row;
  }).sort((x, y) => y.chants - x.chants || x.name.localeCompare(y.name));

  totals.leaders_total = leaders.length;
  totals.leaders_active = per_leader.filter(r => r.active).length;

  return {
    date: dayIso,
    follow_ups_tracked: dayIso >= FOLLOW_UP_LOG_START,
    totals, status_changes, per_leader, per_coord,
  };
}
