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
    // A leader's team counts: active if they or any of their coords did something.
    row.active = row.leader_actions > 0 || isActive(own) || row.coords_active > 0;
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

// Period report: adds up per-day reports (each from buildDailyReport,
// mostly read back from saved snapshots) for the coords and leaders
// active TODAY, grouped under their current leader. A coord counts as
// active in the period if they were active on at least one day.
export function buildRangeReport(fromIso, toIso, dayReports, users) {
  const nameOf = (u) => (u && (u.display_name || u.username)) || "";
  const coords = users.filter(u => u.role === "njy_coordinator");
  const leaders = users.filter(u => u.role === "njy_leader");
  const byId = new Map(users.map(u => [u.id, u]));
  const days = dayReports.slice().sort((a, b) => a.date.localeCompare(b.date));

  const totals = {
    members_chanted: 0, follow_ups: 0, new_daily: 0, dropped: 0,
    leader_actions: 0, leader_points: 0,
    coords_active: 0, coords_total: coords.length,
    leaders_active: 0, leaders_total: leaders.length,
    days: days.length,
  };
  const status_changes = {};
  const blank = () => ({ chants: 0, follow_ups: 0, days_active: 0, last_active: null });
  const cAgg = new Map(coords.map(c => [c.id, blank()]));
  const lAgg = new Map(leaders.map(l => [l.id, { ...blank(), leader_actions: 0, leader_points: 0 }]));

  for (const d of days) {
    const T = d.totals || {};
    totals.members_chanted += T.members_chanted || 0;
    totals.follow_ups += T.follow_ups || 0;
    totals.new_daily += T.new_daily || 0;
    totals.dropped += T.dropped || 0;
    for (const [k, n] of Object.entries(d.status_changes || {})) status_changes[k] = (status_changes[k] || 0) + n;

    const activeCoords = new Set();
    const coordSum = new Map();   // leader_id (that day) -> { chants, follow_ups } of their coords
    for (const r of d.per_coord || []) {
      const s = coordSum.get(r.leader_id) || { chants: 0, follow_ups: 0 };
      s.chants += r.chants; s.follow_ups += r.follow_ups;
      coordSum.set(r.leader_id, s);
      const a = cAgg.get(r.user_id);
      if (!a) continue;   // coord no longer active
      a.chants += r.chants; a.follow_ups += r.follow_ups;
      if (r.active) { a.days_active++; a.last_active = d.date; activeCoords.add(r.user_id); }
    }
    for (const r of d.per_leader || []) {
      totals.leader_actions += r.leader_actions || 0;
      totals.leader_points += r.leader_points || 0;
      const a = lAgg.get(r.user_id);
      if (!a) continue;
      const cs = coordSum.get(r.user_id) || { chants: 0, follow_ups: 0 };
      const own = { chants: r.chants - cs.chants, follow_ups: r.follow_ups - cs.follow_ups };
      a.chants += own.chants; a.follow_ups += own.follow_ups;
      a.leader_actions += r.leader_actions || 0;
      a.leader_points += r.leader_points || 0;
      const teamActive = coords.some(c => c.manager_user_id === r.user_id && activeCoords.has(c.id));
      if ((r.leader_actions || 0) > 0 || own.chants > 0 || own.follow_ups > 0 || teamActive) {
        a.days_active++; a.last_active = d.date;
      }
    }
  }

  const per_coord = coords.map((c) => {
    const a = cAgg.get(c.id);
    const leader = byId.get(c.manager_user_id);
    return {
      user_id: c.id, name: nameOf(c),
      leader_id: leader ? leader.id : null, leader_name: nameOf(leader),
      chants: a.chants, follow_ups: a.follow_ups,
      days_active: a.days_active, last_active: a.last_active,
      active: a.days_active > 0,
    };
  });
  totals.coords_active = per_coord.filter(r => r.active).length;

  const per_leader = leaders.map((l) => {
    const a = lAgg.get(l.id);
    const mine = per_coord.filter(r => r.leader_id === l.id);
    return {
      user_id: l.id, name: nameOf(l),
      coords_total: mine.length,
      coords_active: mine.filter(r => r.active).length,
      chants: a.chants + mine.reduce((s, r) => s + r.chants, 0),
      follow_ups: a.follow_ups + mine.reduce((s, r) => s + r.follow_ups, 0),
      leader_actions: a.leader_actions, leader_points: a.leader_points,
      days_active: a.days_active, last_active: a.last_active,
      active: a.days_active > 0,
    };
  });
  totals.leaders_active = per_leader.filter(r => r.active).length;

  return {
    from: fromIso, to: toIso,
    follow_ups_tracked: fromIso >= FOLLOW_UP_LOG_START,
    totals, status_changes, per_leader, per_coord,
  };
}
