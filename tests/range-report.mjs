import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../lib/handlers.js";
import { memoryStore } from "../lib/store-memory.js";
import { hashPassword } from "../lib/auth.js";
import { todayInTz } from "../lib/ids.js";

const SECRET = "test-secret-for-range-report";

async function seed() {
  const s = memoryStore();
  await s.setFeatureGate("coordinator_roll", ["njy_coordinator", "njy_leader", "hk_leader"], "system");
  await s.setFeatureGate("myroll_mark_chanted_today", ["njy_coordinator"], "system");
  await s.setFeatureGate("myroll_mark_chanted_past_date", ["njy_coordinator"], "system");
  const pw = await hashPassword("test-pass-123");
  const hk = await s.createUser({ username: "hk", password_hash: pw, display_name: "Director", role: "hk_leader" });
  const leader = await s.createUser({ username: "l1", password_hash: pw, display_name: "Leader A", role: "njy_leader" });
  const c1 = await s.createUser({ username: "c1", password_hash: pw, display_name: "Coord One", role: "njy_coordinator", manager_user_id: leader.id });
  const c2 = await s.createUser({ username: "c2", password_hash: pw, display_name: "Coord Two", role: "njy_coordinator", manager_user_id: leader.id });
  const ppl = [];
  for (let i = 1; i <= 3; i++) {
    ppl.push(await s.createPerson({ legal_name: `P${i}`, phone: `+91900000000${i}`, assigned_to_user_id: c1.id }));
  }
  return { s, hk, leader, c1, c2, ppl };
}

async function login(store, username) {
  const res = await route(new Request("http://x/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "test-pass-123" }),
  }), { store, env: { SESSION_SECRET: SECRET } });
  return (res.headers.get("set-cookie") || "").split(";")[0];
}

const post = (store, cookie, path, body) => route(new Request("http://x" + path, {
  method: "POST", headers: { "content-type": "application/json", cookie },
  body: JSON.stringify(body),
}), { store, env: { SESSION_SECRET: SECRET } });

const daysAgo = (n) => {
  const d = new Date(todayInTz() + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

test("range report: Director only, bad and too-long ranges rejected", async () => {
  const { s } = await seed();
  assert.equal((await post(s, await login(s, "c1"), "/api/hk/range-report", { from: daysAgo(3), to: daysAgo(1) })).status, 403);
  const hk = await login(s, "hk");
  assert.equal((await post(s, hk, "/api/hk/range-report", { from: daysAgo(1), to: daysAgo(3) })).status, 400);
  assert.equal((await post(s, hk, "/api/hk/range-report", { from: daysAgo(1), to: "2999-01-01" })).status, 400);
});

test("range report: days active, totals, never-active coord, today included", async () => {
  const { s, c1, c2, leader, ppl } = await seed();
  const mark = (p, d) => s.upsertChant({ person_id: p.id, entry_date: d, chanted: 1, source: "coordinator", marked_by: c1.id });
  await mark(ppl[0], daysAgo(4));
  await mark(ppl[1], daysAgo(4));
  await mark(ppl[0], daysAgo(2));
  await mark(ppl[0], todayInTz());
  await s.logTouchForPersonOnDate(ppl[2].id, daysAgo(2), c1.id);
  const hk = await login(s, "hk");
  // One day saved beforehand via the Daily Report: the range must reuse it.
  await post(s, hk, "/api/hk/daily-report", { date: daysAgo(4) });

  const body = await (await post(s, hk, "/api/hk/range-report", { from: daysAgo(5), to: todayInTz() })).json();
  assert.equal(body.totals.days, 6);
  assert.equal(body.totals.members_chanted, 4);
  assert.equal(body.totals.follow_ups, 1);
  assert.equal(body.meta.days_computed, 4);   // 5,3,2,1 ago; 4 ago was saved; today is live
  const one = body.per_coord.find(r => r.user_id === c1.id);
  const two = body.per_coord.find(r => r.user_id === c2.id);
  assert.deepEqual([one.chants, one.follow_ups, one.days_active, one.last_active], [4, 1, 3, todayInTz()]);
  assert.deepEqual([two.active, two.days_active, two.last_active], [false, 0, null]);
  const la = body.per_leader.find(r => r.user_id === leader.id);
  assert.deepEqual([la.coords_total, la.coords_active, la.chants, la.days_active, la.active], [2, 1, 4, 3, true]);
  assert.deepEqual([body.totals.coords_active, body.totals.coords_total, body.totals.leaders_active], [1, 2, 1]);

  // Second run: every past day is now saved, nothing recomputed.
  const again = await (await post(s, hk, "/api/hk/range-report", { from: daysAgo(5), to: daysAgo(1) })).json();
  assert.equal(again.meta.days_computed, 0);
  assert.equal(again.totals.members_chanted, 3);
});

test("range report: from before NJY start is clamped to the start", async () => {
  const { s } = await seed();
  const hk = await login(s, "hk");
  const res = await post(s, hk, "/api/hk/range-report", { from: "2026-01-01", to: "2026-08-20" });
  const body = await res.json();
  assert.equal(body.from, "2026-08-18");
  assert.equal(body.totals.days, 3);
});
