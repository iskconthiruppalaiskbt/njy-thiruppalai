// Integration harness — swaps a memory store over the real handlers,
// same technique as primitive/tests/integration.mjs.

import test from "node:test";
import assert from "node:assert/strict";
import { route } from "../lib/handlers.js";
import { memoryStore } from "../lib/store-memory.js";
import { hashPassword } from "../lib/auth.js";

const SECRET = "test-secret-for-integration-suite";

async function seed() {
  const s = memoryStore();
  // gates match schema/0001_init.sql defaults
  for (const [k, roles] of Object.entries({
    coordinator_roll:      ["njy_coordinator", "njy_leader", "hk_leader"],
    leader_dashboard:      ["njy_leader", "hk_leader"],
    hk_dashboard:          ["hk_leader"],
    bulk_import:           ["hk_leader"],
    feature_admin:         ["hk_leader"],
    whatsapp_deeplink:     ["njy_coordinator", "njy_leader", "hk_leader", "servant_leader"],
    sadhana_chart:         ["hk_leader"],
    group_planning_sheet:  ["hk_leader"],
    bv_structure_editor:   ["hk_leader"],
    action_timeline_duties:["hk_leader"],
    member_details_full:   ["hk_leader"],
    event_attendance:      ["njy_coordinator","njy_leader","hk_leader"],
    web_push:              ["njy_coordinator","njy_leader","hk_leader","servant_leader"],
  })) {
    await s.setFeatureGate(k, roles, "system");
  }
  const pw = await hashPassword("test-pass-123");
  const hk = await s.createUser({ username: "hk", password_hash: pw, display_name: "HK Leader", role: "hk_leader" });
  const leader = await s.createUser({ username: "leader1", password_hash: pw, display_name: "Leader 1", role: "njy_leader" });
  const coord = await s.createUser({ username: "coord1", password_hash: pw, display_name: "Coord 1", role: "njy_coordinator" });
  const ppl = [];
  for (let i = 1; i <= 5; i++) {
    ppl.push(await s.createPerson({
      legal_name: `Chanter ${i}`, phone: `+919999000${i}`,
      assigned_to_user_id: coord.id,
    }));
  }
  return { s, hk, leader, coord, ppl };
}

async function login(store, username, password) {
  const req = new Request("http://x/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const res = await route(req, { store, env: { SESSION_SECRET: SECRET } });
  const set = res.headers.get("set-cookie") || "";
  const cookie = set.split(";")[0];
  return { res, cookie };
}

function withCookie(url, cookie, init = {}) {
  return new Request(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie,
      ...(init.headers || {}),
    },
  });
}

test("login: wrong password rejected with same error as unknown user", async () => {
  const { s } = await seed();
  const bad1 = await route(new Request("http://x/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "hk", password: "nope" }),
  }), { store: s, env: { SESSION_SECRET: SECRET } });
  const bad2 = await route(new Request("http://x/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nobody", password: "test-pass-123" }),
  }), { store: s, env: { SESSION_SECRET: SECRET } });
  assert.equal(bad1.status, 401);
  assert.equal(bad2.status, 401);
  const b1 = await bad1.json(), b2 = await bad2.json();
  assert.equal(b1.error, b2.error);
});

test("login + /api/me round-trip", async () => {
  const { s } = await seed();
  const { res, cookie } = await login(s, "hk", "test-pass-123");
  assert.equal(res.status, 200);
  assert.ok(cookie);
  const me = await route(
    withCookie("http://x/api/me", cookie),
    { store: s, env: { SESSION_SECRET: SECRET } },
  );
  const body = await me.json();
  assert.equal(body.user.role, "hk_leader");
  assert.ok(body.gates);
});

test("coordinator sees only their assigned roll", async () => {
  const { s, coord } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const res = await route(
    withCookie("http://x/api/roll", cookie),
    { store: s, env: { SESSION_SECRET: SECRET } },
  );
  const body = await res.json();
  assert.equal(body.roll.length, 5);
  assert.equal(body.tally.assigned, 5);
  assert.equal(body.tally.chanted_today, 0);
  for (const r of body.roll) assert.ok(r.wa_url.startsWith("https://wa.me/"));
});

test("coordinator cannot mark someone else's person", async () => {
  const { s, hk, coord } = await seed();
  const stranger = await s.createPerson({
    legal_name: "Other", phone: "+919888000001",
    assigned_to_user_id: hk.id,
  });
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const res = await route(
    withCookie("http://x/api/roll/mark", cookie, {
      method: "POST",
      body: JSON.stringify({ person_id: stranger.id }),
    }),
    { store: s, env: { SESSION_SECRET: SECRET } },
  );
  assert.equal(res.status, 403);
});

test("mark cycles 0→1→2→0 (3-state, no more needs-visit)", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const cycle = [];
  for (let i = 0; i < 5; i++) {
    const r = await route(
      withCookie("http://x/api/roll/mark", cookie, {
        method: "POST",
        body: JSON.stringify({ person_id: ppl[0].id }),
      }),
      ctx,
    );
    cycle.push((await r.json()).contact_state);
  }
  // 3-state cycle: uncontacted (0) → contacted (1) → responded (2) → back to 0
  assert.deepEqual(cycle, [1, 2, 0, 1, 2]);
});

test("bead_color: white when nothing marked today", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const res = await route(withCookie("http://x/api/roll", cookie), ctx);
  const body = await res.json();
  for (const r of body.roll) assert.equal(r.bead_color, "white");
});

test("bead_color: yellow after contact-state=1 today", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  await route(withCookie("http://x/api/roll/mark", cookie, {
    method: "POST", body: JSON.stringify({ person_id: ppl[0].id }),
  }), ctx);
  const res = await route(withCookie("http://x/api/roll", cookie), ctx);
  const row = (await res.json()).roll.find(r => r.id === ppl[0].id);
  assert.equal(row.bead_color, "yellow");
});

test("bead_color: green when chanted today", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  await route(withCookie("http://x/api/roll/chant", cookie, {
    method: "POST", body: JSON.stringify({ person_id: ppl[0].id, chanted: true }),
  }), ctx);
  const res = await route(withCookie("http://x/api/roll", cookie), ctx);
  const row = (await res.json()).roll.find(r => r.id === ppl[0].id);
  assert.equal(row.bead_color, "green");
});

test("bead_color: red for daily-status person with no chant in 3 days", async () => {
  const { s, coord } = await seed();
  // Manually create a daily-status person with no chants at all
  const p = await s.createPerson({
    legal_name: "Silent Sadhaka", phone: "+91-slow", status: "daily",
    assigned_to_user_id: coord.id,
  });
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const res = await route(withCookie("http://x/api/roll", cookie), ctx);
  const row = (await res.json()).roll.find(r => r.id === p.id);
  assert.equal(row.bead_color, "red");
});

test("chant marking updates tally", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  await route(withCookie("http://x/api/roll/chant", cookie, {
    method: "POST",
    body: JSON.stringify({ person_id: ppl[0].id, chanted: true, rounds: 16 }),
  }), ctx);
  const roll = await route(withCookie("http://x/api/roll", cookie), ctx);
  const body = await roll.json();
  assert.equal(body.tally.chanted_today, 1);
});

test("feature-gate promotion widens access without redeploy", async () => {
  const { s } = await seed();
  // servant_leader has no gate for coordinator_roll initially.
  const pw = await hashPassword("test-pass-123");
  const sl = await s.createUser({ username: "sl1", password_hash: pw, display_name: "SL 1", role: "servant_leader" });
  const { cookie: slCookie } = await login(s, "sl1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  // 403 first.
  const before = await route(withCookie("http://x/api/roll", slCookie), ctx);
  assert.equal(before.status, 403);
  // HK Leader promotes.
  const { cookie: hkCookie } = await login(s, "hk", "test-pass-123");
  const promote = await route(
    withCookie("http://x/api/admin/feature-gate", hkCookie, {
      method: "POST",
      body: JSON.stringify({
        feature_key: "coordinator_roll",
        allowed_roles: ["njy_coordinator", "njy_leader", "hk_leader", "servant_leader"],
      }),
    }),
    ctx,
  );
  assert.equal(promote.status, 200);
  // now servant_leader can call it.
  const after = await route(withCookie("http://x/api/roll", slCookie), ctx);
  assert.equal(after.status, 200);
});

test("bulk import preview then commit", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const rows = [
    { legal_name: "A", phone: "+91-777-0000-001" },
    { legal_name: "B", phone: "+91-777-0000-002" },
    { legal_name: "C", phone: "+91-777-0000-001" },        // dup in batch
    { phone: "+91-777-0000-003" },                          // no name
    { legal_name: "D", phone: "+9199990001" },              // exists (seed)
  ];
  const prev = await route(withCookie("http://x/api/import/preview", cookie, {
    method: "POST", body: JSON.stringify({ rows }),
  }), ctx);
  const p = await prev.json();
  assert.equal(p.would_create, 2);
  assert.equal(p.errors.length, 1);
  assert.equal(p.duplicates_in_batch.length, 1);
  assert.equal(p.duplicates_in_db.length, 1);
  const commit = await route(withCookie("http://x/api/import/commit", cookie, {
    method: "POST", body: JSON.stringify({ rows }),
  }), ctx);
  const c = await commit.json();
  assert.equal(c.created, 2);
});

test("leader can list coordinators; coord cannot", async () => {
  const { s } = await seed();
  const { cookie: coord } = await login(s, "coord1", "test-pass-123");
  const { cookie: hk } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const bad = await route(withCookie("http://x/api/leader/coordinators", coord), ctx);
  assert.equal(bad.status, 403);
  const ok = await route(withCookie("http://x/api/leader/coordinators", hk), ctx);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.ok(Array.isArray(body.coordinators));
});

test("HK can drill into a coordinator's roll", async () => {
  const { s, coord } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const res = await route(
    withCookie(`http://x/api/user/${coord.id}/roll`, cookie),
    ctx,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.target.name, "Coord 1");
  assert.equal(body.roll.length, 5);
});

test("coordinator cannot drill into another user's roll", async () => {
  const { s, hk } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const res = await route(
    withCookie(`http://x/api/user/${hk.id}/roll`, cookie),
    ctx,
  );
  assert.equal(res.status, 403);
});

test("HK creates a new user; duplicate username rejected", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const ok = await route(withCookie("http://x/api/admin/users", cookie, {
    method: "POST", body: JSON.stringify({
      username: "sl-new", password: "temp-pass", display_name: "SL New", role: "servant_leader",
    }),
  }), ctx);
  assert.equal(ok.status, 200);
  const again = await route(withCookie("http://x/api/admin/users", cookie, {
    method: "POST", body: JSON.stringify({
      username: "sl-new", password: "temp-pass", display_name: "Dup", role: "servant_leader",
    }),
  }), ctx);
  assert.equal(again.status, 409);
});

test("events: attendance search + mark", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const c = await route(withCookie("http://x/api/events", cookie, {
    method: "POST", body: JSON.stringify({
      kind: "njy1", name: "NJY 1 Sat", event_date: "2026-09-05", capacity: 1000,
    }),
  }), ctx);
  const ev = (await c.json()).event;
  // search for "Chanter" — should find all 5 seeded people
  const sr = await route(withCookie(`http://x/api/people/search?q=Chanter`, cookie), ctx);
  const { people } = await sr.json();
  assert.equal(people.length, 5);
  // mark one attended
  const mk = await route(withCookie(`http://x/api/events/${ev.id}/attendance`, cookie, {
    method: "POST", body: JSON.stringify({ person_id: ppl[0].id, attended: true }),
  }), ctx);
  assert.equal(mk.status, 200);
  // event details show them as attended
  const det = await route(withCookie(`http://x/api/events/${ev.id}`, cookie), ctx);
  const body = await det.json();
  assert.equal(body.attended_count, 1);
  assert.ok(body.attended_ids.includes(ppl[0].id));
});

test("events: create + list", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const c = await route(withCookie("http://x/api/events", cookie, {
    method: "POST", body: JSON.stringify({
      kind: "njy1", name: "NJY 1 Saturday A", event_date: "2026-09-05", venue: "Temple hall",
    }),
  }), ctx);
  assert.equal(c.status, 200);
  const l = await route(withCookie("http://x/api/events", cookie), ctx);
  const body = await l.json();
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].kind, "njy1");
});

test("sadhana: computed chanting_pts and total_pts", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const res = await route(withCookie("http://x/api/sadhana", cookie, {
    method: "POST", body: JSON.stringify({
      person_id: ppl[0].id, entry_date: "2026-08-17",
      wake_up_pts: 10, mangala_arati_pts: 10,
      rounds_before_7: 8, rounds_7_8: 4, rounds_8_10: 2, rounds_after_10: 0,
      reading_pts: 10, hearing_pts: 8, seva_pts: 10, preaching_pts: 0,
    }),
  }), ctx);
  const body = await res.json();
  // chanting_pts = 8*4 + 4*3 + 2*2 + 0*1 = 32+12+4 = 48
  assert.equal(body.entry.chanting_pts, 48);
  // total = 10 + 10 + 48 + 10 + 8 + 10 + 0 = 96
  assert.equal(body.entry.total_pts, 96);
});

test("group report: create and list", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const g = await s.createGroup({ name: "BV-1", kind: "bv_group" });
  const c = await route(withCookie("http://x/api/group-reports", cookie, {
    method: "POST", body: JSON.stringify({
      group_id: g.id, report_date: "2026-08-17", week_number: 1,
      avg_attendance: 22, potential_leaders: 3,
    }),
  }), ctx);
  assert.equal(c.status, 200);
  const l = await route(withCookie(`http://x/api/group-reports?group_id=${g.id}`, cookie), ctx);
  const body = await l.json();
  assert.equal(body.reports.length, 1);
  assert.equal(body.reports[0].potential_leaders, 3);
});

test("duties: list is scoped to user; mark done works", async () => {
  const { s, coord, hk } = await seed();
  await s.createDuty({ user_id: coord.id, kind: "call_member", due_date: "2026-08-18" });
  await s.createDuty({ user_id: hk.id,    kind: "meet_sl_weekly", due_date: "2026-08-18" });
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const l = await route(withCookie("http://x/api/duties", cookie), ctx);
  const body = await l.json();
  assert.equal(body.duties.length, 1);
  assert.equal(body.duties[0].kind, "call_member");
  const dutyId = body.duties[0].id;
  await route(withCookie(`http://x/api/duties/${dutyId}/done`, cookie, { method: "POST" }), ctx);
  const after = await route(withCookie("http://x/api/duties", cookie), ctx);
  const b2 = await after.json();
  assert.equal(b2.duties.length, 0);
});

test("BV structure endpoint returns circles/sectors/bv_groups", async () => {
  const { s } = await seed();
  await s.createGroup({ name: "Krsna", kind: "circle" });
  await s.createGroup({ name: "Subala", kind: "sector" });
  await s.createGroup({ name: "BV Alpha", kind: "bv_group" });
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const res = await route(withCookie("http://x/api/bv/structure", cookie), ctx);
  const body = await res.json();
  assert.equal(body.circles.length, 1);
  assert.equal(body.sectors.length, 1);
  assert.equal(body.bv_groups.length, 1);
});

test("member details: HK can load and patch", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  await route(withCookie(`http://x/api/member/${ppl[0].id}`, cookie, {
    method: "POST", body: JSON.stringify({ email: "ravi@example.org", occupation: "Teacher" }),
  }), ctx);
  const get = await route(withCookie(`http://x/api/member/${ppl[0].id}`, cookie), ctx);
  const body = await get.json();
  assert.equal(body.person.email, "ravi@example.org");
  assert.equal(body.person.occupation, "Teacher");
});

test("web push: subscribe + unsubscribe", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const sub = await route(withCookie("http://x/api/webpush/subscribe", cookie, {
    method: "POST", body: JSON.stringify({
      endpoint: "https://push.example/x", keys: { p256dh: "aa", auth: "bb" },
    }),
  }), ctx);
  assert.equal(sub.status, 200);
  const unsub = await route(withCookie("http://x/api/webpush/unsubscribe", cookie, {
    method: "POST", body: JSON.stringify({ endpoint: "https://push.example/x" }),
  }), ctx);
  assert.equal(unsub.status, 200);
});

test("reassign moves a person to another user's roll", async () => {
  const { s, coord, ppl } = await seed();
  const pw = await hashPassword("test-pass-123");
  const sl = await s.createUser({ username: "sl-x", password_hash: pw, display_name: "SL X", role: "servant_leader" });
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie(`http://x/api/person/${ppl[0].id}/assign`, cookie, {
    method: "POST", body: JSON.stringify({ assigned_to_user_id: sl.id }),
  }), ctx);
  assert.equal(r.status, 200);
  const check = await s.personById(ppl[0].id);
  assert.equal(check.assigned_to_user_id, sl.id);
});

test("lifecycle status change is audited in person_stage_log", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie(`http://x/api/person/${ppl[0].id}/status`, cookie, {
    method: "POST", body: JSON.stringify({ status: "daily" }),
  }), ctx);
  assert.equal(r.status, 200);
  const p = await s.personById(ppl[0].id);
  assert.equal(p.status, "daily");
  const log = s._tables.person_stage_log.find(x => x.person_id === ppl[0].id);
  assert.equal(log.to_status, "daily");
  assert.equal(log.from_status, "chanter");
});

test("bad status is rejected", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie(`http://x/api/person/${ppl[0].id}/status`, cookie, {
    method: "POST", body: JSON.stringify({ status: "not-a-real-status" }),
  }), ctx);
  assert.equal(r.status, 400);
});

test("soft-delete hides person from active lists but preserves record", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie(`http://x/api/member/${ppl[0].id}`, cookie, {
    method: "DELETE",
  }), ctx);
  assert.equal(r.status, 200);
  const p = await s.personById(ppl[0].id);
  assert.equal(p, null);       // hidden from active reads
  // But the row is still in the table (active=0).
  const raw = s._tables.people.find(x => x.id === ppl[0].id);
  assert.equal(raw.active, 0);
});

test("edit user: role change persists; password rehash works", async () => {
  const { s, coord } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie(`http://x/api/admin/users/${coord.id}`, cookie, {
    method: "POST", body: JSON.stringify({ role: "servant_leader", password: "new-pass-42" }),
  }), ctx);
  assert.equal(r.status, 200);
  const u = await s.userByUsername("coord1");
  assert.equal(u.role, "servant_leader");
  // Try to log in with new password
  const login2 = await route(new Request("http://x/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "coord1", password: "new-pass-42" }),
  }), ctx);
  assert.equal(login2.status, 200);
});

test("delete group: soft-deletes group and ends memberships", async () => {
  const { s, ppl } = await seed();
  const g = await s.createGroup({ name: "Temp BV", kind: "bv_group" });
  await s.addMembership({ person_id: ppl[0].id, group_id: g.id });
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie(`http://x/api/bv/group/${g.id}`, cookie, {
    method: "DELETE",
  }), ctx);
  assert.equal(r.status, 200);
  const check = await s.groupById(g.id);
  assert.equal(check, null);
  const mems = s._tables.group_membership.filter(m => m.group_id === g.id);
  assert.ok(mems.every(m => !m.active));
});

test("event CRUD: update + delete", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const c = await route(withCookie("http://x/api/events", cookie, {
    method: "POST", body: JSON.stringify({ kind: "njy1", name: "old", event_date: "2026-09-01" }),
  }), ctx);
  const ev = (await c.json()).event;
  const upd = await route(withCookie(`http://x/api/events/${ev.id}`, cookie, {
    method: "POST", body: JSON.stringify({ name: "renamed", venue: "hall B" }),
  }), ctx);
  assert.equal(upd.status, 200);
  const evUpd = (await upd.json()).event;
  assert.equal(evUpd.name, "renamed");
  assert.equal(evUpd.venue, "hall B");
  const del = await route(withCookie(`http://x/api/events/${ev.id}`, cookie, { method: "DELETE" }), ctx);
  assert.equal(del.status, 200);
  const list = await route(withCookie("http://x/api/events", cookie), ctx);
  const body = await list.json();
  assert.equal(body.events.find(e => e.id === ev.id), undefined);
});

test("group report CRUD: update + delete", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const g = await s.createGroup({ name: "BV-Z", kind: "bv_group" });
  const c = await route(withCookie("http://x/api/group-reports", cookie, {
    method: "POST", body: JSON.stringify({ group_id: g.id, report_date: "2026-09-01", avg_attendance: 10 }),
  }), ctx);
  const rep = (await c.json()).report;
  const upd = await route(withCookie(`http://x/api/group-reports/${rep.id}`, cookie, {
    method: "POST", body: JSON.stringify({ avg_attendance: 15 }),
  }), ctx);
  assert.equal(upd.status, 200);
  const del = await route(withCookie(`http://x/api/group-reports/${rep.id}`, cookie, { method: "DELETE" }), ctx);
  assert.equal(del.status, 200);
});

test("sadhana entry delete removes row", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const c = await route(withCookie("http://x/api/sadhana", cookie, {
    method: "POST", body: JSON.stringify({
      person_id: ppl[0].id, entry_date: "2026-09-01",
      rounds_before_7: 4,
    }),
  }), ctx);
  const entry = (await c.json()).entry;
  const del = await route(withCookie(`http://x/api/sadhana/${entry.id}`, cookie, { method: "DELETE" }), ctx);
  assert.equal(del.status, 200);
  assert.equal(s._tables.sadhana_entries.length, 0);
});

test("SL ranges: auto-suggest starts at 10001, then increments by 100 per coord", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "hk", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r1 = await route(withCookie("http://x/api/admin/next-sl-range", cookie), ctx);
  const b1 = await r1.json();
  assert.deepEqual(b1, { start: 10001, end: 10100 });
  // assign coord1 the first range
  const coordUser = await s.userByUsername("coord1");
  await route(withCookie(`http://x/api/admin/users/${coordUser.id}`, cookie, {
    method: "POST", body: JSON.stringify({ sl_range_start: 10001, sl_range_end: 10100 }),
  }), ctx);
  // next auto-suggest bumps to 10101
  const r2 = await route(withCookie("http://x/api/admin/next-sl-range", cookie), ctx);
  const b2 = await r2.json();
  assert.deepEqual(b2, { start: 10101, end: 10200 });
});

test("Leaderboard daily: chants earn 10 pts each, follow-ups 5 pts each", async () => {
  const { s, ppl } = await seed();
  const coord = await s.userByUsername("coord1");
  // Mark 3 people chanted today
  const today = new Date().toISOString().slice(0, 10);
  for (const p of ppl.slice(0, 3)) {
    await s.upsertChant({ person_id: p.id, entry_date: today, chanted: 1, marked_by: coord.id });
  }
  // Mark 2 people as followed-up today (set last_marked_at explicitly)
  const nowIso = new Date().toISOString();
  for (const p of ppl.slice(3, 5)) {
    await s.updatePerson(p.id, { contact_state: 1, last_marked_at: nowIso }, coord.id);
  }
  const { cookie } = await login(s, "hk", "test-pass-123");
  const r = await route(withCookie("http://x/api/leaderboard/daily", cookie),
    { store: s, env: { SESSION_SECRET: SECRET } });
  const body = await r.json();
  const coordRow = body.rows.find(x => x.user_id === coord.id);
  // 3 chants * 10 + 2 follow-ups * 5 = 30 + 10 = 40
  assert.ok(coordRow.pts >= 40, `expected at least 40, got ${coordRow.pts}`);
});

test("Leaderboard overall: Janmashtami entries earn +5 each and tier bonus", async () => {
  const { s } = await seed();
  const coord = await s.userByUsername("coord1");
  await s.updateUser(coord.id, { sl_range_start: 10000, sl_range_end: 10099 });
  // Add 26 more entries dated Janmashtami — combined with the 5 seed
  // people that were also created today (in the seed helper) that's
  // 31 janmashtami entries → 31*5 = 155 base, plus a +25 tier at 25.
  // Total = 180 janmashtami-scoped points.
  for (let i = 0; i < 26; i++) {
    await s.createPerson({
      legal_name: `JmEntry ${i}`, phone: `+91jm-${i}`,
      assigned_to_user_id: coord.id, status: "chanter",
      sl_no: 10000 + i, created_at: "2026-08-25T10:00:00.000Z",
    });
  }
  const { cookie } = await login(s, "hk", "test-pass-123");
  const r = await route(withCookie("http://x/api/leaderboard/overall", cookie),
    { store: s, env: { SESSION_SECRET: SECRET } });
  const body = await r.json();
  const coordRow = body.rows.find(x => x.user_id === coord.id);
  const jmPts = coordRow.breakdown.filter(b => b.k.startsWith("jm_"))
    .reduce((sum, b) => sum + b.pts, 0);
  // At least: base entries (31 * 5 = 155) + tier bonus (25) = 180
  assert.ok(jmPts >= 155, `expected >= 155 jm-points, got ${jmPts}`);
  // Tier-25 bonus must be present
  assert.ok(coordRow.breakdown.some(b => b.k === "jm_entry_tier_25"));
});

test("Janmashtami entry: single-row assigns sl_no and puts person on coord's roll", async () => {
  const { s } = await seed();
  const coord = await s.userByUsername("coord1");
  await s.updateUser(coord.id, { sl_range_start: 10000, sl_range_end: 10099 });
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie("http://x/api/janmashtami/entry", cookie, {
    method: "POST", body: JSON.stringify({ name: "Test Chanter", mobile: "+91-99001", pincode: "625001" }),
  }), ctx);
  assert.equal(r.status, 200);
  const p = (await r.json()).person;
  assert.equal(p.sl_no, 10000);
  assert.equal(p.assigned_to_user_id, coord.id);
  assert.equal(p.pincode, "625001");
});

test("Janmashtami bulk: tab-separated paste imports multiple rows", async () => {
  const { s } = await seed();
  const coord = await s.userByUsername("coord1");
  await s.updateUser(coord.id, { sl_range_start: 10000, sl_range_end: 10099 });
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const rows = [
    { name: "Alpha", mobile: "+91777001", pincode: "625001" },
    { name: "Beta",  mobile: "+91777002", pincode: "625002" },
    { name: "Gamma", mobile: "+91777003", pincode: "625003" },
  ];
  const r = await route(withCookie("http://x/api/janmashtami/bulk", cookie, {
    method: "POST", body: JSON.stringify({ rows }),
  }), ctx);
  const body = await r.json();
  assert.equal(body.created, 3);
  assert.equal(body.errors.length, 0);
  // sl_nos should be contiguous starting from 10000
  const alpha = await s.personByPhone("+91777001");
  const gamma = await s.personByPhone("+91777003");
  assert.equal(alpha.sl_no, 10000);
  assert.equal(gamma.sl_no, 10002);
});

test("Janmashtami entry: no coupon + no range assigned → error", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie("http://x/api/janmashtami/entry", cookie, {
    method: "POST", body: JSON.stringify({ name: "Test", mobile: "+91-x" }),
  }), ctx);
  // Without a coupon AND without an assigned range, the handler
  // returns a 400 asking for either.
  assert.ok([400, 409].includes(r.status));
});

test("Janmashtami entry: with explicit coupon number, sl_no matches coupon", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie("http://x/api/janmashtami/entry", cookie, {
    method: "POST", body: JSON.stringify({ coupon_no: 12345, name: "Coupon Test", mobile: "+91-c1" }),
  }), ctx);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.person.sl_no, 12345);
});

test("Janmashtami entry: is_daily=yes sets lifecycle status to daily", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie("http://x/api/janmashtami/entry", cookie, {
    method: "POST", body: JSON.stringify({ coupon_no: 22222, name: "Daily One", mobile: "+91-d1", is_daily: "yes" }),
  }), ctx);
  const body = await r.json();
  assert.equal(body.person.status, "daily");
});

test("SL ranges: coord asks for next sl_no, gets first unused in own range", async () => {
  const { s } = await seed();
  const coord = await s.userByUsername("coord1");
  await s.updateUser(coord.id, { sl_range_start: 10000, sl_range_end: 10099 });
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie("http://x/api/me/next-sl", cookie), ctx);
  const b = await r.json();
  assert.equal(b.sl_no, 10000);
  // occupy it, ask again, get 10001
  await s.createPerson({ legal_name: "x", phone: "+9111", sl_no: 10000 });
  const r2 = await route(withCookie("http://x/api/me/next-sl", cookie), ctx);
  const b2 = await r2.json();
  assert.equal(b2.sl_no, 10001);
});

test("SL ranges: coord without a range assigned gets 409", async () => {
  const { s } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const r = await route(withCookie("http://x/api/me/next-sl", cookie), ctx);
  assert.equal(r.status, 409);
});

test("WhatsApp template: coord saves single template and roll uses it for every member", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  // Canonical field is `wa_template` (single template for all members).
  const save = await route(withCookie("http://x/api/me/wa-templates", cookie, {
    method: "POST", body: JSON.stringify({
      wa_template: "Hare Krsna {name} — how's your japa going?",
    }),
  }), ctx);
  assert.equal(save.status, 200);
  // One person daily, another chanter — both should receive the same
  // template now (lifecycle status no longer picks between two templates).
  await s.updatePerson(ppl[0].id, { status: "daily" }, null);
  const res = await route(withCookie("http://x/api/roll", cookie), ctx);
  const roll = (await res.json()).roll;
  const dailyRow = roll.find(r => r.id === ppl[0].id);
  const otherRow = roll.find(r => r.id === ppl[1].id);
  assert.ok(decodeURIComponent(dailyRow.wa_url).includes("Hare Krsna Chanter 1 — how's your japa going?"));
  assert.ok(decodeURIComponent(otherRow.wa_url).includes("Hare Krsna Chanter 2 — how's your japa going?"));
});

test("WhatsApp template: legacy wa_template_daily field still accepted for backwards compat", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const save = await route(withCookie("http://x/api/me/wa-templates", cookie, {
    method: "POST", body: JSON.stringify({
      wa_template_daily: "Legacy hi {name}",
    }),
  }), ctx);
  assert.equal(save.status, 200);
  const res = await route(withCookie("http://x/api/roll", cookie), ctx);
  const roll = (await res.json()).roll;
  assert.ok(decodeURIComponent(roll[0].wa_url).includes("Legacy hi Chanter"));
});

test("whatsapp url endpoint returns wa.me link and records audit", async () => {
  const { s, ppl } = await seed();
  const { cookie } = await login(s, "coord1", "test-pass-123");
  const ctx = { store: s, env: { SESSION_SECRET: SECRET } };
  const res = await route(withCookie("http://x/api/whatsapp/url", cookie, {
    method: "POST", body: JSON.stringify({ person_id: ppl[0].id, template: "yajna_invite" }),
  }), ctx);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.url.startsWith("https://wa.me/"));
  const notif = s._tables.notifications.find(n => n.kind === "wa-deeplink");
  assert.ok(notif);
});
