// In-memory implementation of the store interface — used by tests, and
// by scripts/preview.js when we want to drive the real handlers without
// a database. Matches primitive/tests/integration.mjs pattern.
//
// All methods return Promises (even though data is sync in-memory) so
// the D1 store and this one are call-compatible.

import { newId, nowIso } from "./ids.js";

export function memoryStore(seed = {}) {
  const t = {
    people: [], users: [], groups: [], group_membership: [],
    daily_chant_log: [], events: [], attendance: [],
    sadhana_entries: [], group_reports: [], duties: [],
    feature_gates: [], notifications: [], web_push_subscriptions: [],
    person_stage_log: [], leader_touch_actions: [],
    ...seed,
  };

  const active = (row) => row.active !== 0;
  const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));

  return {
    _tables: t,

    // ---------------- people ----------------
    async personById(id) {
      return clone(t.people.find(p => p.id === id && active(p))) || null;
    },
    async personByPhone(phone) {
      return clone(t.people.find(p => p.phone === phone && active(p))) || null;
    },
    async peopleInGroup(groupId) {
      const memberIds = t.group_membership
        .filter(m => m.group_id === groupId && active(m))
        .map(m => m.person_id);
      const ids = new Set(memberIds);
      return t.people.filter(p => ids.has(p.id) && active(p)).map(clone);
    },
    async personsByStatus(status) {
      return t.people.filter(p => p.status === status && active(p)).map(clone);
    },
    async searchPeople(query, limit = 50) {
      const q = String(query || "").toLowerCase().trim();
      if (!q) return [];
      const digits = q.replace(/\D/g, "");
      return t.people
        .filter(p => active(p) && (
          p.legal_name.toLowerCase().includes(q) ||
          (digits && String(p.phone || "").replace(/\D/g, "").includes(digits))
        ))
        .slice(0, limit)
        .map(clone);
    },
    async peopleAssignedTo(userId) {
      return t.people
        .filter(p => p.assigned_to_user_id === userId && active(p))
        .map(clone);
    },
    // For the "35/40 one-month daily chanters" metric — a person counts
    // as one-month-daily if they've logged >= minDays chanted days in
    // the last windowDays. Default window is the last 30 days, and the
    // threshold is 25 (allows ~5 misses = "one-month").
    async oneMonthDailyCountFor(userId, todayIso, windowDays = 30, minDays = 25) {
      const start = new Date(todayIso + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - windowDays + 1);
      const startIso = start.toISOString().slice(0, 10);
      const chanters = t.people.filter(p => p.assigned_to_user_id === userId && active(p) && p.status === "daily");
      let hits = 0;
      for (const p of chanters) {
        const days = new Set(
          t.daily_chant_log
            .filter(r => r.person_id === p.id && r.chanted && r.entry_date >= startIso && r.entry_date <= todayIso)
            .map(r => r.entry_date),
        );
        if (days.size >= minDays) hits++;
      }
      return { one_month_daily: hits, daily_chanter_total: chanters.length };
    },
    async peopleCount() {
      return t.people.filter(active).length;
    },
    async createPerson(fields) {
      const now = nowIso();
      const row = {
        id: fields.id || newId(),
        legal_name: fields.legal_name,
        phone: fields.phone,
        status: fields.status || "chanter",
        contact_state: fields.contact_state ?? 0,
        active: 1,
        created_at: now,
        updated_at: now,
        ...fields,
      };
      t.people.push(row);
      return clone(row);
    },
    async updatePerson(id, patch, by) {
      const row = t.people.find(p => p.id === id);
      if (!row) return null;
      const from = row.status;
      Object.assign(row, patch, { updated_at: nowIso() });
      if (patch.status && patch.status !== from) {
        t.person_stage_log.push({
          id: newId(), person_id: id, from_status: from,
          to_status: patch.status, changed_at: nowIso(),
          changed_by: by || "system", reason: patch.stage_reason || null,
        });
      }
      return clone(row);
    },
    async deletePerson(id, by) {
      const row = t.people.find(p => p.id === id);
      if (!row) return null;
      row.active = 0;
      row.updated_at = nowIso();
      return { ok: true, id };
    },
    // Only upgrade contact_state 0 → 1. Never downgrades from 2 (responded).
    async markContactedIfLower(personId, byUserId) {
      const row = t.people.find(p => p.id === personId);
      if (!row) return { ok: false, reason: "not_found" };
      const prior = row.contact_state || 0;
      if (row.active && prior === 0) {
        const now = nowIso();
        row.contact_state = 1;
        row.last_marked_at = now;
        row.last_marked_by = byUserId;
        row.updated_at = now;
        return { ok: true, changed: true, contact_state: 1, prior_contact_state: prior };
      }
      return { ok: true, changed: false, contact_state: prior, prior_contact_state: prior };
    },
    async bulkCreatePeople(rows) {
      const now = nowIso();
      const seenPhones = new Set(t.people.filter(active).map(p => p.phone));
      const created = [], duplicates = [], errors = [];
      for (const [i, r] of rows.entries()) {
        if (!r.phone) { errors.push({ index: i, reason: "phone_required" }); continue; }
        if (!r.legal_name) { errors.push({ index: i, reason: "name_required" }); continue; }
        if (seenPhones.has(r.phone)) { duplicates.push({ index: i, phone: r.phone }); continue; }
        seenPhones.add(r.phone);
        const row = {
          id: newId(), active: 1, status: "chanter",
          created_at: now, updated_at: now, ...r,
        };
        t.people.push(row);
        created.push(clone(row));
      }
      return { created, duplicates, errors };
    },

    // ---------------- users ----------------
    async userById(id) {
      return clone(t.users.find(u => u.id === id && active(u))) || null;
    },
    async userByUsername(username) {
      return clone(t.users.find(u => u.username === username && active(u))) || null;
    },
    async listUsersByRole(role) {
      return t.users.filter(u => u.role === role && active(u)).map(clone);
    },
    async createUser(fields) {
      const now = nowIso();
      const row = {
        id: fields.id || newId(),
        active: 1, created_at: now,
        ...fields,
      };
      t.users.push(row);
      return clone(row);
    },
    // Next unused sl_no in this coord's assigned range. Returns null if
    // the range is exhausted so the UI can prompt for an extension.
    async nextSlNoFor(userId) {
      const u = t.users.find(x => x.id === userId);
      if (!u || u.sl_range_start == null || u.sl_range_end == null) return null;
      const used = new Set(
        t.people
          .filter(p => p.sl_no != null && p.sl_no >= u.sl_range_start && p.sl_no <= u.sl_range_end)
          .map(p => p.sl_no),
      );
      for (let n = u.sl_range_start; n <= u.sl_range_end; n++) {
        if (!used.has(n)) return n;
      }
      return null;
    },
    async updateUser(id, patch) {
      const row = t.users.find(u => u.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return clone(row);
    },

    // ---------------- groups + membership ----------------
    async groupById(id) {
      return clone(t.groups.find(g => g.id === id && active(g))) || null;
    },
    async listGroupsByKind(kind) {
      return t.groups.filter(g => g.kind === kind && active(g)).map(clone);
    },
    async listGroupsByLeader(userId) {
      return t.groups.filter(g => g.leader_user_id === userId && active(g)).map(clone);
    },
    async listGroupsByParent(parentId) {
      return t.groups.filter(g => g.parent_group_id === parentId && active(g)).map(clone);
    },
    async createGroup(fields) {
      const now = nowIso();
      const row = {
        id: fields.id || newId(),
        active: 1, created_at: now, updated_at: now, ...fields,
      };
      t.groups.push(row);
      return clone(row);
    },
    async updateGroup(id, patch) {
      const row = t.groups.find(g => g.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updated_at: nowIso() });
      return clone(row);
    },
    async deleteGroup(id, by) {
      const row = t.groups.find(g => g.id === id);
      if (!row) return null;
      row.active = 0;
      row.updated_at = nowIso();
      // also end all active memberships in the group
      for (const m of t.group_membership) {
        if (m.group_id === id && m.active) {
          m.active = 0; m.left_at = nowIso();
        }
      }
      return { ok: true, id };
    },
    async endMembership(memId, by) {
      const m = t.group_membership.find(x => x.id === memId);
      if (!m) return null;
      m.active = 0; m.left_at = nowIso();
      return { ok: true };
    },
    async membershipsInGroup(groupId) {
      return t.group_membership
        .filter(m => m.group_id === groupId && active(m)).map(clone);
    },
    async membershipsForPerson(personId) {
      return t.group_membership
        .filter(m => m.person_id === personId && active(m)).map(clone);
    },
    async addMembership(fields) {
      const now = nowIso();
      const row = {
        id: fields.id || newId(),
        role: fields.role || "member",
        joined_at: now, active: 1, ...fields,
      };
      t.group_membership.push(row);
      return clone(row);
    },

    // ---------------- daily chant ----------------
    async chantOnDate(personId, date) {
      return clone(t.daily_chant_log.find(
        r => r.person_id === personId && r.entry_date === date,
      )) || null;
    },
    async countChantsOnDate(dateIso) {
      return t.daily_chant_log.filter(r => r.entry_date === dateIso && r.chanted).length;
    },
    async countChantDaysForCoord(coordId, fromIso, toIso) {
      const ids = new Set(
        t.people
          .filter(p => p.assigned_to_user_id === coordId && active(p))
          .map(p => p.id),
      );
      return t.daily_chant_log.filter(r =>
        ids.has(r.person_id) && r.chanted &&
        r.entry_date >= fromIso && r.entry_date <= toIso,
      ).length;
    },
    async hasChantedSince(personId, sinceIso) {
      return t.daily_chant_log.some(
        r => r.person_id === personId && r.chanted && r.entry_date >= sinceIso,
      );
    },
    async chantDatesForPersonIdsBetween(personIds, fromIso, toIso) {
      if (!personIds || personIds.length === 0) return [];
      const set = new Set(personIds);
      return t.daily_chant_log
        .filter(r => set.has(r.person_id) && r.chanted
          && r.entry_date >= fromIso && r.entry_date <= toIso)
        .map(r => ({ person_id: r.person_id, entry_date: r.entry_date }));
    },

    // ---------- fast HK-leaders rollup (mirrors D1 impl) ----------
    async followUpsCountByCoordOnDate(dateIso) {
      const map = new Map();
      for (const p of t.people) {
        if (!active(p) || !p.assigned_to_user_id) continue;
        if (!p.last_marked_at) continue;
        if (p.last_marked_at.slice(0, 10) !== dateIso) continue;
        map.set(p.assigned_to_user_id, (map.get(p.assigned_to_user_id) || 0) + 1);
      }
      return map;
    },
    async chantedTodayDailyByCoord(dateIso) {
      const map = new Map();
      const byPerson = new Map(t.people.map(p => [p.id, p]));
      const seen = new Set();
      for (const r of t.daily_chant_log) {
        if (!r.chanted || r.entry_date !== dateIso) continue;
        const p = byPerson.get(r.person_id);
        if (!p || !active(p) || p.status !== "daily" || !p.assigned_to_user_id) continue;
        const key = r.person_id + "|" + p.assigned_to_user_id;
        if (seen.has(key)) continue;
        seen.add(key);
        map.set(p.assigned_to_user_id, (map.get(p.assigned_to_user_id) || 0) + 1);
      }
      return map;
    },
    async consistentDailyByCoord(todayIso, missWindowDays = 3) {
      const start = new Date(todayIso + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - (missWindowDays - 1));
      const startIso = start.toISOString().slice(0, 10);
      const chantedInWindow = new Set();
      for (const r of t.daily_chant_log) {
        if (!r.chanted) continue;
        if (r.entry_date < startIso || r.entry_date > todayIso) continue;
        chantedInWindow.add(r.person_id);
      }
      const map = new Map();
      for (const p of t.people) {
        if (!active(p) || p.status !== "daily" || !p.assigned_to_user_id) continue;
        if (!chantedInWindow.has(p.id)) continue;
        map.set(p.assigned_to_user_id, (map.get(p.assigned_to_user_id) || 0) + 1);
      }
      return map;
    },
    async peopleCountByCoord() {
      const map = new Map();
      for (const p of t.people) {
        if (!active(p) || !p.assigned_to_user_id) continue;
        map.set(p.assigned_to_user_id, (map.get(p.assigned_to_user_id) || 0) + 1);
      }
      return map;
    },
    async chantedCountByCoordOnDate(dateIso) {
      const map = new Map();
      const byPerson = new Map(t.people.map(p => [p.id, p]));
      const seen = new Set();
      for (const r of t.daily_chant_log) {
        if (!r.chanted || r.entry_date !== dateIso) continue;
        const p = byPerson.get(r.person_id);
        if (!p || !active(p) || !p.assigned_to_user_id) continue;
        const key = r.person_id + "|" + p.assigned_to_user_id;
        if (seen.has(key)) continue;
        seen.add(key);
        map.set(p.assigned_to_user_id, (map.get(p.assigned_to_user_id) || 0) + 1);
      }
      return map;
    },
    async dailyChanterCountByCoord() {
      const map = new Map();
      for (const p of t.people) {
        if (!active(p) || p.status !== "daily" || !p.assigned_to_user_id) continue;
        map.set(p.assigned_to_user_id, (map.get(p.assigned_to_user_id) || 0) + 1);
      }
      return map;
    },
    async oneMonthDailyCountByCoord(todayIso, windowDays = 30, minDays = 25) {
      const start = new Date(todayIso + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - windowDays + 1);
      const startIso = start.toISOString().slice(0, 10);
      const countsByPerson = new Map();
      const byPerson = new Map(t.people.map(p => [p.id, p]));
      for (const r of t.daily_chant_log) {
        if (!r.chanted) continue;
        if (r.entry_date < startIso || r.entry_date > todayIso) continue;
        const p = byPerson.get(r.person_id);
        if (!p || !active(p) || p.status !== "daily" || !p.assigned_to_user_id) continue;
        countsByPerson.set(r.person_id, (countsByPerson.get(r.person_id) || 0) + 1);
      }
      const map = new Map();
      for (const [pid, days] of countsByPerson) {
        if (days < minDays) continue;
        const p = byPerson.get(pid);
        if (!p) continue;
        map.set(p.assigned_to_user_id, (map.get(p.assigned_to_user_id) || 0) + 1);
      }
      return map;
    },
    async chantsByGroupOnDate(groupId, date) {
      const memberIds = new Set(
        t.group_membership
          .filter(m => m.group_id === groupId && active(m))
          .map(m => m.person_id),
      );
      return t.daily_chant_log
        .filter(r => memberIds.has(r.person_id) && r.entry_date === date)
        .map(clone);
    },
    async upsertChant(fields) {
      const existing = t.daily_chant_log.find(
        r => r.person_id === fields.person_id && r.entry_date === fields.entry_date,
      );
      const now = nowIso();
      if (existing) {
        Object.assign(existing, fields, { marked_at: now });
        return clone(existing);
      }
      const row = { id: newId(), marked_at: now, chanted: 1, source: "coordinator", ...fields };
      t.daily_chant_log.push(row);
      return clone(row);
    },

    // ---------------- feature gates ----------------
    async featureGates() {
      const out = {};
      for (const r of t.feature_gates) {
        out[r.feature_key] = String(r.allowed_roles).split(",").map(s => s.trim());
      }
      return out;
    },
    async setFeatureGate(key, allowedRoles, by) {
      let row = t.feature_gates.find(r => r.feature_key === key);
      const now = nowIso();
      if (row) {
        row.allowed_roles = allowedRoles.join(",");
        row.updated_at = now; row.updated_by = by;
      } else {
        t.feature_gates.push({
          feature_key: key, allowed_roles: allowedRoles.join(","),
          updated_at: now, updated_by: by,
        });
      }
    },

    // ---------------- people bulk assign ----------------
    async assignPeopleToUser(personIds, userId) {
      let n = 0;
      for (const id of personIds) {
        const p = t.people.find(x => x.id === id);
        if (!p) continue;
        p.assigned_to_user_id = userId;
        p.updated_at = nowIso();
        n++;
      }
      return { assigned: n };
    },

    // ---------------- users list ----------------
    async listAllUsers() {
      return t.users.filter(active).map(clone);
    },

    // ---------------- events / attendance ----------------
    async listEvents(filter = {}) {
      let out = t.events.filter(active);
      if (filter.kind) out = out.filter(e => e.kind === filter.kind);
      if (filter.from) out = out.filter(e => e.event_date >= filter.from);
      if (filter.to)   out = out.filter(e => e.event_date <= filter.to);
      return out.map(clone).sort((a, b) => (a.event_date < b.event_date ? 1 : -1));
    },
    async eventById(id) {
      return clone(t.events.find(e => e.id === id && active(e))) || null;
    },
    async createEvent(fields) {
      const now = nowIso();
      const row = { id: fields.id || newId(), active: 1, created_at: now, ...fields };
      t.events.push(row);
      return clone(row);
    },
    async updateEvent(id, patch) {
      const row = t.events.find(e => e.id === id);
      if (!row) return null;
      Object.assign(row, patch);
      return clone(row);
    },
    async deleteEvent(id) {
      const row = t.events.find(e => e.id === id);
      if (!row) return null;
      row.active = 0;
      return { ok: true };
    },
    async attendanceForEvent(eventId) {
      return t.attendance.filter(a => a.event_id === eventId).map(clone);
    },
    async upsertAttendance(fields) {
      let row = t.attendance.find(
        a => a.event_id === fields.event_id && a.person_id === fields.person_id,
      );
      const now = nowIso();
      if (row) {
        Object.assign(row, fields, { marked_at: now });
        return clone(row);
      }
      row = { id: newId(), attended: 1, marked_at: now, ...fields };
      t.attendance.push(row);
      return clone(row);
    },

    // ---------------- sadhana ----------------
    async upsertSadhana(fields) {
      const existing = t.sadhana_entries.find(
        e => e.person_id === fields.person_id && e.entry_date === fields.entry_date,
      );
      const now = nowIso();
      if (existing) {
        Object.assign(existing, fields, { updated_at: now });
        return clone(existing);
      }
      const row = { id: newId(), created_at: now, updated_at: now, ...fields };
      t.sadhana_entries.push(row);
      return clone(row);
    },
    async sadhanaFor(personId, from, to) {
      return t.sadhana_entries
        .filter(e => e.person_id === personId &&
          (!from || e.entry_date >= from) &&
          (!to   || e.entry_date <= to))
        .map(clone);
    },
    async sadhanaById(id) {
      const row = t.sadhana_entries.find(e => e.id === id);
      return row ? clone(row) : null;
    },
    async deleteSadhanaEntry(id) {
      const i = t.sadhana_entries.findIndex(e => e.id === id);
      if (i < 0) return null;
      t.sadhana_entries.splice(i, 1);
      return { ok: true };
    },
    async recentSadhana(limit = 20) {
      return [...t.sadhana_entries]
        .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
        .slice(0, limit)
        .map(clone);
    },

    // ---------------- group reports ----------------
    async createGroupReport(fields) {
      const now = nowIso();
      const row = { id: fields.id || newId(), created_at: now, updated_at: now, ...fields };
      t.group_reports.push(row);
      return clone(row);
    },
    async groupReportById(id) {
      const row = t.group_reports.find(r => r.id === id);
      return row ? clone(row) : null;
    },
    async updateGroupReport(id, patch) {
      const row = t.group_reports.find(r => r.id === id);
      if (!row) return null;
      Object.assign(row, patch, { updated_at: nowIso() });
      return clone(row);
    },
    async deleteGroupReport(id) {
      const i = t.group_reports.findIndex(r => r.id === id);
      if (i < 0) return null;
      t.group_reports.splice(i, 1);
      return { ok: true };
    },
    async listGroupReports(groupId) {
      return t.group_reports
        .filter(r => r.group_id === groupId)
        .map(clone)
        .sort((a, b) => (a.report_date < b.report_date ? 1 : -1));
    },

    // ---------------- duties ----------------
    async dutiesFor(userId, { onlyPending = true } = {}) {
      let out = t.duties.filter(d => d.user_id === userId && active(d));
      if (onlyPending) out = out.filter(d => !d.done_at);
      return out.map(clone).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    },
    async createDuty(fields) {
      const row = { id: fields.id || newId(), active: 1, ...fields };
      t.duties.push(row);
      return clone(row);
    },
    async dutyById(id) {
      const row = t.duties.find(d => d.id === id);
      return row ? clone(row) : null;
    },
    async deleteDuty(id) {
      const row = t.duties.find(d => d.id === id);
      if (!row) return null;
      row.active = 0;
      return { ok: true };
    },
    async markDutyDone(id, userId) {
      const row = t.duties.find(d => d.id === id);
      if (!row) return null;
      row.done_at = nowIso();
      row.done_by = userId;
      return clone(row);
    },

    // ---------------- web push ----------------
    async listWebPushSubs(userId) {
      return t.web_push_subscriptions
        .filter(s => s.user_id === userId && active(s))
        .map(clone);
    },
    async addWebPushSub(fields) {
      const existing = t.web_push_subscriptions.find(s => s.endpoint === fields.endpoint);
      if (existing) { existing.active = 1; return clone(existing); }
      const row = {
        id: newId(), active: 1, created_at: nowIso(), ...fields,
      };
      t.web_push_subscriptions.push(row);
      return clone(row);
    },
    async removeWebPushSub(endpoint, userId) {
      const row = t.web_push_subscriptions.find(
        s => s.endpoint === endpoint && (!userId || s.user_id === userId),
      );
      if (row) row.active = 0;
    },

    // ---------------- leader touch actions ----------------
    async logLeaderTouch({ leaderUserId, actionKey, points, dayIso, refId }) {
      const ref = refId || "";
      const exists = t.leader_touch_actions.some(r =>
        r.leader_user_id === leaderUserId
        && r.action_key === actionKey
        && r.day_iso === dayIso
        && (r.ref_id || "") === ref,
      );
      if (exists) return { inserted: false, row: null };
      const row = {
        id: newId(),
        leader_user_id: leaderUserId,
        action_key: actionKey,
        awarded_at: nowIso(),
        day_iso: dayIso,
        points: Math.max(0, Number(points) || 0),
        ref_id: ref,
      };
      t.leader_touch_actions.push(row);
      return { inserted: true, row: clone(row) };
    },
    async countLeaderTouchForDay(leaderUserId, actionKey, dayIso) {
      return t.leader_touch_actions.filter(r =>
        r.leader_user_id === leaderUserId
        && r.action_key === actionKey
        && r.day_iso === dayIso,
      ).length;
    },
    async leaderTouchRowsForDay(leaderUserId, dayIso) {
      return t.leader_touch_actions
        .filter(r => r.leader_user_id === leaderUserId && r.day_iso === dayIso)
        .sort((a, b) => (a.awarded_at < b.awarded_at ? -1 : 1))
        .map(clone);
    },
    async leaderTouchSumByLeaderForDay(dayIso) {
      const map = new Map();
      for (const r of t.leader_touch_actions) {
        if (r.day_iso !== dayIso) continue;
        const cur = map.get(r.leader_user_id) || { pts: 0, n: 0 };
        cur.pts += r.points || 0; cur.n += 1;
        map.set(r.leader_user_id, cur);
      }
      return map;
    },
    async leaderTouchSumByLeaderAll() {
      const map = new Map();
      for (const r of t.leader_touch_actions) {
        const cur = map.get(r.leader_user_id) || { pts: 0, n: 0 };
        cur.pts += r.points || 0; cur.n += 1;
        map.set(r.leader_user_id, cur);
      }
      return map;
    },

    // ---------------- notifications (audit only in phase 1) ----------------
    async recordNotification(fields) {
      const row = {
        id: newId(), status: "pending",
        created_at: nowIso(), ...fields,
        payload: typeof fields.payload === "string"
          ? fields.payload : JSON.stringify(fields.payload || {}),
      };
      t.notifications.push(row);
      return clone(row);
    },
  };
}
