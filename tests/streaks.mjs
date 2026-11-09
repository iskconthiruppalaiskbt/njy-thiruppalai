import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../lib/store-memory.js";
import { scoreDailyForCoord, scoreOverallForCoord, addDaysIso } from "../lib/leaderboard.js";
import { todayInTz } from "../lib/ids.js";

async function seed() {
  const s = memoryStore();
  const coord = await s.createUser({ username: "c1", password_hash: "x", display_name: "Coord One", role: "njy_coordinator" });
  const mk = (i, status) => s.createPerson({ legal_name: `P${i}`, phone: `+91900000000${i}`, assigned_to_user_id: coord.id, status });
  const [a, b, c] = [await mk(1, "daily"), await mk(2, "daily"), await mk(3, "chanter")];
  return { s, coord, a, b, c };
}

const chantRun = async (s, person, lastDay, days) => {
  for (let i = 0; i < days; i++) {
    await s.upsertChant({ person_id: person.id, entry_date: addDaysIso(lastDay, -i), chanted: 1, source: "coordinator", marked_by: null });
  }
};
const pk = (r, k) => (r.breakdown.find(b => b.k === k) || { n: 0, pts: 0 });

test("streaks: daily board awards +20 on the day a member reaches 7 in a row", async () => {
  const { s, coord, a, b, c } = await seed();
  const today = todayInTz();
  await chantRun(s, a, today, 7);    // reaches 7 today
  await chantRun(s, b, today, 9);    // reached 7 two days ago: no bonus today
  await chantRun(s, c, today, 6);    // only 6
  const r = await scoreDailyForCoord(s, coord, today);
  assert.deepEqual([pk(r, "streak_7").n, pk(r, "streak_7").pts], [1, 20]);
  assert.equal(pk(r, "chanted").n, 3);
  assert.equal(pk(r, "perfect_day").pts, 50);    // both daily-status members chanted
});

test("streaks: daily board awards +50 on the day a member reaches 30", async () => {
  const { s, coord, a } = await seed();
  const today = todayInTz();
  await chantRun(s, a, today, 30);
  const r = await scoreDailyForCoord(s, coord, today);
  assert.equal(pk(r, "streak_30").pts, 50);
  assert.equal(pk(r, "streak_7").n, 0);
});

test("streaks: overall board counts every run reached since Phase 1", async () => {
  const { s, coord, a, b } = await seed();
  const today = todayInTz();
  await chantRun(s, a, today, 31);                  // one 7 + one 30
  await chantRun(s, b, addDaysIso(today, -20), 7);  // one 7, run since broken
  await chantRun(s, b, today, 7);                   // a second 7
  const r = await scoreOverallForCoord(s, coord);
  assert.deepEqual([pk(r, "streak_7").n, pk(r, "streak_30").n], [3, 1]);
  assert.equal(pk(r, "chant_days").n, 31 + 14);
});

test("streaks: one non-chanting daily member blocks the perfect day", async () => {
  const { s, coord, a } = await seed();
  const today = todayInTz();
  await chantRun(s, a, today, 1);
  const r = await scoreDailyForCoord(s, coord, today);
  assert.equal(pk(r, "perfect_day").pts, 0);
});
