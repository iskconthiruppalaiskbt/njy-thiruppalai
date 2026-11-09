// Point computations for the two leaderboards. All numbers derive from
// existing tables (people, daily_chant_log, attendance, events) so no
// new schema is needed. See §6 of memory/post-demo-features.md for the
// full rule matrix.
//
// Scope: NJY Coordinators only. Higher-tier users don't compete.

import { todayInTz, daysBetween } from "./ids.js";

// JANMASHTAMI_DATE removed — the campaign-day point awards it gated
// were retired after 2026-08-25. PHASE1_START still bounds the P1+P2
// aggregation window below.
const PHASE1_START = "2026-08-18";

// Chanting-streak bonuses (rules page: "Member hits 7-day / 30-day
// chanting streak"). Awarded on the day the run of consecutive chanted
// days reaches exactly 7 or 30; a broken run can earn them again.
const STREAK_7_PTS = 20;
const STREAK_30_PTS = 50;

export function addDaysIso(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// rows: [{ person_id, entry_date }] chanted days. Counts how many times a
// run reached 7 and 30 days, where the day it reached them is in
// [fromIso, toIso]. Rows must cover enough days before fromIso for runs
// that started earlier to be measured correctly.
export function streakHits(rows, fromIso, toIso) {
  const byPerson = new Map();
  for (const r of rows) {
    if (!byPerson.has(r.person_id)) byPerson.set(r.person_id, []);
    byPerson.get(r.person_id).push(r.entry_date);
  }
  let hit7 = 0, hit30 = 0;
  for (const dates of byPerson.values()) {
    dates.sort();
    let run = 0, prev = null;
    for (const d of dates) {
      if (d === prev) continue;
      run = prev && addDaysIso(prev, 1) === d ? run + 1 : 1;
      prev = d;
      if (d < fromIso || d > toIso) continue;
      if (run === 7) hit7++;
      if (run === 30) hit30++;
    }
  }
  return { hit7, hit30 };
}

function pushStreaks(bd, { hit7, hit30 }) {
  let pts = 0;
  if (hit7) { pts += hit7 * STREAK_7_PTS; bd.push({ k: "streak_7", n: hit7, pts: hit7 * STREAK_7_PTS }); }
  if (hit30) { pts += hit30 * STREAK_30_PTS; bd.push({ k: "streak_30", n: hit30, pts: hit30 * STREAK_30_PTS }); }
  return pts;
}

// Compute the daily-board points earned by one coord on `dateIso`.
export async function scoreDailyForCoord(store, coord, dateIso) {
  const roll = await store.peopleAssignedTo(coord.id);
  const rollIds = new Set(roll.map(p => p.id));
  let pts = 0;
  const bd = [];

  // One query for the last 8 days replaces a chantOnDate per member
  // (twice, with the perfect-day check). Filtered to the current roll
  // so counts match the old per-member loop.
  const week = (await store.chantDatesForCoord(coord.id, addDaysIso(dateIso, -7), dateIso))
    .filter(r => rollIds.has(r.person_id));
  const chantedToday = new Set(week.filter(r => r.entry_date === dateIso).map(r => r.person_id));

  // +10 per chanter marked chanted today
  const chantedCount = chantedToday.size;
  if (chantedCount) { pts += chantedCount * 10; bd.push({ k: "chanted", n: chantedCount, pts: chantedCount * 10 }); }

  // Streaks reached today. A 7-day hit needs only the 8-day window. A
  // 30-day hit means chanted on day -29 but not -30, so members who
  // chanted all 8 days get a 2-day probe (~2 rows each), and only those
  // matching it fetch the 21 days in between. Keeps reads near the
  // 8-day window instead of a month per member per board load.
  const daysByPerson = new Map();
  for (const r of week) {
    if (!daysByPerson.has(r.person_id)) daysByPerson.set(r.person_id, new Set());
    daysByPerson.get(r.person_id).add(r.entry_date);
  }
  const fullWeek = [...daysByPerson].filter(([, s]) => s.size === 8).map(([id]) => id);
  const d30 = addDaysIso(dateIso, -30), d29 = addDaysIso(dateIso, -29);
  const probe = await store.chantDatesForPeople(fullWeek, d30, d29);
  const on = (id, d) => probe.some(r => r.person_id === id && r.entry_date === d);
  const maybe30 = fullWeek.filter(id => on(id, d29) && !on(id, d30));
  const middle = await store.chantDatesForPeople(maybe30, addDaysIso(dateIso, -28), addDaysIso(dateIso, -8));
  pts += pushStreaks(bd, streakHits([...week, ...probe, ...middle], dateIso, dateIso));

  // +5 per follow-up today. Counted from person_touch_log so the daily
  // and overall boards share one source of truth. A tap to white
  // doesn't log a row (see /api/roll/mark), so cycling back to white
  // correctly drops the point.
  const followUps = await store.countTouchesForCoordOnDate(coord.id, dateIso);
  if (followUps) { pts += followUps * 5; bd.push({ k: "follow_up", n: followUps, pts: followUps * 5 }); }

  // +50 per NJY event attendance today (marked_at is today)
  const events = await store.listEvents();
  let njyAttendedToday = 0;
  for (const ev of events) {
    if (ev.event_date !== dateIso) continue;
    if (!/^njy/.test(ev.kind)) continue;
    const att = await store.attendanceForEvent(ev.id);
    njyAttendedToday += att.filter(a => a.attended && rollIds.has(a.person_id)).length;
  }
  if (njyAttendedToday) { pts += njyAttendedToday * 50; bd.push({ k: "njy_attend", n: njyAttendedToday, pts: njyAttendedToday * 50 }); }

  // Perfect-day bonus: all daily-status chanters in the roll marked
  // chanted today. Only fires if there are daily chanters at all.
  const dailyOnes = roll.filter(p => p.status === "daily");
  if (dailyOnes.length && dailyOnes.every(p => chantedToday.has(p.id))) {
    pts += 50; bd.push({ k: "perfect_day", n: 1, pts: 50 });
  }

  return { user_id: coord.id, name: coord.display_name, pts, breakdown: bd };
}

// Compute the overall (P1+P2) points for one coord. Sums up chant days,
// follow-ups, attendance, plus Janmashtami-day entry/commit bonuses,
// plus the three milestone bonuses.
export async function scoreOverallForCoord(store, coord) {
  const roll = await store.peopleAssignedTo(coord.id);
  const today = todayInTz();
  let pts = 0;
  const bd = [];

  // Single aggregate query for the whole coord's roll — was N*M loop
  // before and timing out Workers on real data.
  // Rows are returned (not counted) so streaks come from the same scan.
  const chantRows = await store.chantDatesForCoord(coord.id, PHASE1_START, today);
  const totalChantDays = chantRows.length;
  if (totalChantDays) { pts += totalChantDays * 10; bd.push({ k: "chant_days", n: totalChantDays, pts: totalChantDays * 10 }); }
  pts += pushStreaks(bd, streakHits(chantRows, PHASE1_START, today));

  // Cumulative follow-up count from the per-day touch log — a chanter
  // touched on 30 distinct days contributes 30 × 5 = 150, not 5.
  // Prior to person_touch_log (schema 0022) this scanned last_marked_at
  // and capped at "distinct people touched once"; Director reported the
  // top coords all landing at exactly 200 pts (= 40 members × 5). The
  // backfill in 0022 populates one row per touched person at their
  // last_marked_at date so the number doesn't collapse on first deploy;
  // every touch from then on accumulates for real.
  const touched = await store.countTouchesForCoord(coord.id, PHASE1_START, today);
  if (touched) { pts += touched * 5; bd.push({ k: "follow_ups", n: touched, pts: touched * 5 }); }

  // Attendance across all NJY events in the roll
  const events = await store.listEvents();
  const rollIds = new Set(roll.map(p => p.id));
  let njyAttends = 0;
  const attendedNjy1 = new Set(), attendedNjy2 = new Set(), attendedNjy3 = new Set();
  for (const ev of events) {
    if (!/^njy/.test(ev.kind)) continue;
    const att = await store.attendanceForEvent(ev.id);
    for (const a of att) {
      if (!a.attended || !rollIds.has(a.person_id)) continue;
      njyAttends++;
      if (ev.kind === "njy1") attendedNjy1.add(a.person_id);
      if (ev.kind === "njy2") attendedNjy2.add(a.person_id);
      if (ev.kind === "njy3") attendedNjy3.add(a.person_id);
    }
  }
  if (njyAttends) { pts += njyAttends * 50; bd.push({ k: "njy_attends", n: njyAttends, pts: njyAttends * 50 }); }

  // +100 per person who attended all three NJYs (streak bonus)
  const triple = [...attendedNjy1].filter(id => attendedNjy2.has(id) && attendedNjy3.has(id)).length;
  if (triple) { pts += triple * 100; bd.push({ k: "njy_triple", n: triple, pts: triple * 100 }); }

  // Janmashtami-day entry + daily-commitment points removed after the
  // 2026 campaign closed. Historical points already earned remain baked
  // into users' aggregates via the (now-empty) breakdown they were
  // credited under; we simply stop awarding new ones for any coord
  // whose roll grows after the campaign end. Rules page updated too —
  // see renderPointsRules in public/assets/app.js.
  //
  // (Milestones — 35/50 one-month-daily, 16/50 NJY2, 12/50 NJY3 — are
  // ONGOING and stay in effect below.)

  // Milestone: 35/50 one-month-daily. Uses store.oneMonthDailyCountFor.
  const monthly = await store.oneMonthDailyCountFor(coord.id, today);
  if (monthly.one_month_daily >= 35) {
    pts += 200; bd.push({ k: "milestone_35_one_month", n: 1, pts: 200 });
  }
  // Milestone: 16/50 NJY 2 attendees
  if (attendedNjy2.size >= 16) {
    pts += 200; bd.push({ k: "milestone_16_njy2", n: 1, pts: 200 });
  }
  // Milestone: 12/50 NJY 3 attendees
  if (attendedNjy3.size >= 12) {
    pts += 400; bd.push({ k: "milestone_12_njy3", n: 1, pts: 400 });
  }

  return { user_id: coord.id, name: coord.display_name, pts, breakdown: bd };
}
