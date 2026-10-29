import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../lib/handlers.js";
import { memoryStore } from "../lib/store-memory.js";
import { hashPassword } from "../lib/auth.js";
import { todayInTz } from "../lib/ids.js";

const SECRET = "test-secret-for-daily-report";

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

test("daily report: Director only", async () => {
  const { s } = await seed();
  const res = await post(s, await login(s, "c1"), "/api/hk/daily-report", { date: todayInTz() });
  assert.equal(res.status, 403);
});

test("daily report: rejects bad and future dates", async () => {
  const { s } = await seed();
  const hk = await login(s, "hk");
  assert.equal((await post(s, hk, "/api/hk/daily-report", { date: "29-10-2026" })).status, 400);
  assert.equal((await post(s, hk, "/api/hk/daily-report", { date: "2999-01-01" })).status, 400);
});

test("daily report: totals, per-coord and per-leader attribution", async () => {
  const { s, c1, leader, ppl } = await seed();
  const day = daysAgo(3);
  await s.upsertChant({ person_id: ppl[0].id, entry_date: day, chanted: 1, source: "coordinator", marked_by: c1.id });
  await s.upsertChant({ person_id: ppl[1].id, entry_date: day, chanted: 1, source: "self", marked_by: null });
  await s.upsertChant({ person_id: ppl[2].id, entry_date: day, chanted: 0, source: "coordinator", marked_by: c1.id });
  await s.logTouchForPersonOnDate(ppl[2].id, day, c1.id);

  const body = await (await post(s, await login(s, "hk"), "/api/hk/daily-report", { date: day })).json();
  assert.equal(body.totals.members_chanted, 2);
  assert.equal(body.totals.follow_ups, 1);
  assert.equal(body.totals.coords_total, 2);
  assert.equal(body.totals.coords_active, 1);
  const one = body.per_coord.find(r => r.user_id === c1.id);
  assert.deepEqual([one.chants, one.follow_ups, one.leader_name], [1, 1, "Leader A"]);
  const la = body.per_leader.find(r => r.user_id === leader.id);
  assert.deepEqual([la.coords_total, la.coords_active, la.chants], [2, 1, 1]);
});

test("daily report: past day is saved, re-read from cache, and every click logged", async () => {
  const { s, c1, ppl } = await seed();
  const day = daysAgo(2);
  await s.upsertChant({ person_id: ppl[0].id, entry_date: day, chanted: 1, source: "coordinator", marked_by: c1.id });
  const hk = await login(s, "hk");
  const first = await (await post(s, hk, "/api/hk/daily-report", { date: day })).json();
  const second = await (await post(s, hk, "/api/hk/daily-report", { date: day })).json();
  assert.equal(first.meta.from_cache, false);
  assert.equal(second.meta.from_cache, true);
  assert.equal(second.totals.members_chanted, 1);
  assert.equal(second.meta.reports_today, 2);
});

test("daily report: today is never saved", async () => {
  const { s } = await seed();
  const hk = await login(s, "hk");
  await post(s, hk, "/api/hk/daily-report", { date: todayInTz() });
  const again = await (await post(s, hk, "/api/hk/daily-report", { date: todayInTz() })).json();
  assert.equal(again.meta.from_cache, false);
});

test("daily report: backfilling a past day's chant clears its saved copy", async () => {
  const { s, ppl } = await seed();
  const day = daysAgo(1);
  const hk = await login(s, "hk");
  const before = await (await post(s, hk, "/api/hk/daily-report", { date: day })).json();
  assert.equal(before.totals.members_chanted, 0);
  const res = await post(s, await login(s, "c1"), "/api/roll/chant", { person_id: ppl[0].id, chanted: true, entry_date: day });
  assert.equal(res.status, 200);
  const after = await (await post(s, hk, "/api/hk/daily-report", { date: day })).json();
  assert.equal(after.meta.from_cache, false);
  assert.equal(after.totals.members_chanted, 1);
});
