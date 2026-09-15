// Storage-agnostic request router. Every handler receives { store, env,
// user } and speaks only to the store interface — never touches D1
// directly. Tests drive route() with a memory store, matching the
// pattern in primitive/tests/integration.mjs.

import {
  hashPassword, verifyPassword, signSession, verifySession,
  parseCookies, sessionCookieHeader, clearSessionCookieHeader,
  SESSION_COOKIE,
} from "./auth.js";
import { requireFeature, canAccess, isValidRole } from "./rbac.js";
import { waDeepLink, WA_TEMPLATES } from "./notify.js";
import { scoreDailyForCoord, scoreOverallForCoord } from "./leaderboard.js";
import {
  computeLeaderBuckets, LEADER_TOUCH_RULES,
  TOUCH_NORM_DAILY, TOUCH_NORM_OVERALL,
} from "./leader_score.js";

// Fire-and-forget leader-touch logger. Never throws — a failed log
// row must NEVER block the real action (broadcast, save, contact, etc).
// Only fires when the caller is an njy_leader — HK Leader outranks the
// leaderboard and doesn't compete. Enforces the per-action cap:
//   scope "day"          — one row per (leader, action, day). ref_id="".
//   scope "day-target"   — one row per (leader, action, day, target),
//                          plus a per-day cap on total rows.
//   scope "target"       — one row per (leader, action, target). No cap.
async function awardLeaderTouch(store, user, actionKey, todayIso, refId) {
  try {
    if (!user || user.role !== "njy_leader") return { skipped: true };
    const rule = LEADER_TOUCH_RULES[actionKey];
    if (!rule) return { skipped: true, reason: "unknown_action" };
    if (rule.scope === "day-target" && rule.cap) {
      const already = await store.countLeaderTouchForDay(user.id, actionKey, todayIso);
      if (already >= rule.cap) return { skipped: true, reason: "cap_reached" };
    }
    const ref = rule.scope === "day" ? "" : String(refId || "");
    return await store.logLeaderTouch({
      leaderUserId: user.id, actionKey,
      points: rule.points, dayIso: todayIso, refId: ref,
    });
  } catch (err) {
    // Swallow — logging must never break the caller's request.
    return { skipped: true, reason: "error", error: String(err && err.message || err) };
  }
}

// Adjust a devotee's legal name into the form we want in WhatsApp
// greetings:
//   1. Strip a leading honorific prefix (HG / HH / Bhakta / Bhaktin /
//      Srila / Sri) so "HG Adideva Giridhari Dasa" becomes just
//      "Adideva Giridhari Dasa".
//   2. Replace initiated-name suffixes with a form of address:
//        "Devi Dasi"    → "Mataji"   (checked BEFORE "Dasi" alone)
//        "Dasi"         → "Mataji"
//        "Dasa" / "Das" → "Prabhu"
//      Match is case-insensitive; only whole-word suffixes are touched,
//      so "Dasarath" or "Dasi" embedded inside a longer word won't fire.
// A pre-initiate ("Anand") returns unchanged.
export function honorificAdjust(name) {
  if (!name) return "";
  let out = String(name).trim();
  // 1. Strip leading prefixes. Loop so "HG Bhakta X" collapses cleanly.
  const PREFIX_RE = /^(?:HG|HH|Srila|Sri|Bhakta|Bhaktin)\b[.\s]+/i;
  while (PREFIX_RE.test(out)) out = out.replace(PREFIX_RE, "");
  // 2. Suffix swap. Order matters — "Devi Dasi" must win over "Dasi".
  if (/\bDevi\s+Dasi\b/i.test(out)) {
    out = out.replace(/\bDevi\s+Dasi\b/i, "Mataji");
  } else if (/\bDasi\b/i.test(out)) {
    out = out.replace(/\bDasi\b/i, "Mataji");
  } else if (/\b(?:Dasa|Das)\b/i.test(out)) {
    out = out.replace(/\b(?:Dasa|Das)\b/i, "Prabhu");
  }
  return out.replace(/\s+/g, " ").trim();
}

// Pick the WhatsApp message text for a person, given the coordinator
// that owns them. There is ONE template per coord (stored in the
// wa_template_daily column for historical reasons — see the
// /api/me/wa-templates handler below); it applies to every member on
// the roll regardless of lifecycle status. Falls back to the built-in
// phrasing when the coord hasn't set one. Runs {name} interpolation.
//
// The substituted value is the FULL legal name run through
// honorificAdjust(), so "HG Krishna Dasa" reads "Krishna Prabhu" in the
// message body and "Radha Devi Dasi" reads "Radha Mataji".
function waTextFor(person, coord) {
  const custom = coord?.wa_template_daily;
  const filled = honorificAdjust(person.legal_name || "");
  const template = (custom && String(custom).trim())
    ? String(custom)
    // Fallback default already interpolates the name — feed it the
    // honorific-adjusted form directly.
    : WA_TEMPLATES.reminder(filled);
  // Case-insensitive placeholder — {name}, {Name}, {NAME}, {NaMe} all resolve.
  return template.replace(/\{name\}/gi, filled);
}
import { nowIso, todayInTz } from "./ids.js";

// Compute the 5-color bead for a person on a given day.
//
//   red    — status='daily' but no chant in past 3 days (needs attention)
//   green  — chanted today
//   orange — coord marked "responded" today (contact_state=2, last_marked_at is today)
//   yellow — coord marked "contacted" today (contact_state=1, last_marked_at is today)
//   white  — fresh, nothing marked today
//
// Red overrides everything. Green overrides yellow/orange/white. The
// bead effectively resets each new day because we require
// last_marked_at to be within today for yellow/orange to show.
function beadColorFor(person, chantedToday, chantedInLast3Days, todayIso) {
  if ((person.status === "daily") && !chantedInLast3Days) return "red";
  if (chantedToday) return "green";
  const lastMarked = person.last_marked_at ? String(person.last_marked_at).slice(0, 10) : null;
  if (lastMarked === todayIso) {
    if (person.contact_state === 2) return "orange";
    if (person.contact_state === 1) return "yellow";
  }
  return "white";
}

// Since we only need chant history within a 3-day window, this helper
// derives the ISO date exactly N days before todayIso (inclusive).
function daysAgoIso(todayIso, n) {
  const d = new Date(todayIso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// Explicit charset=utf-8 on JSON responses. Cloudflare Workers already
// UTF-8-encodes JSON.stringify output, but some downstream clients (and
// caches) fall back to Latin-1 without an explicit charset, which mangles
// emojis in wa_template_* text round-tripping through /api/me and
// /api/me/wa-templates.
const json = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
});
const bad = (status, message, extras = {}) =>
  json({ error: message, ...extras }, { status });

const routes = [];
function reg(method, pattern, handler, opts = {}) {
  routes.push({ method, pattern, handler, opts });
}

function matchPath(pattern, pathname) {
  const p = pattern.split("/").filter(Boolean);
  const q = pathname.split("/").filter(Boolean);
  if (p.length !== q.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(":")) params[p[i].slice(1)] = decodeURIComponent(q[i]);
    else if (p[i] !== q[i]) return null;
  }
  return params;
}

async function currentUser(request, ctx) {
  const cookies = parseCookies(request.headers.get("cookie") || "");
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const secret = ctx.env?.SESSION_SECRET;
  if (!secret) return null;
  const payload = await verifySession(token, secret);
  if (!payload) return null;
  const user = await ctx.store.userById(payload.userId);
  if (!user || !user.active) return null;
  return { ...user, password_hash: undefined };
}

export async function route(request, ctx) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = matchPath(r.pattern, url.pathname);
    if (!params) continue;
    // eager-load user for authed routes
    let user = null;
    if (r.opts.auth || r.opts.feature) {
      user = await currentUser(request, ctx);
      if (!user) return bad(401, "unauthorized");
      if (r.opts.feature) {
        try { await requireFeature(ctx.store, user.role, r.opts.feature); }
        catch (e) { return bad(403, "forbidden", { feature: r.opts.feature }); }
      }
    }
    try {
      return await r.handler(request, { ...ctx, url, params, user });
    } catch (err) {
      if (err && err.status) return bad(err.status, err.message);
      throw err;
    }
  }
  return bad(404, "not_found");
}

// ---------------------------------------------------- health / me ---
reg("GET", "/api/health", async () => json({ ok: true }));

reg("GET", "/api/me", async (req, ctx) => {
  const user = await currentUser(req, ctx);
  if (!user) return json({ user: null });
  const gates = await ctx.store.featureGates();
  // Resolve manager display name so the coord can see who their NJY Leader
  // is on their profile without needing admin/users access.
  if (user.manager_user_id) {
    const mgr = await ctx.store.userById(user.manager_user_id).catch(() => null);
    if (mgr) {
      user.manager_display_name = mgr.display_name || mgr.username;
      // CHANGE 5 — expose the leader's phone so the coord can DM them
      // via a WhatsApp button on My Roll.
      user.manager_phone = mgr.phone || null;
    }
  }
  // CHANGE 5 — expose the HK Leader's name+phone to non-HK roles so
  // "Contact HK" buttons can be rendered anywhere. There's only one
  // HK Leader per install, so a single lookup is fine.
  if (user.role !== "hk_leader") {
    try {
      const hks = await ctx.store.listUsersByRole("hk_leader");
      const hk = (hks || [])[0];
      if (hk) {
        user.hk_display_name = hk.display_name || hk.username;
        user.hk_phone = hk.phone || null;
      }
    } catch { /* silent — button just won't render */ }
  }
  return json({ user, gates });
});

// ---------------------------------------------------------- login ---
reg("POST", "/api/login", async (req, ctx) => {
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) return bad(400, "missing_credentials");
  const user = await ctx.store.userByUsername(username);
  // Return the same error whether or not the account exists (primitive §7).
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return bad(401, "invalid_credentials");
  }
  if (!user.active) return bad(401, "invalid_credentials");
  const secret = ctx.env?.SESSION_SECRET;
  if (!secret) return bad(500, "session_secret_missing");
  const token = await signSession({ userId: user.id, role: user.role }, secret);
  await ctx.store.updateUser(user.id, { last_login_at: nowIso() });
  return json({ user: { ...user, password_hash: undefined } }, {
    headers: { "set-cookie": sessionCookieHeader(token) },
  });
});

// The signed-in user updates their own WhatsApp templates. Kept
// separate from the HK-only user-editor so any coord can save their
// own copy without needing admin_feature access.
// Signed-in user changes their own password. Requires the current
// password so a stolen session can't lock the real user out.
reg("POST", "/api/me/password", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "settings_change_password");
  const body = await req.json().catch(() => ({}));
  const { current_password, new_password } = body;
  if (!current_password || !new_password) return bad(400, "both_passwords_required");
  if (String(new_password).length < 6) return bad(400, "password_too_short");
  const me = await ctx.store.userByUsername(ctx.user.username);
  if (!me || !(await verifyPassword(current_password, me.password_hash))) {
    return bad(401, "wrong_current_password");
  }
  const password_hash = await hashPassword(new_password);
  await ctx.store.updateUser(ctx.user.id, { password_hash });
  return json({ ok: true });
}, { auth: true });

// Single-template model: coord edits ONE message that gets sent to
// every member on their roll, regardless of lifecycle status. The
// canonical request field is `wa_template`; it maps to the existing
// `wa_template_daily` DB column (renaming the column would need a
// migration and the column is already populated for many users, so we
// reuse it as the single-template slot). Older clients that still
// POST wa_template_daily / wa_template_nondaily continue to work —
// wa_template_nondaily is accepted but no longer read by waTextFor.
reg("POST", "/api/me/wa-templates", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "settings_wa_templates");
  const body = await req.json().catch(() => ({}));
  const patch = {};
  if (typeof body.wa_template === "string") patch.wa_template_daily = body.wa_template;
  else if (typeof body.wa_template_daily === "string") patch.wa_template_daily = body.wa_template_daily;
  if (typeof body.wa_template_nondaily === "string") patch.wa_template_nondaily = body.wa_template_nondaily;
  if (!Object.keys(patch).length) return bad(400, "no_templates");
  await ctx.store.updateUser(ctx.user.id, patch);
  return json({ ok: true });
}, { auth: true });

// Persist the coord/leader's own WhatsApp group invite link + name.
// Both fields nullable — clearing means "I don't use a group". Link
// is stored raw (chat.whatsapp.com/xxx) and rendered as-is by the UI.
reg("POST", "/api/me/wa-group", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "settings_wa_group_link");
  const body = await req.json().catch(() => ({}));
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "wa_group_link")) {
    const v = body.wa_group_link;
    patch.wa_group_link = v == null || v === "" ? null : String(v).trim();
  }
  if (Object.prototype.hasOwnProperty.call(body, "wa_group_name")) {
    const v = body.wa_group_name;
    patch.wa_group_name = v == null || v === "" ? null : String(v).trim();
  }
  if (!Object.keys(patch).length) return bad(400, "no_fields");
  await ctx.store.updateUser(ctx.user.id, patch);
  // Leader Touch: leader saved/updated their coord-group WA — award
  // once per day. Silent no-op for non-leaders.
  const today = todayInTz(ctx.env?.APP_TZ);
  await awardLeaderTouch(ctx.store, ctx.user, "wa_group_saved_daily", today);
  return json({ ok: true, ...patch });
}, { auth: true });

reg("POST", "/api/logout", async () => {
  return json({ ok: true }, { headers: { "set-cookie": clearSessionCookieHeader() } });
});

// ------------------------------------------------- coordinator roll ---
// Return the roll of people assigned to the calling user, with each
// person's contact_state, today's chant mark, and a ready wa.me URL.
reg("GET", "/api/roll", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "coordinator_roll");
  const people = await ctx.store.peopleAssignedTo(ctx.user.id);
  const today = todayInTz(ctx.env?.APP_TZ);
  const threeDaysAgo = daysAgoIso(today, 2);   // inclusive of today = 3 days
  const coord = ctx.user;   // the caller IS the coordinator for this endpoint
  // Last-chanted-date map: one bulk query over a 60-day window is far
  // cheaper than N per-person MAX() calls and covers the vast majority
  // of live daily chanters. Persons who haven't chanted in 60 days get
  // null (CSV export renders as blank).
  const chantWindowStart = daysAgoIso(today, 59);
  const chantRows = people.length
    ? await ctx.store.chantDatesForPersonIdsBetween(
        people.map(p => p.id), chantWindowStart, today)
    : [];
  const lastChantMap = new Map();
  for (const r of chantRows) {
    const prev = lastChantMap.get(r.person_id);
    if (!prev || r.entry_date > prev) lastChantMap.set(r.person_id, r.entry_date);
  }
  const rows = await Promise.all(people.map(async (p) => {
    const chant = await ctx.store.chantOnDate(p.id, today);
    const chantedToday = !!(chant && chant.chanted);
    const recentChant = chantedToday
      ? true
      : await ctx.store.hasChantedSince(p.id, threeDaysAgo);
    return {
      id: p.id,
      name: p.legal_name,
      phone: p.phone,
      sl_no: p.sl_no || null,
      pincode: p.pincode || null,
      status: p.status,
      contact_state: p.contact_state || 0,
      notes: p.notes || "",
      last_marked_at: p.last_marked_at,
      last_chanted_date: lastChantMap.get(p.id) || null,
      chanted_today: chantedToday,
      bead_color: beadColorFor(p, chantedToday, recentChant, today),
      wa_url: waDeepLink(p.phone, waTextFor(p, coord)),
    };
  }));
  const tally = {
    assigned: rows.length,
    followed_up: rows.filter(r => r.contact_state === 1).length,
    responded:   rows.filter(r => r.contact_state === 2).length,
    needs_visit: rows.filter(r => r.contact_state === 3).length,
    chanted_today: rows.filter(r => r.chanted_today).length,
  };
  return json({ roll: rows, tally, today });
}, { auth: true });

// Care moments — surfacing for a coord's Roll page. Groups the
// coord's daily-committed chanters by the outreach action needed:
//   • red — missed 3+ consecutive days (needs personal check-in)
//   • amber — missed 2 days (gentle nudge)
//   • milestone — hit a streak (7 / 14 / 30 consecutive chant days)
// Each item includes a pre-built WA template + a ready wa_url so the
// coord can tap once and send a personalised message.
reg("GET", "/api/roll/care-moments", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "coordinator_roll");
  await requireFeature(ctx.store, ctx.user.role, "myroll_care_moments_panel");
  const people = await ctx.store.peopleAssignedTo(ctx.user.id);
  const today = todayInTz(ctx.env?.APP_TZ);
  const coord = ctx.user;
  const daysBetween = (a, b) => {
    const [y1, m1, d1] = a.split("-").map(Number);
    const [y2, m2, d2] = b.split("-").map(Number);
    return Math.floor((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  };

  const missed_3_plus = [], missed_2 = [], milestones = [];
  const dailyPeople = people.filter(p => p.status === "daily");

  // ONE bulk query for the whole 60-day window (streak needs up to 60).
  // Bucket client-side into a Map<person_id, Set<entry_date>>.
  // Replaces up to N*90 chantOnDate subrequests that blew the Workers cap.
  const streakWindowStart = daysAgoIso(today, 59);
  const dailyIds = dailyPeople.map(p => p.id);
  const chantRows = dailyIds.length
    ? await ctx.store.chantDatesForPersonIdsBetween(dailyIds, streakWindowStart, today)
    : [];
  const chantMap = new Map();
  for (const r of chantRows) {
    let s = chantMap.get(r.person_id);
    if (!s) { s = new Set(); chantMap.set(r.person_id, s); }
    s.add(r.entry_date);
  }

  for (const p of dailyPeople) {
    const dates = chantMap.get(p.id) || new Set();

    // Streak: count consecutive days back from today with chanted=1
    let streak = 0;
    for (let i = 0; i < 60; i++) {
      if (dates.has(daysAgoIso(today, i))) streak += 1;
      else break;
    }
    // Days since last chant — walk back within 30d window (else capped 30)
    let daysSince = 30;
    for (let i = 0; i < 30; i++) {
      if (dates.has(daysAgoIso(today, i))) { daysSince = i; break; }
    }

    const firstName = (p.legal_name || "").split(" ")[0] || p.legal_name;
    const wa = (text) => waDeepLink(p.phone, text);

    if (daysSince !== null && daysSince >= 3) {
      const msg = `Hare Krsna ${firstName} Prabhu 🌸\n\nI noticed you haven't chanted for a few days.\nWhatever's going on, Krsna is always with you.\nEven one round today would make me so happy 🙏\n\nHare Krsna.`;
      missed_3_plus.push({
        id: p.id, name: p.legal_name, phone: p.phone,
        days_missed: daysSince, template: msg, wa_url: wa(msg),
      });
    } else if (daysSince === 2) {
      const msg = `Hare Krsna ${firstName}! 🌸\n\nMissed you yesterday. Everything OK?\nA quick round today will make the day beautiful 🙏`;
      missed_2.push({
        id: p.id, name: p.legal_name, phone: p.phone,
        days_missed: 2, template: msg, wa_url: wa(msg),
      });
    }

    // Milestones — celebrate 7 / 14 / 30 / 60 consecutive-day streaks
    // (only surface the day AFTER the milestone is hit, not every day
    //  after — check if today is the exact milestone day).
    if ([7, 14, 30, 60].includes(streak)) {
      const msg = `Hare Krsna ${firstName} Prabhu! 🌸\n\n${streak} days of consistent chanting! 🎉\nKrsna is smiling on your sadhana. Please keep going 🙏\n\nHare Krsna.`;
      milestones.push({
        id: p.id, name: p.legal_name, phone: p.phone,
        streak_days: streak, template: msg, wa_url: wa(msg),
      });
    }
  }
  return json({
    today,
    counts: { missed_3_plus: missed_3_plus.length, missed_2: missed_2.length, milestones: milestones.length },
    missed_3_plus, missed_2, milestones,
  });
}, { auth: true });

// Cycle a person's contact_state 0→1→2→3→0. Server verifies the
// caller owns this person's roll.
reg("POST", "/api/roll/mark", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "coordinator_roll");
  const body = await req.json().catch(() => ({}));
  const { person_id, contact_state } = body;
  if (!person_id) return bad(400, "person_id_required");
  const person = await ctx.store.personById(person_id);
  if (!person) return bad(404, "person_not_found");
  if (
    person.assigned_to_user_id !== ctx.user.id &&
    ctx.user.role !== "hk_leader" &&
    ctx.user.role !== "njy_leader"
  ) {
    return bad(403, "not_your_roll");
  }
  // Cycle is now 3-state (white/yellow/orange). Red and green are
  // derived server-side; tapping the bead only advances the coord's
  // contact_state.
  const next = Number.isInteger(contact_state)
    ? ((contact_state % 3) + 3) % 3
    : (((person.contact_state || 0) + 1) % 3);
  const now = nowIso();
  await ctx.store.updatePerson(person_id, {
    contact_state: next, last_marked_at: now, last_marked_by: ctx.user.id,
  }, ctx.user.id);
  return json({ person_id, contact_state: next, last_marked_at: now });
}, { auth: true });

// Broadcast queue's "Sent ✓" tap — the coord/leader confirms they hit
// Send in WhatsApp for this person, so we upgrade them to "contacted"
// (contact_state=1). Only upgrades from 0; never downgrades a person
// already at 2 (responded) — that state was set by an explicit tap on
// the bead earlier and carries more signal than a Sent-tap.
//
// Broadcast/WA-group is available to coord + leader + hk_leader (see
// CHANGE 3), so this endpoint accepts all three. Owners-of-roll are
// verified for coords; leader/hk can act on anyone in their scope.
reg("POST", "/api/roll/mark-contacted", async (req, ctx) => {
  const role = ctx.user.role;
  if (role !== "njy_coordinator" && role !== "njy_leader" && role !== "hk_leader") {
    return bad(403, "forbidden");
  }
  const body = await req.json().catch(() => ({}));
  const { person_id } = body;
  if (!person_id) return bad(400, "person_id_required");
  const person = await ctx.store.personById(person_id);
  if (!person) return bad(404, "person_not_found");
  if (role === "njy_coordinator" && person.assigned_to_user_id !== ctx.user.id) {
    return bad(403, "not_your_roll");
  }
  const result = await ctx.store.markContactedIfLower(person_id, ctx.user.id);
  if (!result.ok) return bad(404, result.reason || "not_found");
  return json({
    person_id,
    contact_state: result.contact_state,
    prior_contact_state: result.prior_contact_state,
    changed: result.changed,
  });
}, { auth: true });

// Leader Touch: the old POST /api/leader/contact-log route was removed —
// the mesh WA contact pill still opens wa.me as a plain deep link, but no
// points fire from it (no UI trigger was ever wired to this endpoint, and
// the contact_coord rule was dropped from LEADER_TOUCH_RULES).

// Leader Touch: leader marks themselves as attended at one event.
// +10 per event, unique per (leader, event). Simpler than round-
// tripping through /api/events/:id/attendance since a leader may not
// have a person_id, and we want the leader-side ledger.
reg("POST", "/api/leader/event-attend", async (req, ctx) => {
  if (ctx.user.role !== "njy_leader") return bad(403, "forbidden");
  const body = await req.json().catch(() => ({}));
  const { event_id } = body;
  if (!event_id) return bad(400, "event_id_required");
  const ev = await ctx.store.eventById(event_id);
  if (!ev) return bad(404, "event_not_found");
  const today = todayInTz(ctx.env?.APP_TZ);
  const r = await awardLeaderTouch(ctx.store, ctx.user, "event_attended", today, event_id);
  return json({ awarded: !!(r && r.inserted), reason: r && r.reason });
}, { auth: true });

// Leader Touch: leader fires broadcast to their coords. The broadcast
// itself is a client-side wa.me flow (leader taps once per coord in
// the queue), so we expose a marker endpoint that fires once on
// broadcast-open. +5 first time each day.
reg("POST", "/api/leader/broadcast-marker", async (req, ctx) => {
  if (ctx.user.role !== "njy_leader") return bad(403, "forbidden");
  const today = todayInTz(ctx.env?.APP_TZ);
  const r = await awardLeaderTouch(ctx.store, ctx.user, "broadcast_daily", today);
  return json({ awarded: !!(r && r.inserted), reason: r && r.reason });
}, { auth: true });

// Per-caller 3-bucket points breakdown. Only returns real numbers for
// an njy_leader; everyone else gets zeros so the UI can still call
// this uniformly.
reg("GET", "/api/leader/points-breakdown", async (req, ctx) => {
  if (ctx.user.role !== "njy_leader") {
    return json({
      applicable: false,
      today: todayInTz(ctx.env?.APP_TZ),
      buckets: null,
      touch_rows: [],
    });
  }
  const today = todayInTz(ctx.env?.APP_TZ);
  const [allCoords, chantedByCoord, followUpsByCoord, peopleByCoord, touchRows] = await Promise.all([
    ctx.store.listUsersByRole("njy_coordinator"),
    ctx.store.chantedCountByCoordOnDate(today),
    ctx.store.followUpsCountByCoordOnDate(today),
    ctx.store.peopleCountByCoord(),
    ctx.store.leaderTouchRowsForDay(ctx.user.id, today),
  ]);
  const myCoords = allCoords.filter(c => c.manager_user_id === ctx.user.id && c.active);
  // Same fast-path math as the leaders/daily board — see below.
  const coordPtsList = [];
  const coordActiveList = [];
  for (const c of myCoords) {
    const chants = chantedByCoord.get(c.id) || 0;
    const fups = followUpsByCoord.get(c.id) || 0;
    const assigned = peopleByCoord.get(c.id) || 0;
    let cp = chants * 10 + fups * 5;
    if (assigned > 0 && chants === assigned) cp += 50;
    coordPtsList.push(cp);
    coordActiveList.push(cp > 0);
  }
  const touchPts = touchRows.reduce((s, r) => s + (r.points || 0), 0);
  const buckets = computeLeaderBuckets({
    coordPtsList, coordActiveList,
    touchPts, touchNorm: TOUCH_NORM_DAILY,
  });
  return json({
    applicable: true,
    today,
    buckets,
    touch_rows: touchRows.map(r => ({
      action_key: r.action_key,
      label: (LEADER_TOUCH_RULES[r.action_key] || {}).label || r.action_key,
      points: r.points, ref_id: r.ref_id, awarded_at: r.awarded_at,
    })),
    rules: Object.entries(LEADER_TOUCH_RULES).map(([k, v]) => ({
      action_key: k, label: v.label, points: v.points, cap: v.cap, scope: v.scope,
    })),
  });
}, { auth: true });

// Log a daily chant for one person (coordinator-marked in P1).
reg("POST", "/api/roll/chant", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "coordinator_roll");
  const body = await req.json().catch(() => ({}));
  const { person_id, chanted = true, rounds, entry_date } = body;
  // Distinguish today-mark from past-date backfill so HK can revoke
  // backfill privileges independently.
  const today = todayInTz(ctx.env?.APP_TZ);
  await requireFeature(ctx.store, ctx.user.role,
    (entry_date && entry_date !== today)
      ? "myroll_mark_chanted_past_date"
      : "myroll_mark_chanted_today");
  if (!person_id) return bad(400, "person_id_required");
  const person = await ctx.store.personById(person_id);
  if (!person) return bad(404, "person_not_found");
  if (
    person.assigned_to_user_id !== ctx.user.id &&
    ctx.user.role !== "hk_leader" &&
    ctx.user.role !== "njy_leader"
  ) {
    return bad(403, "not_your_roll");
  }
  const date = entry_date || todayInTz(ctx.env?.APP_TZ);
  const row = await ctx.store.upsertChant({
    person_id, entry_date: date,
    chanted: chanted ? 1 : 0,
    rounds: rounds ?? null,
    source: "coordinator",
    marked_by: ctx.user.id,
  });
  return json({ chant: row });
}, { auth: true });

// Return the last N days of chant history for one person — used by
// the row-level "history" expander so the coord can back-fill a day
// they forgot to mark. Access: coord for their own people, higher
// tiers for anyone.
reg("GET", "/api/roll/:personId/history", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "myroll_history_strip");
  const person = await ctx.store.personById(ctx.params.personId);
  if (!person) return bad(404, "person_not_found");
  const higher = ["hk_leader","njy_leader","circle_servant","sector_servant","servant_leader"];
  if (person.assigned_to_user_id !== ctx.user.id && !higher.includes(ctx.user.role)) {
    return bad(403, "not_your_roll");
  }
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(60, Number(url.searchParams.get("days") || 14)));
  const today = todayInTz(ctx.env?.APP_TZ);
  // Walk from N-1 days ago through today, check each date.
  const rows = [];
  const startD = new Date(today + "T00:00:00Z");
  startD.setUTCDate(startD.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(startD);
    d.setUTCDate(d.getUTCDate() + i);
    const iso = d.toISOString().slice(0, 10);
    const c = await ctx.store.chantOnDate(person.id, iso);
    rows.push({ date: iso, chanted: !!(c && c.chanted), is_today: iso === today });
  }
  return json({
    person: { id: person.id, name: person.legal_name, status: person.status },
    history: rows,
  });
}, { auth: true });

reg("POST", "/api/roll/note", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "myroll_add_note");
  const body = await req.json().catch(() => ({}));
  const { person_id, notes } = body;
  if (!person_id) return bad(400, "person_id_required");
  const person = await ctx.store.personById(person_id);
  if (!person) return bad(404, "person_not_found");
  if (
    person.assigned_to_user_id !== ctx.user.id &&
    ctx.user.role !== "hk_leader" &&
    ctx.user.role !== "njy_leader"
  ) return bad(403, "not_your_roll");
  await ctx.store.updatePerson(person_id, { notes: String(notes || "") }, ctx.user.id);
  return json({ ok: true });
}, { auth: true });

// -------------------------------------------- HK / NJY dashboards ---
reg("GET", "/api/leader/coordinators", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "leader_dashboard");
  const all = await ctx.store.listUsersByRole("njy_coordinator");
  const coordinators = ctx.user.role === "hk_leader"
    ? all
    : all.filter(c => c.manager_user_id === ctx.user.id);
  const today = todayInTz(ctx.env?.APP_TZ);
  // Fast aggregate lookups instead of N×M loops. All 5 in parallel.
  const [peopleByCoord, dailyByCoord, chantedTodayDaily, consistent, chantedAll] = await Promise.all([
    ctx.store.peopleCountByCoord(),
    ctx.store.dailyChanterCountByCoord(),
    ctx.store.chantedTodayDailyByCoord(today),
    ctx.store.consistentDailyByCoord(today, 3),
    ctx.store.chantedCountByCoordOnDate(today),
  ]);
  const rows = coordinators.map((c) => {
    const dailyTotal = dailyByCoord.get(c.id) || 0;
    return {
      user_id: c.id, name: c.display_name,
      phone: c.phone || null,                        // for leader→coord wa.me broadcast
      assigned: peopleByCoord.get(c.id) || 0,        // whole roll size (chanters + daily)
      chanted_today: chantedAll.get(c.id) || 0,      // legacy field — anyone in roll who chanted
      // NEW SKJ-focused metrics:
      daily_chanted_today: chantedTodayDaily.get(c.id) || 0,   // Card 1 numerator
      daily_chanter_total: dailyTotal,                         // Card 1 & 2 denominator
      consistent_daily: consistent.get(c.id) || 0,             // Card 2 numerator (no 3-day miss)
      // Kept for backward compat with anything reading it:
      one_month_daily: consistent.get(c.id) || 0,
      target: 40,
      last_login_at: c.last_login_at,
    };
  });
  return json({ coordinators: rows });
}, { auth: true });

// NJY Leaders overview for HK Leader. Returns one row per NJY Leader
// with aggregate stats — coord count, sum of assigned chanters, sum
// chanted today, sum one-month daily, and a "coords active today" ratio
// that proxies follow-up engagement (a coord is "active" if at least
// one of their chanters was marked chanted today, i.e. the coord opened
// the app and did work).
reg("GET", "/api/hk/leaders", async (req, ctx) => {
  if (ctx.user.role !== "hk_leader") return bad(403, "forbidden");
  const today = todayInTz(ctx.env?.APP_TZ);
  // 6 aggregate queries total — was 30,000+ before (N leaders × M coords ×
  // K people × chantOnDate). Fits under Workers CPU limit at any scale.
  const [leaders, allCoords, peopleByCoord, chantedByCoord, dailyByCoord, monthlyByCoord] = await Promise.all([
    ctx.store.listUsersByRole("njy_leader"),
    ctx.store.listUsersByRole("njy_coordinator"),
    ctx.store.peopleCountByCoord(),
    ctx.store.chantedCountByCoordOnDate(today),
    ctx.store.dailyChanterCountByCoord(),
    ctx.store.oneMonthDailyCountByCoord(today),
  ]);
  const rows = leaders.map((l) => {
    const myCoords = allCoords.filter(c => c.manager_user_id === l.id && c.active);
    let assigned = 0, chantedToday = 0, oneMonthDaily = 0, dailyTotal = 0, activeCoords = 0;
    for (const c of myCoords) {
      const a = peopleByCoord.get(c.id) || 0;
      const ct = chantedByCoord.get(c.id) || 0;
      assigned += a;
      chantedToday += ct;
      if (ct > 0) activeCoords += 1;
      oneMonthDaily += monthlyByCoord.get(c.id) || 0;
      dailyTotal += dailyByCoord.get(c.id) || 0;
    }
    return {
      user_id: l.id, name: l.display_name || l.username, username: l.username,
      phone: l.phone || null,                          // for hk→leader wa.me broadcast
      coord_count: myCoords.length,
      active_coords_today: activeCoords,
      assigned, chanted_today: chantedToday,
      one_month_daily: oneMonthDaily, daily_chanter_total: dailyTotal,
      last_login_at: l.last_login_at,
    };
  });
  return json({ leaders: rows });
}, { auth: true });

// HK-only: bulk-assign a set of coordinators to a leader (sets their
// manager_user_id). Also accepts unassign=true to CLEAR the manager.
reg("POST", "/api/hk/leader/:leaderId/assign", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "hk_reassign_leader");
  const body = await req.json().catch(() => ({}));
  const coordIds = Array.isArray(body.coord_user_ids) ? body.coord_user_ids : [];
  const unassign = body.unassign === true;
  const leader = await ctx.store.userById(ctx.params.leaderId);
  if (!leader && !unassign) return bad(404, "leader_not_found");
  const target = unassign ? null : leader.id;
  for (const id of coordIds) {
    await ctx.store.updateUser(id, { manager_user_id: target }).catch(() => null);
  }
  return json({ updated: coordIds.length, target });
}, { auth: true });

reg("GET", "/api/hk/summary", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "hk_dashboard");
  const today = todayInTz(ctx.env?.APP_TZ);
  // Fetch all four numbers in parallel; each is a single aggregate query.
  // Was doing N*M sequential lookups — this cut load time by ~10x.
  const [total, leaders, coordinators, chanted] = await Promise.all([
    ctx.store.peopleCount(),
    ctx.store.listUsersByRole("njy_leader"),
    ctx.store.listUsersByRole("njy_coordinator"),
    ctx.store.countChantsOnDate(today),
  ]);
  return json({
    total_people: total,
    njy_leaders: leaders.length,
    njy_coordinators: coordinators.length,
    chanted_today: chanted,
    today,
  });
}, { auth: true });

// Drill-down: view another user's roll. Leaders/HK may view anyone;
// a coordinator can only view their OWN roll through this path (used
// by the event "Mark by coordinator" picker when a coord marks their
// own people's attendance).
reg("GET", "/api/user/:userId/roll", async (req, ctx) => {
  const isHk = ctx.user.role === "hk_leader";
  const isLeader = ctx.user.role === "njy_leader";
  const isSelf = ctx.params.userId === ctx.user.id;
  if (!isHk && !isLeader && !isSelf) return bad(403, "forbidden");
  const target = await ctx.store.userById(ctx.params.userId);
  if (!target) return bad(404, "user_not_found");
  const people = await ctx.store.peopleAssignedTo(target.id);
  const today = todayInTz(ctx.env?.APP_TZ);
  const threeDaysAgo = daysAgoIso(today, 2);
  // Bulk last-chanted-date lookup — mirrors /api/roll (see comment
  // there). Same 60-day window, same bucketing.
  const chantWindowStart = daysAgoIso(today, 59);
  const chantRows = people.length
    ? await ctx.store.chantDatesForPersonIdsBetween(
        people.map(p => p.id), chantWindowStart, today)
    : [];
  const lastChantMap = new Map();
  for (const r of chantRows) {
    const prev = lastChantMap.get(r.person_id);
    if (!prev || r.entry_date > prev) lastChantMap.set(r.person_id, r.entry_date);
  }
  // Drilling in as a leader — use the OWNED coordinator's templates,
  // not the leader's. WhatsApp messages go out in the coord's voice.
  const rows = await Promise.all(people.map(async (p) => {
    const chant = await ctx.store.chantOnDate(p.id, today);
    const chantedToday = !!(chant && chant.chanted);
    const recentChant = chantedToday
      ? true
      : await ctx.store.hasChantedSince(p.id, threeDaysAgo);
    return {
      id: p.id, name: p.legal_name, phone: p.phone,
      sl_no: p.sl_no || null,
      pincode: p.pincode || null,
      status: p.status, contact_state: p.contact_state || 0,
      notes: p.notes || "",
      last_marked_at: p.last_marked_at,
      last_chanted_date: lastChantMap.get(p.id) || null,
      chanted_today: chantedToday,
      bead_color: beadColorFor(p, chantedToday, recentChant, today),
      wa_url: waDeepLink(p.phone, waTextFor(p, target)),
    };
  }));
  return json({
    target: { id: target.id, name: target.display_name, role: target.role },
    roll: rows,
    tally: {
      assigned: rows.length,
      followed_up: rows.filter(r => r.contact_state === 1).length,
      responded:   rows.filter(r => r.contact_state === 2).length,
      needs_visit: rows.filter(r => r.contact_state === 3).length,
      chanted_today: rows.filter(r => r.chanted_today).length,
    },
    today,
  });
}, { auth: true });

// ------------------------------------------------------ admin users ---
// BUG 3: gate on the specific `admin_users` sub-gate (introduced in
// schema 0007), NOT the umbrella `feature_admin`. That aligns the API
// with the UI (which uses `can("admin_users")` for the Users sub-tab)
// and prevents any role that had `feature_admin` widened onto it (e.g.
// njy_leader in staging) from listing the user table.
reg("GET", "/api/admin/users", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "admin_users");
  const users = await ctx.store.listAllUsers();
  return json({ users: users.map(u => ({ ...u, password_hash: undefined })) });
}, { auth: true });

reg("POST", "/api/admin/users", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "admin_users");
  const body = await req.json().catch(() => ({}));
  const { username, password, display_name, role, phone, email, manager_username } = body;
  if (!username || !password || !display_name || !role) return bad(400, "missing_fields");
  if (!isValidRole(role)) return bad(400, "bad_role");
  const existing = await ctx.store.userByUsername(username);
  if (existing) return bad(409, "username_taken");
  const password_hash = await hashPassword(password);
  let manager_user_id = null;
  if (manager_username) {
    const mgr = await ctx.store.userByUsername(manager_username);
    if (!mgr) return bad(400, "manager_not_found", { manager_username });
    manager_user_id = mgr.id;
  }
  const u = await ctx.store.createUser({
    username, password_hash, display_name, role, phone, email, manager_user_id,
  });
  return json({ user: { ...u, password_hash: undefined } });
}, { auth: true });

// Bulk create coord/leader accounts from a pasted spreadsheet.
// Columns: username, password, display_name, phone, role, manager_username
// (manager_username optional — if provided, looks up an existing user
// with that username and links this new user as their subordinate).
reg("POST", "/api/admin/users/bulk", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "admin_users_bulk");
  const body = await req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const created = [], errors = [];
  // Pre-resolve manager usernames once
  const managerCache = new Map();
  for (const [i, row] of rows.entries()) {
    try {
      const { username, password, display_name, phone, role, manager_username } = row;
      if (!username || !password || !display_name || !role) {
        errors.push({ index: i, reason: "missing_fields", row }); continue;
      }
      if (!isValidRole(role)) {
        errors.push({ index: i, reason: "bad_role", role, row }); continue;
      }
      const exists = await ctx.store.userByUsername(username);
      if (exists) { errors.push({ index: i, reason: "username_taken", username }); continue; }
      let manager_user_id = null;
      if (manager_username) {
        if (!managerCache.has(manager_username)) {
          managerCache.set(manager_username, await ctx.store.userByUsername(manager_username));
        }
        const mgr = managerCache.get(manager_username);
        if (!mgr) { errors.push({ index: i, reason: "manager_not_found", manager_username }); continue; }
        manager_user_id = mgr.id;
      }
      const password_hash = await hashPassword(password);
      const u = await ctx.store.createUser({
        username, password_hash, display_name, role,
        phone: phone || null,
        manager_user_id,
      });
      created.push({ id: u.id, username });
    } catch (err) {
      errors.push({ index: i, reason: "error", message: String(err.message || err) });
    }
  }
  return json({ created, errors });
}, { auth: true });

reg("POST", "/api/admin/assign", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "feature_admin");
  const body = await req.json().catch(() => ({}));
  const { person_ids, user_id } = body;
  if (!Array.isArray(person_ids) || !user_id) return bad(400, "bad_body");
  const target = await ctx.store.userById(user_id);
  if (!target) return bad(404, "user_not_found");
  const r = await ctx.store.assignPeopleToUser(person_ids, user_id);
  return json(r);
}, { auth: true });

// -------------------------------------------- events / attendance ---
reg("GET", "/api/events", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "events_view_list");
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || undefined;
  const events = await ctx.store.listEvents({ kind });
  return json({ events });
}, { auth: true });

reg("POST", "/api/events", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "feature_admin");
  const body = await req.json().catch(() => ({}));
  const { kind, name, event_date, event_time, venue, capacity, batch_number } = body;
  if (!kind || !name || !event_date) return bad(400, "missing_fields");
  const ev = await ctx.store.createEvent({
    kind, name, event_date, event_time, venue, capacity, batch_number,
  });
  return json({ event: ev });
}, { auth: true });

reg("GET", "/api/events/:eventId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "event_attendance");
  const ev = await ctx.store.eventById(ctx.params.eventId);
  if (!ev) return bad(404, "event_not_found");
  const attendance = await ctx.store.attendanceForEvent(ev.id);
  const attendedIds = attendance.filter(a => a.attended).map(a => a.person_id);
  // Per-coordinator attendance breakdown (the "20/40 per group" view
  // from Plan 2). For each NJY coordinator, count how many of their
  // assigned chanters attended this event.
  const coords = await ctx.store.listUsersByRole("njy_coordinator");
  const attendedSet = new Set(attendedIds);
  const breakdown = [];
  for (const c of coords) {
    const roll = await ctx.store.peopleAssignedTo(c.id);
    const attendedFromRoll = roll.filter(p => attendedSet.has(p.id)).length;
    if (roll.length === 0) continue;
    breakdown.push({
      user_id: c.id, name: c.display_name,
      attended: attendedFromRoll, assigned: roll.length,
      target: 40,
    });
  }
  breakdown.sort((a, b) => b.attended - a.attended);
  return json({
    event: ev,
    attended_ids: attendedIds,
    attended_count: attendedIds.length,
    breakdown,
  });
}, { auth: true });

// Members-tab: single-shot list of every active person, tagged with the
// section that person falls into for the calling user. Sections:
//   "mine"       — coord: assigned_to_user_id === me;
//                  leader: assigned coord's manager_user_id === me;
//                  hk_leader: never returned as "mine".
//   "others"     — assigned to someone but not "mine".
//   "unassigned" — assigned_to_user_id IS NULL.
// Also returns the list of coords the caller is allowed to bulk-assign
// people TO (leader → their own coords; hk → every njy_coordinator;
// coord → empty, no bulk-assign for them).
reg("GET", "/api/members/list", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "members_tab");
  const [rows, allCoords] = await Promise.all([
    ctx.store.listAllPeopleWithAssignments(),
    ctx.store.listUsersByRole("njy_coordinator"),
  ]);
  const role = ctx.user.role;
  const meId = ctx.user.id;
  const people = rows.map((p) => {
    let section = "others";
    if (!p.assigned_to_user_id) section = "unassigned";
    else if (role === "hk_leader") section = "others";
    else if (role === "njy_coordinator") {
      section = p.assigned_to_user_id === meId ? "mine" : "others";
    } else if (role === "njy_leader") {
      section = p.assigned_coord_manager_id === meId ? "mine" : "others";
    }
    return {
      id: p.id, sl_no: p.sl_no || null,
      name: p.legal_name, phone: p.phone || null,
      pincode: p.pincode || null,
      gender: p.gender || null,
      assigned_to_user_id: p.assigned_to_user_id || null,
      assigned_coord_name: p.assigned_coord_name || null,
      section,
    };
  });
  // Coords the caller may assign people TO. Includes phone + pincode
  // (pincode drawn from the coord's linked person row when present) so
  // the client's gender-aware bulk-assign UI has everything it needs
  // without a second round-trip.
  const enrich = async (c) => {
    let pincode = null;
    if (c.person_id) {
      const p = await ctx.store.personById(c.person_id).catch(() => null);
      if (p && p.pincode) pincode = p.pincode;
    }
    return {
      id: c.id,
      display_name: c.display_name || c.username,
      phone: c.phone || null,
      pincode,
    };
  };
  let eligible_coords = [];
  if (role === "hk_leader") {
    eligible_coords = await Promise.all(allCoords.filter(c => c.active).map(enrich));
  } else if (role === "njy_leader") {
    eligible_coords = await Promise.all(
      allCoords.filter(c => c.active && c.manager_user_id === meId).map(enrich),
    );
  }
  return json({ people, eligible_coords });
}, { auth: true });

// Bulk-assign N people to ONE coordinator. Only leaders and HK Leader
// can call this. A leader may only pick a target coord that reports to
// them (matching /api/members/list's eligible_coords). Missing/other-
// coord targets return 403 to keep the leader's scope clean.
reg("POST", "/api/members/bulk-assign", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "members_tab");
  if (!["hk_leader", "njy_leader"].includes(ctx.user.role)) return bad(403, "forbidden");
  const body = await req.json().catch(() => ({}));
  const { person_ids, user_id } = body;
  if (!Array.isArray(person_ids) || !person_ids.length) return bad(400, "person_ids_required");
  if (!user_id) return bad(400, "user_id_required");
  const target = await ctx.store.userById(user_id);
  if (!target || target.role !== "njy_coordinator") return bad(404, "target_user_not_found");
  if (ctx.user.role === "njy_leader" && target.manager_user_id !== ctx.user.id) {
    return bad(403, "not_your_coord");
  }
  const r = await ctx.store.assignPeopleToUser(person_ids, user_id);
  return json(r);
}, { auth: true });

reg("GET", "/api/people/search", async (req, ctx) => {
  if (!["hk_leader", "njy_leader", "njy_coordinator"].includes(ctx.user.role)) {
    return bad(403, "forbidden");
  }
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  if (q.length < 2) return json({ people: [] });
  const rows = await ctx.store.searchPeople(q, 50);
  return json({
    people: rows.map(p => ({
      id: p.id, name: p.legal_name, phone: p.phone,
      pincode: p.pincode || null,
      sl_no: p.sl_no || null,
      status: p.status,
    })),
  });
}, { auth: true });

reg("POST", "/api/events/:eventId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "events_edit");
  const body = await req.json().catch(() => ({}));
  const ev = await ctx.store.updateEvent(ctx.params.eventId, body);
  if (!ev) return bad(404, "not_found");
  return json({ event: ev });
}, { auth: true });

reg("DELETE", "/api/events/:eventId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "events_delete");
  const r = await ctx.store.deleteEvent(ctx.params.eventId);
  if (!r) return bad(404, "not_found");
  return json({ ok: true });
}, { auth: true });

reg("POST", "/api/events/:eventId/attendance", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "event_attendance");
  const body = await req.json().catch(() => ({}));
  const { person_id, attended = true, notes } = body;
  if (!person_id) return bad(400, "person_id_required");
  const row = await ctx.store.upsertAttendance({
    event_id: ctx.params.eventId, person_id,
    attended: attended ? 1 : 0,
    marked_by: ctx.user.id, notes,
  });
  return json({ attendance: row });
}, { auth: true });

// ------------------------------------------------------ sadhana ---
// Compute chanting_pts from the round buckets:
//   before 7am ×4, 7-8am ×3, 8-10am ×2, after 10am ×1.
// This is the docs' rule; storing the buckets and recomputing here
// keeps the score honest even if the UI is bypassed.
function computeChantingPts(f) {
  return (f.rounds_before_7 || 0) * 4 +
         (f.rounds_7_8      || 0) * 3 +
         (f.rounds_8_10     || 0) * 2 +
         (f.rounds_after_10 || 0) * 1;
}
function computeTotalPts(f) {
  return (f.wake_up_pts     || 0) +
         (f.mangala_arati_pts || 0) +
         (f.chanting_pts    || 0) +
         (f.reading_pts     || 0) +
         (f.hearing_pts     || 0) +
         (f.seva_pts        || 0) +
         (f.preaching_pts   || 0);
}

reg("POST", "/api/sadhana", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "sadhana_chart");
  const body = await req.json().catch(() => ({}));
  const { person_id, entry_date } = body;
  if (!person_id || !entry_date) return bad(400, "missing_fields");
  const chanting_pts = computeChantingPts(body);
  const merged = { ...body, chanting_pts };
  const total_pts = computeTotalPts(merged);
  const row = await ctx.store.upsertSadhana({ ...merged, total_pts });
  return json({ entry: row });
}, { auth: true });

reg("GET", "/api/sadhana", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "sadhana_chart");
  const url = new URL(req.url);
  const limit = Math.min(100, Number(url.searchParams.get("limit") || 20));
  const rows = await ctx.store.recentSadhana(limit);
  const withNames = [];
  for (const r of rows) {
    const p = await ctx.store.personById(r.person_id);
    withNames.push({ ...r, person_name: p ? p.legal_name : "(unknown)" });
  }
  return json({ entries: withNames });
}, { auth: true });

reg("GET", "/api/sadhana/:personId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "sadhana_chart");
  const url = new URL(req.url);
  const from = url.searchParams.get("from") || undefined;
  const to = url.searchParams.get("to") || undefined;
  const entries = await ctx.store.sadhanaFor(ctx.params.personId, from, to);
  const person = await ctx.store.personById(ctx.params.personId);
  return json({ person, entries });
}, { auth: true });

// -------------------------------------------- group planning report ---
reg("POST", "/api/group-reports", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "group_planning_sheet");
  const body = await req.json().catch(() => ({}));
  if (!body.group_id || !body.report_date) return bad(400, "missing_fields");
  const row = await ctx.store.createGroupReport({
    ...body, reported_by: ctx.user.id,
  });
  return json({ report: row });
}, { auth: true });

reg("POST", "/api/group-reports/:reportId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "group_planning_sheet");
  const existing = await ctx.store.groupReportById(ctx.params.reportId);
  if (!existing) return bad(404, "not_found");
  if (existing.reported_by !== ctx.user.id && ctx.user.role !== "hk_leader") return bad(403, "forbidden");
  const body = await req.json().catch(() => ({}));
  const r = await ctx.store.updateGroupReport(ctx.params.reportId, body);
  if (!r) return bad(404, "not_found");
  return json({ report: r });
}, { auth: true });

reg("DELETE", "/api/group-reports/:reportId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "group_planning_sheet");
  const existing = await ctx.store.groupReportById(ctx.params.reportId);
  if (!existing) return bad(404, "not_found");
  if (existing.reported_by !== ctx.user.id && ctx.user.role !== "hk_leader") return bad(403, "forbidden");
  const r = await ctx.store.deleteGroupReport(ctx.params.reportId);
  if (!r) return bad(404, "not_found");
  return json({ ok: true });
}, { auth: true });

reg("DELETE", "/api/sadhana/:entryId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "sadhana_chart");
  const entry = await ctx.store.sadhanaById(ctx.params.entryId);
  if (!entry) return bad(404, "not_found");
  // Sadhana entries have no user_id — ownership is via the person's coord.
  const person = await ctx.store.personById(entry.person_id);
  const ownerId = person ? person.assigned_to_user_id : null;
  if (ownerId !== ctx.user.id && ctx.user.role !== "hk_leader") return bad(403, "forbidden");
  const r = await ctx.store.deleteSadhanaEntry(ctx.params.entryId);
  if (!r) return bad(404, "not_found");
  return json({ ok: true });
}, { auth: true });

reg("DELETE", "/api/duties/:dutyId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "duties_delete");
  const duty = await ctx.store.dutyById(ctx.params.dutyId);
  if (!duty) return bad(404, "not_found");
  if (duty.user_id !== ctx.user.id && ctx.user.role !== "hk_leader") return bad(403, "forbidden");
  const r = await ctx.store.deleteDuty(ctx.params.dutyId);
  if (!r) return bad(404, "not_found");
  return json({ ok: true });
}, { auth: true });

reg("GET", "/api/group-reports", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "group_planning_sheet");
  const url = new URL(req.url);
  const groupId = url.searchParams.get("group_id");
  if (!groupId) return bad(400, "group_id_required");
  const reports = await ctx.store.listGroupReports(groupId);
  return json({ reports });
}, { auth: true });

// -------------------------------------------------- BV structure ---
reg("GET", "/api/bv/structure", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "bv_structure_editor");
  const circles = await ctx.store.listGroupsByKind("circle");
  const sectors = await ctx.store.listGroupsByKind("sector");
  const bvGroups = await ctx.store.listGroupsByKind("bv_group");
  return json({ circles, sectors, bv_groups: bvGroups });
}, { auth: true });

reg("POST", "/api/bv/group", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "bv_structure_editor");
  const body = await req.json().catch(() => ({}));
  const { id, name, kind } = body;
  if (!name || !kind) return bad(400, "missing_fields");
  // Add vs edit split: creating a new group uses bv_add_group; editing
  // an existing one uses bv_edit_group. Both roll up to
  // bv_structure_editor for the page itself.
  await requireFeature(ctx.store, ctx.user.role, id ? "bv_edit_group" : "bv_add_group");
  const row = id
    ? await ctx.store.updateGroup(id, body)
    : await ctx.store.createGroup(body);
  return json({ group: row });
}, { auth: true });

reg("DELETE", "/api/bv/group/:groupId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "bv_delete_group");
  const r = await ctx.store.deleteGroup(ctx.params.groupId, ctx.user.id);
  if (!r) return bad(404, "not_found");
  return json({ ok: true });
}, { auth: true });

// Edit an existing user — role, display name, active status.
reg("POST", "/api/admin/users/:userId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "admin_users");
  const body = await req.json().catch(() => ({}));
  const patch = {};
  if (body.display_name) patch.display_name = body.display_name;
  if (body.role) {
    if (!isValidRole(body.role)) return bad(400, "bad_role");
    patch.role = body.role;
  }
  if (typeof body.active === "boolean") patch.active = body.active ? 1 : 0;
  if (body.password) patch.password_hash = await hashPassword(body.password);
  // sl_range_start / sl_range_end can be null (clear range) or ints
  if (body.sl_range_start !== undefined) patch.sl_range_start = body.sl_range_start === "" ? null : Number(body.sl_range_start);
  if (body.sl_range_end   !== undefined) patch.sl_range_end   = body.sl_range_end   === "" ? null : Number(body.sl_range_end);
  if (body.manager_user_id !== undefined) patch.manager_user_id = body.manager_user_id === "" ? null : body.manager_user_id;
  const u = await ctx.store.updateUser(ctx.params.userId, patch);
  if (!u) return bad(404, "not_found");
  return json({ user: { ...u, password_hash: undefined } });
}, { auth: true });

// Suggest the next 100-wide sl-range for a new coord. Scans existing
// coord users, finds the highest sl_range_end so far, adds 1. If no
// coord has a range yet, seeds at 10001 — the "one-based" starting
// point Prabhuji picked.
reg("GET", "/api/admin/next-sl-range", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "admin_users");
  const users = await ctx.store.listAllUsers();
  const ends = users
    .map(u => Number(u.sl_range_end))
    .filter(n => Number.isFinite(n) && n < 100000);
  const nextStart = ends.length ? Math.max(...ends) + 1 : 10001;
  return json({ start: nextStart, end: nextStart + 99 });
}, { auth: true });

// The rapid-entry UI calls this to get the sl_no for the row it's
// about to save. Coord-scoped: returns based on the caller's range.
reg("GET", "/api/me/next-sl", async (req, ctx) => {
  const n = await ctx.store.nextSlNoFor(ctx.user.id);
  if (n == null) return bad(409, "range_exhausted_or_missing", {
    hint: "Ask Super Admin to assign or extend your sl-range in Admin → Users.",
  });
  return json({ sl_no: n });
}, { auth: true });

// -------------------------------------------------------- duties ---
reg("GET", "/api/duties", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "duties_view_list");
  const url = new URL(req.url);
  const includeDone = url.searchParams.get("include_done") === "1";
  const rows = await ctx.store.dutiesFor(ctx.user.id, { onlyPending: !includeDone });
  return json({ duties: rows });
}, { auth: true });

reg("POST", "/api/duties/:dutyId/done", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "duties_mark_done");
  const duty = await ctx.store.dutyById(ctx.params.dutyId);
  if (!duty) return bad(404, "duty_not_found");
  if (duty.user_id !== ctx.user.id && ctx.user.role !== "hk_leader") return bad(403, "forbidden");
  const row = await ctx.store.markDutyDone(ctx.params.dutyId, ctx.user.id);
  if (!row) return bad(404, "duty_not_found");
  return json({ duty: row });
}, { auth: true });

// ---------------------------------------------- member details full ---
// Also returns `assigned_coord` — a small {id, display_name} projection
// of the coordinator this person is currently seated on, so the detail
// page can render "Assigned to: <name>" without a second round-trip.
reg("GET", "/api/member/:personId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "member_details_full");
  const p = await ctx.store.personById(ctx.params.personId);
  if (!p) return bad(404, "not_found");
  let assigned_coord = null;
  if (p.assigned_to_user_id) {
    const u = await ctx.store.userById(p.assigned_to_user_id).catch(() => null);
    if (u) assigned_coord = { id: u.id, display_name: u.display_name || u.username };
  }
  return json({ person: p, assigned_coord });
}, { auth: true });

// sl_no is TEXT in the schema and can hold hyphens + letters (like
// "90-2760a"). Validate the shape so a user typing garbage doesn't
// smuggle SQL-like strings into the column, but keep it permissive
// enough for the real-world SL values already in prod.
const SL_NO_PATTERN = /^[A-Za-z0-9\-]{1,32}$/;
reg("POST", "/api/member/:personId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "member_details_full");
  const body = await req.json().catch(() => ({}));
  if (Object.prototype.hasOwnProperty.call(body, "sl_no")) {
    const v = body.sl_no;
    if (v === null || v === "") body.sl_no = null;
    else if (typeof v !== "string" || !SL_NO_PATTERN.test(v)) return bad(400, "bad_sl_no");
  }
  const p = await ctx.store.updatePerson(ctx.params.personId, body, ctx.user.id);
  if (!p) return bad(404, "not_found");
  return json({ person: p });
}, { auth: true });

// Leader/HK — add a new coordinator directly from the Members tab.
// Scoped-down alternative to POST /api/admin/users: only creates users
// with role=njy_coordinator, and a leader can only add coords under
// themselves. HK Leader picks any njy_leader as the parent via
// `leader_username`; a leader's request auto-parents to the caller.
reg("POST", "/api/leader/add-coord", async (req, ctx) => {
  if (!["njy_leader", "hk_leader"].includes(ctx.user.role)) return bad(403, "forbidden");
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const display_name = String(body.display_name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!username || !password || !display_name) return bad(400, "missing_fields");
  if (password.length < 6) return bad(400, "password_too_short");
  // Resolve manager (leader) id.
  let manager_user_id = null;
  if (ctx.user.role === "njy_leader") {
    manager_user_id = ctx.user.id;
  } else {
    // HK Leader — must specify which leader the coord attaches to.
    const leader_username = String(body.leader_username || "").trim();
    if (!leader_username) return bad(400, "leader_username_required");
    const leader = await ctx.store.userByUsername(leader_username);
    if (!leader || leader.role !== "njy_leader") return bad(404, "leader_not_found");
    manager_user_id = leader.id;
  }
  // Username collision → 409 with a clear code.
  const existing = await ctx.store.userByUsername(username);
  if (existing) return bad(409, "username_taken");
  const password_hash = await hashPassword(password);
  const u = await ctx.store.createUser({
    username, password_hash, display_name,
    role: "njy_coordinator",
    phone: phone || null,
    manager_user_id,
  });
  // Credit the OWNING leader (not the caller) with the one-time
  // coord_onboarded touch point. When the caller is themselves an
  // njy_leader this is `ctx.user`; when HK Leader creates the coord
  // under someone else, we look the leader up and pass a synthetic
  // user object shaped like ctx.user so awardLeaderTouch's role gate
  // still fires. Uniqueness is enforced by ref_id = new_coord_id.
  const today = todayInTz(ctx.env?.APP_TZ);
  let leaderForTouch = null;
  if (ctx.user.role === "njy_leader") {
    leaderForTouch = ctx.user;
  } else if (manager_user_id) {
    const mgr = await ctx.store.userById(manager_user_id).catch(() => null);
    if (mgr && mgr.role === "njy_leader") {
      leaderForTouch = { id: mgr.id, role: mgr.role };
    }
  }
  if (leaderForTouch) {
    await awardLeaderTouch(ctx.store, leaderForTouch, "coord_onboarded", today, u.id);
  }
  // Echo the plaintext password ONCE in the response so the client can
  // render the credential-share modal (send login on WhatsApp). It is
  // NEVER stored beyond the bcrypt hash above and every later fetch
  // returns only the hash.
  return json({
    user: { ...u, password_hash: undefined },
    plaintext_password: password,
  });
}, { auth: true });

// Live username-availability probe for the Add Coordinator form.
// Cheaper than a full user-list fetch: just returns { available }.
reg("GET", "/api/leader/coord-username-check", async (req, ctx) => {
  if (!["njy_leader", "hk_leader"].includes(ctx.user.role)) return bad(403, "forbidden");
  const url = new URL(req.url);
  const u = String(url.searchParams.get("u") || "").trim();
  if (!u) return bad(400, "username_required");
  const existing = await ctx.store.userByUsername(u);
  return json({ available: !existing });
}, { auth: true });

// Super Admin (hk_leader) — add a new NJY Leader directly from the
// Members tab. Parallel to /api/leader/add-coord but restricted to HK
// Leader and hard-coded to role=njy_leader with no manager (leaders
// sit at the top of their own subtree). Response echoes the plaintext
// password ONCE so the client can render the credential-share modal.
reg("POST", "/api/hk/add-leader", async (req, ctx) => {
  if (ctx.user.role !== "hk_leader") return bad(403, "forbidden");
  const body = await req.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const display_name = String(body.display_name || "").trim();
  const phone = String(body.phone || "").trim();
  if (!username || !password || !display_name) return bad(400, "missing_fields");
  if (password.length < 6) return bad(400, "password_too_short");
  const existing = await ctx.store.userByUsername(username);
  if (existing) return bad(409, "username_taken");
  const password_hash = await hashPassword(password);
  const u = await ctx.store.createUser({
    username, password_hash, display_name,
    role: "njy_leader",
    phone: phone || null,
    manager_user_id: null,
    active: 1,
  });
  return json({
    user: { ...u, password_hash: undefined },
    plaintext_password: password,
  });
}, { auth: true });

// Lightweight helper: which coords may THIS caller reassign a member
// to? Same rules as /api/members/list's `eligible_coords`, but without
// dragging the full people table across the wire. HK gets every active
// njy_coordinator; leader gets their own; coord gets themselves only
// (so the Member detail page can still show a picker with one option
// and behave consistently for every role).
reg("GET", "/api/members/eligible-coords", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "members_tab");
  const coords = await ctx.store.listUsersByRole("njy_coordinator");
  let eligible = [];
  if (ctx.user.role === "hk_leader") {
    eligible = coords.filter(c => c.active);
  } else if (ctx.user.role === "njy_leader") {
    eligible = coords.filter(c => c.active && c.manager_user_id === ctx.user.id);
  } else if (ctx.user.role === "njy_coordinator") {
    eligible = coords.filter(c => c.id === ctx.user.id);
  }
  // Enrich each coord with phone + pincode (from the linked person row,
  // if any) so the client's bulk-assign helpers (gender highlighting +
  // auto-fill by pincode) can pre-filter without a second round-trip.
  // Pincode is best-effort — coords without a person_id return null.
  const out = await Promise.all(eligible.map(async (c) => {
    let pincode = null;
    if (c.person_id) {
      const p = await ctx.store.personById(c.person_id).catch(() => null);
      if (p && p.pincode) pincode = p.pincode;
    }
    return {
      id: c.id,
      display_name: c.display_name || c.username,
      phone: c.phone || null,
      pincode,
    };
  }));
  return json({ coords: out });
}, { auth: true });

// Delete (soft — active=0). HK Leader only. Preserves history and
// audit trail — the person's daily_chant_log / attendance / sadhana
// entries are untouched; they just stop appearing in active lists.
reg("DELETE", "/api/member/:personId", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "feature_admin");
  const r = await ctx.store.deletePerson(ctx.params.personId, ctx.user.id);
  if (!r) return bad(404, "not_found");
  return json({ ok: true });
}, { auth: true });

// Quick per-row edits from any list view.
reg("POST", "/api/person/:personId/status", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "myroll_change_status");
  // NJY Coordinators may set status on people assigned to them (so the
  // roll-inline dropdown works during Janmashtami). Higher tiers may
  // set status on anyone. Manjari Servant Leader same as coordinator
  // scope (for Phase 3 onward).
  const higher = ["hk_leader","njy_leader","circle_servant","sector_servant","servant_leader"];
  const perRoll = ["njy_coordinator","manjari_servant_leader"];
  if (!higher.includes(ctx.user.role) && !perRoll.includes(ctx.user.role)) return bad(403, "forbidden");
  const body = await req.json().catch(() => ({}));
  const { status } = body;
  const valid = ["chanter","daily","njy1","njy2","njy3","manjari","bv_member","dropped"];
  if (!valid.includes(status)) return bad(400, "bad_status", { valid });
  // Roll-scoped roles can only touch their own assigned people.
  if (!higher.includes(ctx.user.role)) {
    const person = await ctx.store.personById(ctx.params.personId);
    if (!person) return bad(404, "not_found");
    if (person.assigned_to_user_id !== ctx.user.id) return bad(403, "not_your_roll");
  }
  const p = await ctx.store.updatePerson(ctx.params.personId, { status }, ctx.user.id);
  if (!p) return bad(404, "not_found");
  return json({ person: p });
}, { auth: true });

reg("POST", "/api/person/:personId/assign", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "myroll_reassign_member");
  const body = await req.json().catch(() => ({}));
  const { assigned_to_user_id } = body;
  if (assigned_to_user_id) {
    const target = await ctx.store.userById(assigned_to_user_id);
    if (!target) return bad(404, "target_user_not_found");
  }
  const p = await ctx.store.updatePerson(ctx.params.personId, { assigned_to_user_id }, ctx.user.id);
  if (!p) return bad(404, "not_found");
  return json({ person: p });
}, { auth: true });

// Just the caller's own points — for the header chip next to the
// coordinator name. Two numbers only, no full leaderboard.
reg("GET", "/api/me/points", async (req, ctx) => {
  if (ctx.user.role !== "njy_coordinator") {
    return json({ daily: 0, overall: 0, applicable: false });
  }
  const today = todayInTz(ctx.env?.APP_TZ);
  const [d, o] = await Promise.all([
    scoreDailyForCoord(ctx.store, ctx.user, today),
    scoreOverallForCoord(ctx.store, ctx.user),
  ]);
  return json({ daily: d.pts, overall: o.pts, applicable: true });
}, { auth: true });

// ------------------------------------------------------ leaderboards ---
reg("GET", "/api/leaderboard/daily", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "leaderboard_coord_daily");
  const today = todayInTz(ctx.env?.APP_TZ);
  // Fast path — aggregate lookups + in-memory scoring. Handles the two
  // biggest point sources (chants + follow-ups). NJY-event attendance
  // and perfect-day bonuses aren't in the fast path — they'd re-add the
  // N×M queries. Not worth the CPU cost at scale; those show up on the
  // overall board correctly. Trade-off: today's board undercounts by
  // ≤50pts/coord/day (perfect-day) + ≤50/event/attendance. Acceptable.
  const [coords, chantedByCoord, followUpsByCoord, peopleByCoord] = await Promise.all([
    ctx.store.listUsersByRole("njy_coordinator"),
    ctx.store.chantedCountByCoordOnDate(today),
    ctx.store.followUpsCountByCoordOnDate(today),
    ctx.store.peopleCountByCoord(),
  ]);
  const rows = coords.filter(c => c.active).map((c) => {
    const chants = chantedByCoord.get(c.id) || 0;
    const fups = followUpsByCoord.get(c.id) || 0;
    const assigned = peopleByCoord.get(c.id) || 0;
    const bd = [];
    let pts = 0;
    if (chants) { pts += chants * 10; bd.push({ k: "chanted", n: chants, pts: chants * 10 }); }
    if (fups) { pts += fups * 5; bd.push({ k: "follow_up", n: fups, pts: fups * 5 }); }
    if (assigned > 0 && chants === assigned) {
      pts += 50; bd.push({ k: "perfect_day", n: 1, pts: 50 });
    }
    return { user_id: c.id, name: c.display_name, pts, breakdown: bd };
  });
  rows.sort((a, b) => b.pts - a.pts);
  return json({ date: today, rows });
}, { auth: true });

reg("GET", "/api/leaderboard/overall", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "leaderboard_coord_overall");
  const coords = await ctx.store.listUsersByRole("njy_coordinator");
  const rows = await Promise.all(coords.map(c => scoreOverallForCoord(ctx.store, c)));
  rows.sort((a, b) => b.pts - a.pts);
  return json({ scope: "P1+P2", rows });
}, { auth: true });

// NJY-Leader-level leaderboards. Each row = one leader; pts = sum of
// their coords' pts on that same scope. Coords are BLOCKED — this board
// is for leader-vs-leader ranking (HK sees the whole thing; each NJY
// Leader sees where they stand vs peers).
async function leaderScope(store, dateIso, mode) {
  const [leaders, allCoords] = await Promise.all([
    store.listUsersByRole("njy_leader"),
    store.listUsersByRole("njy_coordinator"),
  ]);
  const scorer = mode === "daily"
    ? (c) => scoreDailyForCoord(store, c, dateIso)
    : (c) => scoreOverallForCoord(store, c);
  const rows = await Promise.all(leaders.map(async (l) => {
    const myCoords = allCoords.filter(c => c.manager_user_id === l.id && c.active);
    const scores = await Promise.all(myCoords.map(scorer));
    const pts = scores.reduce((s, x) => s + (x.pts || 0), 0);
    const activeCoords = scores.filter(x => x.pts > 0).length;
    const pts_per_coord = myCoords.length ? Math.round(pts / myCoords.length) : 0;
    return {
      user_id: l.id, name: l.display_name || l.username, pts, pts_per_coord,
      coord_count: myCoords.length,
      breakdown: [
        { k: "coords_in_team", n: myCoords.length, pts: 0 },
        { k: "coords_scoring", n: activeCoords, pts: 0 },
        { k: "sum_of_coord_pts", n: null, pts },
        { k: "avg_per_coord", n: null, pts: pts_per_coord },
      ],
    };
  }));
  rows.sort((a, b) => b.pts - a.pts);
  return rows;
}
reg("GET", "/api/leaderboard/leaders/daily", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "leaderboard_leaders_daily");
  const today = todayInTz(ctx.env?.APP_TZ);
  // Fast aggregate path — mirror /api/leaderboard/daily then roll up
  // per-leader instead of returning per-coord. Adds the 3-bucket
  // prorated shape (Team Performance / Team Coverage / Leader Touch)
  // that the redesigned leader board renders as mini progress bars.
  const [leaders, allCoords, chantedByCoord, followUpsByCoord, peopleByCoord, touchByLeader] = await Promise.all([
    ctx.store.listUsersByRole("njy_leader"),
    ctx.store.listUsersByRole("njy_coordinator"),
    ctx.store.chantedCountByCoordOnDate(today),
    ctx.store.followUpsCountByCoordOnDate(today),
    ctx.store.peopleCountByCoord(),
    ctx.store.leaderTouchSumByLeaderForDay(today),
  ]);
  const rows = leaders.map((l) => {
    const myCoords = allCoords.filter(c => c.manager_user_id === l.id && c.active);
    const coordPtsList = [], coordActiveList = [];
    let pts = 0, scoring = 0;
    for (const c of myCoords) {
      const chants = chantedByCoord.get(c.id) || 0;
      const fups = followUpsByCoord.get(c.id) || 0;
      const assigned = peopleByCoord.get(c.id) || 0;
      let cp = chants * 10 + fups * 5;
      if (assigned > 0 && chants === assigned) cp += 50;
      if (cp > 0) scoring += 1;
      pts += cp;
      coordPtsList.push(cp);
      coordActiveList.push(cp > 0);
    }
    const pts_per_coord = myCoords.length ? Math.round(pts / myCoords.length) : 0;
    const touch = touchByLeader.get(l.id) || { pts: 0 };
    const buckets = computeLeaderBuckets({
      coordPtsList, coordActiveList,
      touchPts: touch.pts, touchNorm: TOUCH_NORM_DAILY,
    });
    return {
      // Keep legacy fields so existing frontend code paths continue
      // to work while the 3-bucket UI rolls out.
      user_id: l.id, name: l.display_name || l.username,
      pts: buckets.total_score, pts_per_coord, coord_count: myCoords.length,
      // NEW — buckets shape the 3-bar rendering consumes.
      team_performance: buckets.team_performance,
      team_coverage:    buckets.team_coverage,
      leader_touch:     buckets.leader_touch,
      team_performance_bar: buckets.team_performance_bar,
      team_coverage_bar:    buckets.team_coverage_bar,
      leader_touch_bar:     buckets.leader_touch_bar,
      total_score: buckets.total_score,
      raw_team_pts: pts,
      breakdown: [
        { k: "coords_in_team", n: myCoords.length, pts: 0 },
        { k: "coords_scoring", n: scoring, pts: 0 },
        { k: "sum_of_coord_pts", n: null, pts },
        { k: "avg_per_coord", n: null, pts: pts_per_coord },
        { k: "leader_touch_pts", n: null, pts: buckets.leader_touch },
        { k: "team_coverage_pct", n: buckets.team_coverage, pts: 0 },
      ],
    };
  });
  // Rank by the composite score so the 3-bucket model actually
  // decides the podium — not the raw sum.
  rows.sort((a, b) => b.total_score - a.total_score);
  return json({ date: today, rows });
}, { auth: true });
reg("GET", "/api/leaderboard/leaders/overall", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "leaderboard_leaders_overall");
  const legacyRows = await leaderScope(ctx.store, null, "overall");
  // Enrich the legacy rows with the 3-bucket shape used by the new
  // frontend. The overall board's `pts` is already the per-coord sum,
  // so team_performance = pts_per_coord and coverage = fraction of the
  // leader's coords whose overall pts > 0.
  const [allCoords, touchByLeader] = await Promise.all([
    ctx.store.listUsersByRole("njy_coordinator"),
    ctx.store.leaderTouchSumByLeaderAll(),
  ]);
  const rows = legacyRows.map((row) => {
    const myCoords = allCoords.filter(c => c.manager_user_id === row.user_id && c.active);
    // coords_scoring came out of leaderScope in the breakdown; recover
    // it here to feed team_coverage.
    const scoring = (row.breakdown || []).find(b => b.k === "coords_scoring");
    const activeCount = scoring ? (scoring.n || 0) : 0;
    // Build fake parallel arrays — computeLeaderBuckets only cares
    // about counts + sum, and we already have those aggregated.
    const coordPtsList = new Array(myCoords.length).fill(
      myCoords.length ? Math.round((row.pts || 0) / myCoords.length) : 0,
    );
    const coordActiveList = coordPtsList.map((_, i) => i < activeCount);
    const touch = touchByLeader.get(row.user_id) || { pts: 0 };
    const buckets = computeLeaderBuckets({
      coordPtsList, coordActiveList,
      touchPts: touch.pts, touchNorm: TOUCH_NORM_OVERALL,
    });
    return {
      ...row,
      raw_team_pts: row.pts,
      pts: buckets.total_score,
      team_performance: buckets.team_performance,
      team_coverage:    buckets.team_coverage,
      leader_touch:     buckets.leader_touch,
      team_performance_bar: buckets.team_performance_bar,
      team_coverage_bar:    buckets.team_coverage_bar,
      leader_touch_bar:     buckets.leader_touch_bar,
      total_score:          buckets.total_score,
      breakdown: [
        ...(row.breakdown || []),
        { k: "leader_touch_pts", n: null, pts: buckets.leader_touch },
        { k: "team_coverage_pct", n: buckets.team_coverage, pts: 0 },
      ],
    };
  });
  rows.sort((a, b) => b.total_score - a.total_score);
  return json({ scope: "P1+P2", rows });
}, { auth: true });

// ------------------------------------------------ Janmashtami entry ---
// Coords enter fresh chanters during Janmashtami booth-work — rapid
// single-row adds and paste-in-bulk both hit these two endpoints.
// Every insert gets the next unused sl_no from the caller's assigned
// range and lands under their roll.

// Normalize any user-typed mobile to a canonical +91XXXXXXXXXX format.
// Handles: 10-digit ("9999000001"), 12-digit with prefix ("919999000001"),
// hyphenated ("999-900-0001"), or already-canonical ("+919999000001").
// If the input doesn't look like an Indian mobile at all, we return the
// digits as-is with the '+' prefix so international entries still work.
export function normalizeMobile(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  // If the caller already provided a country-code prefix, keep it —
  // just strip formatting characters (spaces, dashes) from the digits.
  if (trimmed.startsWith("+")) return "+" + trimmed.slice(1).replace(/\D/g, "");
  // Bare digits — assume Indian mobile if 10 digits, otherwise treat
  // as-typed with a + prefix.
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return "+91" + digits;
  if (digits.length === 12 && digits.startsWith("91")) return "+" + digits;
  if (digits.length === 11 && digits.startsWith("0")) return "+91" + digits.slice(1);
  return "+" + digits;
}

async function assignAndCreate(store, coord, { name, mobile, pincode, coupon_no, is_daily }) {
  if (!name || !mobile) return { error: "name_and_mobile_required" };
  const phone = normalizeMobile(mobile);
  // Coupon number is the physical coupon printed 1-30000. If provided,
  // use it directly (validated for uniqueness). If not provided AND the
  // coord has an auto-range set, fall back to the old auto-allocation.
  let sl_no = null;
  const asNum = Number(coupon_no);
  if (Number.isFinite(asNum) && asNum > 0 && asNum <= 100000) {
    sl_no = asNum;
    // Check the number isn't already used
    const list = await store.searchPeople(String(sl_no), 5);
    // Better: dedicated lookup by sl_no. Fall back to explicit find:
    const clash = (await store._listAll?.()) || null;
    // Best: rely on the UNIQUE index — the INSERT will fail if dup.
    // We surface a friendly error below.
  } else {
    sl_no = await store.nextSlNoFor(coord.id);
    if (sl_no == null) return { error: "coupon_or_range_required" };
  }
  const dup = await store.personByPhone(phone);
  if (dup) return { error: "duplicate_phone", phone };
  try {
    const p = await store.createPerson({
      legal_name: String(name).trim(),
      phone,
      pincode: pincode ? String(pincode).trim() : null,
      sl_no,
      assigned_to_user_id: coord.id,
      status: (is_daily === true || is_daily === "true" || is_daily === "yes" || is_daily === 1 || is_daily === "1") ? "daily" : "chanter",
    });
    return { person: p };
  } catch (err) {
    if (String(err.message || "").includes("UNIQUE") && String(err.message || "").includes("sl_no")) {
      return { error: "duplicate_coupon", coupon_no: sl_no };
    }
    throw err;
  }
}

reg("POST", "/api/janmashtami/entry", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "janmashtami_quick_add");
  const body = await req.json().catch(() => ({}));
  const r = await assignAndCreate(ctx.store, ctx.user, body);
  if (r.error) return bad(r.error === "range_exhausted_or_missing" ? 409 : 400, r.error, r);
  return json({ person: r.person });
}, { auth: true });

reg("POST", "/api/janmashtami/bulk", async (req, ctx) => {
  // Bulk endpoint serves both CSV upload AND paste-many. Accept either
  // gate — if HK has enabled at least one bulk-input path for this role,
  // the endpoint is callable. Server-side keeps its own gate as final
  // authority in case someone hits the URL directly.
  const store = ctx.store, role = ctx.user.role;
  if (!(await canAccess(store, role, "janmashtami_upload_csv"))
      && !(await canAccess(store, role, "janmashtami_paste_rows"))
      && !(await canAccess(store, role, "janmashtami_commit_import"))) {
    return bad(403, "forbidden: janmashtami_bulk");
  }
  const body = await req.json().catch(() => ({}));
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const created = [], errors = [];
  for (const [i, row] of rows.entries()) {
    const r = await assignAndCreate(store, ctx.user, row);
    if (r.error) errors.push({ index: i, ...r });
    else created.push(r.person);
  }
  return json({ created: created.length, errors });
}, { auth: true });

// Return today's Janmashtami entries for the calling coordinator,
// sorted NEWEST FIRST (so the most recent add is on top). Kept
// separate from /api/roll so the roll can still list alphabetically
// for the coordinator's daily-chant workflow.
reg("GET", "/api/me/janmashtami-entries", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "janmashtami_today_entries");
  const roll = await ctx.store.peopleAssignedTo(ctx.user.id);
  const today = todayInTz(ctx.env?.APP_TZ);
  const todays = roll
    .filter(p => (p.created_at || "").slice(0, 10) === today)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return json({
    entries: todays.map(p => ({
      id: p.id, name: p.legal_name, phone: p.phone,
      pincode: p.pincode || null, sl_no: p.sl_no || null,
      status: p.status, created_at: p.created_at,
    })),
  });
}, { auth: true });

// Progress helper for the sticky top on the rapid-entry screen —
// counts how many people the caller has entered today, and returns the
// next tier bonus threshold if any.
reg("GET", "/api/me/janmashtami-progress", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "janmashtami_view_page");
  const roll = await ctx.store.peopleAssignedTo(ctx.user.id);
  const today = todayInTz(ctx.env?.APP_TZ);
  const enteredToday = roll.filter(p => (p.created_at || "").slice(0, 10) === today);
  const committedToday = enteredToday.filter(p => p.status === "daily");
  const entryTiers = [25, 50, 75, 100];
  const commitTiers = [15, 25, 50];
  const nextTier = (n, tiers) => tiers.find(t => t > n) || null;
  return json({
    today,
    entries_today: enteredToday.length,
    committed_today: committedToday.length,
    next_entry_tier: nextTier(enteredToday.length, entryTiers),
    next_commit_tier: nextTier(committedToday.length, commitTiers),
  });
}, { auth: true });

// ------------------------------------------------------ web push ---
reg("POST", "/api/webpush/subscribe", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "web_push");
  const body = await req.json().catch(() => ({}));
  const { endpoint, keys } = body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return bad(400, "bad_subscription");
  const row = await ctx.store.addWebPushSub({
    user_id: ctx.user.id, endpoint,
    p256dh: keys.p256dh, auth: keys.auth,
  });
  return json({ subscription_id: row.id });
}, { auth: true });

reg("POST", "/api/webpush/unsubscribe", async (req, ctx) => {
  const body = await req.json().catch(() => ({}));
  if (!body.endpoint) return bad(400, "endpoint_required");
  await ctx.store.removeWebPushSub(body.endpoint, ctx.user.id);
  return json({ ok: true });
}, { auth: true });

// ------------------------------------------------ feature-gate admin ---
reg("POST", "/api/admin/feature-gate", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "feature_admin");
  const body = await req.json().catch(() => ({}));
  const { feature_key, allowed_roles } = body;
  if (!feature_key || !Array.isArray(allowed_roles)) return bad(400, "bad_body");
  for (const r of allowed_roles) if (!isValidRole(r)) return bad(400, "bad_role", { role: r });
  await ctx.store.setFeatureGate(feature_key, allowed_roles, ctx.user.id);
  const gates = await ctx.store.featureGates();
  return json({ gates });
}, { auth: true });

// Bulk save: accepts { changes: [{feature_key, allowed_roles}, ...] } and
// applies them all in one round-trip. Used by the rebuilt admin UI.
reg("POST", "/api/admin/feature-gates/bulk", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "feature_admin");
  const body = await req.json().catch(() => ({}));
  const changes = Array.isArray(body.changes) ? body.changes : [];
  if (!changes.length) return bad(400, "no_changes");
  for (const c of changes) {
    if (!c.feature_key || !Array.isArray(c.allowed_roles)) return bad(400, "bad_change", c);
    for (const r of c.allowed_roles) if (!isValidRole(r)) return bad(400, "bad_role", { role: r });
  }
  let saved = 0;
  for (const c of changes) {
    await ctx.store.setFeatureGate(c.feature_key, c.allowed_roles, ctx.user.id);
    saved++;
  }
  const gates = await ctx.store.featureGates();
  return json({ saved, gates });
}, { auth: true });

// ----------------------------------------------------- bulk import ---
reg("POST", "/api/import/preview", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "bulk_import");
  const body = await req.json().catch(() => ({}));
  const { rows } = body;
  if (!Array.isArray(rows)) return bad(400, "rows_required");
  // Preview: identify duplicates and errors WITHOUT writing.
  const errors = [], dupInBatch = [], dupInDb = [];
  const seen = new Set();
  for (const [i, r] of rows.entries()) {
    if (!r.phone) { errors.push({ index: i, reason: "phone_required" }); continue; }
    if (!r.legal_name) { errors.push({ index: i, reason: "name_required" }); continue; }
    const norm = normalizeMobile(r.phone || r.mobile || "");
    if (seen.has(norm)) { dupInBatch.push({ index: i, phone: r.phone }); continue; }
    seen.add(norm);
    const dup = await ctx.store.personByPhone(norm);
    if (dup) dupInDb.push({ index: i, phone: r.phone });
  }
  return json({
    total: rows.length,
    would_create: rows.length - errors.length - dupInBatch.length - dupInDb.length,
    duplicates_in_batch: dupInBatch,
    duplicates_in_db: dupInDb,
    errors,
  });
}, { auth: true });

reg("POST", "/api/import/commit", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "bulk_import");
  const body = await req.json().catch(() => ({}));
  const { rows, assigned_to_user_id } = body;
  if (!Array.isArray(rows)) return bad(400, "rows_required");
  const prepared = rows.map(r => ({
    ...r,
    phone: normalizeMobile(r.phone || r.mobile || ""),
    // Per-row assignment wins over the batch default — data-entry teams
    // can send a mixed Excel where each row's coord_username picks its
    // own coord, and unset rows fall back to the batch dropdown.
    assigned_to_user_id: r.assigned_to_user_id || assigned_to_user_id || null,
  }));
  const result = await ctx.store.bulkCreatePeople(prepared);
  return json({
    created: result.created.length,
    duplicates: result.duplicates,
    errors: result.errors,
  });
}, { auth: true });

// ------------------------------------------------------ WhatsApp deep-link ---
// UI hits this to get a canonical URL for opening WhatsApp on a person.
// Server also records the intent for audit.
reg("POST", "/api/whatsapp/url", async (req, ctx) => {
  await requireFeature(ctx.store, ctx.user.role, "whatsapp_deeplink");
  const body = await req.json().catch(() => ({}));
  const { person_id, template = "followup", text: overrideText } = body;
  const person = await ctx.store.personById(person_id);
  if (!person) return bad(404, "person_not_found");
  const text = overrideText || (WA_TEMPLATES[template] || WA_TEMPLATES.followup)(person.legal_name);
  const url = waDeepLink(person.phone, text);
  await ctx.store.recordNotification({
    kind: "wa-deeplink",
    target_person_id: person_id,
    target_user_id: ctx.user.id,
    payload: { template, text },
    status: "sent",
    sent_at: nowIso(),
  });
  return json({ url });
}, { auth: true });
