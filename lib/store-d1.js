// D1-backed implementation of the store interface. Every method here
// mirrors one in store-memory.js so handlers can swap freely.

import { newId, nowIso } from "./ids.js";

const activeSql = (t) => `${t}.active = 1`;

export function d1Store(db) {
  const one = async (sql, ...binds) =>
    (await db.prepare(sql).bind(...binds).first()) || null;
  const all = async (sql, ...binds) =>
    ((await db.prepare(sql).bind(...binds).all()).results) || [];
  const run = async (sql, ...binds) =>
    db.prepare(sql).bind(...binds).run();

  return {
    _db: db,

    // ---------------- people ----------------
    async personById(id) {
      return one(`SELECT * FROM people WHERE id = ? AND active = 1`, id);
    },
    async personByPhone(phone) {
      return one(`SELECT * FROM people WHERE phone = ? AND active = 1`, phone);
    },
    async peopleInGroup(groupId) {
      return all(
        `SELECT p.* FROM people p
         JOIN group_membership gm ON gm.person_id = p.id
         WHERE gm.group_id = ? AND gm.active = 1 AND p.active = 1
         ORDER BY p.legal_name`,
        groupId,
      );
    },
    async peopleAssignedTo(userId) {
      return all(
        `SELECT * FROM people
         WHERE assigned_to_user_id = ? AND active = 1
         ORDER BY legal_name`,
        userId,
      );
    },
    async oneMonthDailyCountFor(userId, todayIso, windowDays = 30, minDays = 25) {
      const start = new Date(todayIso + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - windowDays + 1);
      const startIso = start.toISOString().slice(0, 10);
      const total = await one(
        `SELECT COUNT(*) AS n FROM people
          WHERE assigned_to_user_id = ? AND active = 1 AND status = 'daily'`,
        userId,
      );
      const hits = await one(
        `SELECT COUNT(*) AS n FROM (
           SELECT p.id
             FROM people p
             JOIN daily_chant_log d ON d.person_id = p.id
            WHERE p.assigned_to_user_id = ?
              AND p.active = 1
              AND p.status = 'daily'
              AND d.chanted = 1
              AND d.entry_date >= ?
              AND d.entry_date <= ?
            GROUP BY p.id
           HAVING COUNT(DISTINCT d.entry_date) >= ?
         )`,
        userId, startIso, todayIso, minDays,
      );
      return {
        one_month_daily: (hits && hits.n) || 0,
        daily_chanter_total: (total && total.n) || 0,
      };
    },
    async personsByStatus(status) {
      return all(
        `SELECT * FROM people WHERE status = ? AND active = 1
         ORDER BY legal_name`,
        status,
      );
    },
    async searchPeople(query, limit = 50) {
      const q = String(query || "").trim();
      if (!q) return [];
      const like = `%${q.toLowerCase()}%`;
      const digits = q.replace(/\D/g, "");
      const digLike = digits ? `%${digits}%` : "";
      return all(
        `SELECT * FROM people
         WHERE active = 1
           AND (LOWER(legal_name) LIKE ?
             OR (? != '' AND REPLACE(REPLACE(REPLACE(phone,'+',''),'-',''),' ','') LIKE ?))
         ORDER BY legal_name
         LIMIT ?`,
        like, digLike, digLike, limit,
      );
    },
    async peopleCount() {
      const r = await one(`SELECT COUNT(*) AS n FROM people WHERE active = 1`);
      return (r && r.n) || 0;
    },
    async createPerson(fields) {
      const now = nowIso();
      const row = {
        id: fields.id || newId(),
        status: "chanter",
        contact_state: 0,   // NOT NULL in the schema — fill even if caller omitted
        active: 1,
        created_at: now, updated_at: now, ...fields,
      };
      const cols = [
        "id","legal_name","gender","dob","age","marital_status","num_children",
        "spouse_name","spouse_dob","wedding_anniversary","address","phone","email",
        "education","occupation","organization","designation","languages_known",
        "photo_url","status","contact_state","last_marked_at","last_marked_by",
        "assigned_to_user_id","pincode","sl_no","notes","active","created_at","updated_at",
      ];
      await run(
        `INSERT INTO people (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        ...cols.map(c => row[c] ?? null),
      );
      return row;
    },
    async updatePerson(id, patch, by) {
      const existing = await this.personById(id);
      if (!existing) return null;
      const keys = Object.keys(patch).filter(k => k !== "stage_reason");
      if (!keys.length) return existing;
      const now = nowIso();
      const set = keys.map(k => `${k} = ?`).concat("updated_at = ?").join(", ");
      const binds = keys.map(k => patch[k]).concat(now, id);
      await run(`UPDATE people SET ${set} WHERE id = ?`, ...binds);
      if (patch.status && patch.status !== existing.status) {
        await run(
          `INSERT INTO person_stage_log
             (id, person_id, from_status, to_status, changed_at, changed_by, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          newId(), id, existing.status, patch.status, now, by || "system", patch.stage_reason || null,
        );
      }
      return this.personById(id);
    },
    async deletePerson(id, by) {
      const now = nowIso();
      await run(`UPDATE people SET active = 0, updated_at = ? WHERE id = ?`, now, id);
      return { ok: true, id };
    },
    // Conditional upgrade — used by the broadcast queue's Sent-tap.
    // Only moves contact_state from 0 (fresh) → 1 (contacted). Never
    // downgrades a person already at 2 (responded) or higher — the
    // coord clicking Sent in a broadcast is weaker evidence than the
    // responded/needs_visit state a coord set by hand earlier.
    async markContactedIfLower(personId, byUserId) {
      const existing = await this.personById(personId);
      if (!existing) return { ok: false, reason: "not_found" };
      const now = nowIso();
      // Guard: only upgrade when currently 0 (fresh/uncontacted).
      const r = await run(
        `UPDATE people
            SET contact_state = 1,
                last_marked_at = ?,
                last_marked_by = ?,
                updated_at     = ?
          WHERE id = ? AND active = 1 AND contact_state = 0`,
        now, byUserId, now, personId,
      );
      const changed = !!(r && r.meta && r.meta.changes);
      const after = changed ? await this.personById(personId) : existing;
      return {
        ok: true,
        changed,
        contact_state: after.contact_state || 0,
        prior_contact_state: existing.contact_state || 0,
      };
    },
    async bulkCreatePeople(rows) {
      const created = [], duplicates = [], errors = [];
      for (const [i, r] of rows.entries()) {
        if (!r.phone) { errors.push({ index: i, reason: "phone_required" }); continue; }
        if (!r.legal_name) { errors.push({ index: i, reason: "name_required" }); continue; }
        const dup = await this.personByPhone(r.phone);
        if (dup) { duplicates.push({ index: i, phone: r.phone }); continue; }
        const row = await this.createPerson(r);
        created.push(row);
      }
      return { created, duplicates, errors };
    },

    // ---------------- users ----------------
    async userById(id) {
      return one(`SELECT * FROM users WHERE id = ? AND active = 1`, id);
    },
    async userByUsername(username) {
      return one(`SELECT * FROM users WHERE username = ? AND active = 1`, username);
    },
    async listUsersByRole(role) {
      return all(`SELECT * FROM users WHERE role = ? AND active = 1 ORDER BY display_name`, role);
    },
    async nextSlNoFor(userId) {
      const u = await one(`SELECT sl_range_start, sl_range_end FROM users WHERE id = ?`, userId);
      if (!u || u.sl_range_start == null || u.sl_range_end == null) return null;
      // Find the lowest gap in the range by fetching all used sl_nos and
      // scanning. Ranges are 100 numbers so this is fine.
      const rows = await all(
        `SELECT sl_no FROM people
          WHERE sl_no IS NOT NULL AND sl_no >= ? AND sl_no <= ?
          ORDER BY sl_no`,
        u.sl_range_start, u.sl_range_end,
      );
      const used = new Set(rows.map(r => r.sl_no));
      for (let n = u.sl_range_start; n <= u.sl_range_end; n++) {
        if (!used.has(n)) return n;
      }
      return null;
    },
    async createUser(fields) {
      const now = nowIso();
      const row = { id: fields.id || newId(), active: 1, created_at: now, ...fields };
      await run(
        `INSERT INTO users (id, person_id, username, password_hash, display_name, role, phone, email, active, created_at, last_login_at, wa_template_daily, wa_template_nondaily, manager_user_id, sl_range_start, sl_range_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.person_id || null, row.username, row.password_hash,
        row.display_name, row.role, row.phone || null, row.email || null,
        row.active, row.created_at, row.last_login_at || null,
        row.wa_template_daily || null, row.wa_template_nondaily || null,
        row.manager_user_id || null,
        row.sl_range_start ?? null, row.sl_range_end ?? null,
      );
      return row;
    },
    async updateUser(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.userById(id);
      const set = keys.map(k => `${k} = ?`).join(", ");
      const binds = keys.map(k => patch[k]).concat(id);
      await run(`UPDATE users SET ${set} WHERE id = ?`, ...binds);
      return this.userById(id);
    },

    // ---------------- groups ----------------
    async groupById(id) {
      return one(`SELECT * FROM groups WHERE id = ? AND active = 1`, id);
    },
    async listGroupsByKind(kind) {
      return all(`SELECT * FROM groups WHERE kind = ? AND active = 1 ORDER BY name`, kind);
    },
    async listGroupsByLeader(userId) {
      return all(`SELECT * FROM groups WHERE leader_user_id = ? AND active = 1 ORDER BY name`, userId);
    },
    async listGroupsByParent(parentId) {
      return all(`SELECT * FROM groups WHERE parent_group_id = ? AND active = 1 ORDER BY name`, parentId);
    },
    async createGroup(fields) {
      const now = nowIso();
      const row = { id: fields.id || newId(), active: 1, created_at: now, updated_at: now, ...fields };
      const cols = [
        "id","name","kind","parent_group_id","circle_name","sector_name",
        "leader_user_id","deputy_user_id","meeting_day","meeting_time",
        "meeting_venue","language","start_date","target_strength",
        "active","created_at","updated_at",
      ];
      await run(
        `INSERT INTO groups (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        ...cols.map(c => row[c] ?? null),
      );
      return row;
    },
    async updateGroup(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.groupById(id);
      const set = keys.map(k => `${k} = ?`).concat("updated_at = ?").join(", ");
      const binds = keys.map(k => patch[k]).concat(nowIso(), id);
      await run(`UPDATE groups SET ${set} WHERE id = ?`, ...binds);
      return this.groupById(id);
    },
    async deleteGroup(id, by) {
      const now = nowIso();
      await run(`UPDATE groups SET active = 0, updated_at = ? WHERE id = ?`, now, id);
      await run(`UPDATE group_membership SET active = 0, left_at = ? WHERE group_id = ? AND active = 1`, now, id);
      return { ok: true, id };
    },
    async endMembership(memId, by) {
      const now = nowIso();
      await run(`UPDATE group_membership SET active = 0, left_at = ? WHERE id = ?`, now, memId);
      return { ok: true };
    },
    async membershipsInGroup(groupId) {
      return all(`SELECT * FROM group_membership WHERE group_id = ? AND active = 1`, groupId);
    },
    async membershipsForPerson(personId) {
      return all(`SELECT * FROM group_membership WHERE person_id = ? AND active = 1`, personId);
    },
    async addMembership(fields) {
      const now = nowIso();
      const row = {
        id: fields.id || newId(),
        role: fields.role || "member",
        joined_at: now, active: 1, ...fields,
      };
      await run(
        `INSERT INTO group_membership (id, person_id, group_id, role, joined_at, left_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.person_id, row.group_id, row.role,
        row.joined_at, row.left_at || null, row.active,
      );
      return row;
    },

    // ---------------- daily chant ----------------
    async chantOnDate(personId, date) {
      return one(
        `SELECT * FROM daily_chant_log WHERE person_id = ? AND entry_date = ?`,
        personId, date,
      );
    },
    async countChantsOnDate(dateIso) {
      const r = await one(
        `SELECT COUNT(*) AS n FROM daily_chant_log WHERE entry_date = ? AND chanted = 1`,
        dateIso,
      );
      return (r && r.n) || 0;
    },
    // Single aggregate query — was N*M sequential queries before.
    async countChantDaysForCoord(coordId, fromIso, toIso) {
      const r = await one(
        `SELECT COUNT(*) AS n FROM daily_chant_log d
         JOIN people p ON p.id = d.person_id
         WHERE p.assigned_to_user_id = ? AND p.active = 1
           AND d.chanted = 1
           AND d.entry_date >= ? AND d.entry_date <= ?`,
        coordId, fromIso, toIso,
      );
      return (r && r.n) || 0;
    },
    // ---------- fast HK-leaders rollup ----------
    // ONE query returns (coord_id → count) for people in every coord's roll.
    async peopleCountByCoord() {
      const rows = await all(
        `SELECT assigned_to_user_id AS coord_id, COUNT(*) AS n
         FROM people WHERE active = 1 AND assigned_to_user_id IS NOT NULL
         GROUP BY assigned_to_user_id`,
      );
      const map = new Map();
      for (const r of rows) map.set(r.coord_id, r.n);
      return map;
    },
    // ONE query returns (coord_id → count of persons whose last_marked_at
    // is on `dateIso`). Approximates today's follow-ups per coord.
    async followUpsCountByCoordOnDate(dateIso) {
      const rows = await all(
        `SELECT assigned_to_user_id AS coord_id, COUNT(*) AS n
         FROM people
         WHERE active = 1 AND assigned_to_user_id IS NOT NULL
           AND substr(last_marked_at, 1, 10) = ?
         GROUP BY assigned_to_user_id`,
        dateIso,
      );
      const map = new Map();
      for (const r of rows) map.set(r.coord_id, r.n);
      return map;
    },
    // ONE query returns (coord_id → count of DAILY-STATUS persons who
    // chanted on `dateIso`). Used for the primary "SKJ daily-committed
    // chanters who chanted today" scorecard.
    async chantedTodayDailyByCoord(dateIso) {
      const rows = await all(
        `SELECT p.assigned_to_user_id AS coord_id, COUNT(DISTINCT p.id) AS n
         FROM daily_chant_log d
         JOIN people p ON p.id = d.person_id
         WHERE p.active = 1 AND p.status = 'daily'
           AND p.assigned_to_user_id IS NOT NULL
           AND d.entry_date = ? AND d.chanted = 1
         GROUP BY p.assigned_to_user_id`,
        dateIso,
      );
      const map = new Map();
      for (const r of rows) map.set(r.coord_id, r.n);
      return map;
    },
    // ONE query returns (coord_id → count of daily-status persons who
    // have chanted at least once in the last `minWindow` days ending
    // today). "3+ consecutive misses → disqualified" rule: default
    // window is 3, so anyone with 0 chants in the last 3 days doesn't
    // count as consistent.
    async consistentDailyByCoord(todayIso, missWindowDays = 3) {
      const start = new Date(todayIso + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - (missWindowDays - 1));
      const startIso = start.toISOString().slice(0, 10);
      const rows = await all(
        `SELECT p.assigned_to_user_id AS coord_id, COUNT(DISTINCT p.id) AS n
         FROM people p
         WHERE p.active = 1 AND p.status = 'daily'
           AND p.assigned_to_user_id IS NOT NULL
           AND EXISTS (
             SELECT 1 FROM daily_chant_log d
             WHERE d.person_id = p.id AND d.chanted = 1
               AND d.entry_date >= ? AND d.entry_date <= ?
           )
         GROUP BY p.assigned_to_user_id`,
        startIso, todayIso,
      );
      const map = new Map();
      for (const r of rows) map.set(r.coord_id, r.n);
      return map;
    },
    // ONE query returns (coord_id → distinct-persons-chanted) for `dateIso`.
    async chantedCountByCoordOnDate(dateIso) {
      const rows = await all(
        `SELECT p.assigned_to_user_id AS coord_id, COUNT(DISTINCT p.id) AS n
         FROM daily_chant_log d
         JOIN people p ON p.id = d.person_id
         WHERE p.active = 1
           AND p.assigned_to_user_id IS NOT NULL
           AND d.entry_date = ? AND d.chanted = 1
         GROUP BY p.assigned_to_user_id`,
        dateIso,
      );
      const map = new Map();
      for (const r of rows) map.set(r.coord_id, r.n);
      return map;
    },
    // ONE query returns (coord_id → count of daily-status chanters).
    async dailyChanterCountByCoord() {
      const rows = await all(
        `SELECT assigned_to_user_id AS coord_id, COUNT(*) AS n
         FROM people WHERE active = 1 AND status = 'daily'
           AND assigned_to_user_id IS NOT NULL
         GROUP BY assigned_to_user_id`,
      );
      const map = new Map();
      for (const r of rows) map.set(r.coord_id, r.n);
      return map;
    },
    // ONE query returns (coord_id → count of persons with ≥ minDays chants
    // in the window). Approximates the per-coord one-month-daily metric.
    async oneMonthDailyCountByCoord(todayIso, windowDays = 30, minDays = 25) {
      const start = new Date(todayIso + "T00:00:00Z");
      start.setUTCDate(start.getUTCDate() - windowDays + 1);
      const startIso = start.toISOString().slice(0, 10);
      const rows = await all(
        `SELECT p.assigned_to_user_id AS coord_id, COUNT(*) AS n FROM (
           SELECT p2.id AS pid, p2.assigned_to_user_id AS coord_id, COUNT(*) AS days
           FROM daily_chant_log d
           JOIN people p2 ON p2.id = d.person_id
           WHERE p2.active = 1 AND p2.status = 'daily'
             AND p2.assigned_to_user_id IS NOT NULL
             AND d.chanted = 1
             AND d.entry_date >= ? AND d.entry_date <= ?
           GROUP BY p2.id
           HAVING COUNT(*) >= ?
         ) sub
         JOIN people p ON p.id = sub.pid
         GROUP BY p.assigned_to_user_id`,
        startIso, todayIso, minDays,
      );
      const map = new Map();
      for (const r of rows) map.set(r.coord_id, r.n);
      return map;
    },

    // Bulk-fetch chanted=1 rows for a set of persons in a date range.
    // Returns [{person_id, entry_date}] — callers bucket client-side.
    // Used by care-moments to avoid N*M chantOnDate() subrequests.
    async chantDatesForPersonIdsBetween(personIds, fromIso, toIso) {
      if (!personIds || personIds.length === 0) return [];
      const placeholders = personIds.map(() => "?").join(",");
      return all(
        `SELECT person_id, entry_date FROM daily_chant_log
         WHERE chanted = 1
           AND entry_date >= ? AND entry_date <= ?
           AND person_id IN (${placeholders})`,
        fromIso, toIso, ...personIds,
      );
    },

    async hasChantedSince(personId, sinceIso) {
      const r = await one(
        `SELECT 1 AS n FROM daily_chant_log
          WHERE person_id = ? AND chanted = 1 AND entry_date >= ?
          LIMIT 1`,
        personId, sinceIso,
      );
      return !!r;
    },
    async chantsByGroupOnDate(groupId, date) {
      return all(
        `SELECT dcl.* FROM daily_chant_log dcl
         JOIN group_membership gm ON gm.person_id = dcl.person_id
         WHERE gm.group_id = ? AND gm.active = 1 AND dcl.entry_date = ?`,
        groupId, date,
      );
    },
    async upsertChant(fields) {
      const existing = await this.chantOnDate(fields.person_id, fields.entry_date);
      const now = nowIso();
      if (existing) {
        await run(
          `UPDATE daily_chant_log SET chanted = ?, rounds = ?, source = ?, marked_by = ?, marked_at = ?, notes = ?
           WHERE id = ?`,
          fields.chanted ?? existing.chanted,
          fields.rounds ?? existing.rounds ?? null,
          fields.source ?? existing.source,
          fields.marked_by ?? existing.marked_by ?? null,
          now,
          fields.notes ?? existing.notes ?? null,
          existing.id,
        );
        return this.chantOnDate(fields.person_id, fields.entry_date);
      }
      const row = {
        id: newId(), source: "coordinator", chanted: 1,
        marked_at: now, ...fields,
      };
      await run(
        `INSERT INTO daily_chant_log
           (id, person_id, entry_date, chanted, rounds, source, marked_by, marked_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.person_id, row.entry_date, row.chanted ? 1 : 0,
        row.rounds ?? null, row.source, row.marked_by || null,
        row.marked_at, row.notes || null,
      );
      return row;
    },

    // ---------------- feature gates ----------------
    async featureGates() {
      const rows = await all(`SELECT feature_key, allowed_roles FROM feature_gates`);
      const out = {};
      for (const r of rows) out[r.feature_key] = String(r.allowed_roles).split(",").map(s => s.trim());
      return out;
    },
    async setFeatureGate(key, allowedRoles, by) {
      const now = nowIso();
      const csv = allowedRoles.join(",");
      await run(
        `INSERT INTO feature_gates (feature_key, allowed_roles, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(feature_key) DO UPDATE SET
           allowed_roles = excluded.allowed_roles,
           updated_at    = excluded.updated_at,
           updated_by    = excluded.updated_by`,
        key, csv, now, by || null,
      );
    },

    // ---------------- people bulk assign ----------------
    async assignPeopleToUser(personIds, userId) {
      let n = 0;
      const now = nowIso();
      for (const id of personIds) {
        const r = await run(
          `UPDATE people SET assigned_to_user_id = ?, updated_at = ? WHERE id = ?`,
          userId, now, id,
        );
        if (r && r.meta && r.meta.changes) n += r.meta.changes;
      }
      return { assigned: n };
    },

    // ---------------- users list ----------------
    async listAllUsers() {
      return all(`SELECT * FROM users WHERE active = 1 ORDER BY display_name`);
    },

    // ---------------- events / attendance ----------------
    async listEvents(filter = {}) {
      let sql = `SELECT * FROM events WHERE active = 1`;
      const binds = [];
      if (filter.kind) { sql += ` AND kind = ?`; binds.push(filter.kind); }
      if (filter.from) { sql += ` AND event_date >= ?`; binds.push(filter.from); }
      if (filter.to)   { sql += ` AND event_date <= ?`; binds.push(filter.to); }
      sql += ` ORDER BY event_date DESC`;
      return all(sql, ...binds);
    },
    async eventById(id) {
      return one(`SELECT * FROM events WHERE id = ? AND active = 1`, id);
    },
    async createEvent(fields) {
      const now = nowIso();
      const row = { id: fields.id || newId(), active: 1, created_at: now, ...fields };
      await run(
        `INSERT INTO events (id, kind, name, event_date, event_time, venue, capacity, batch_number, group_id, notes, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.kind, row.name, row.event_date,
        row.event_time || null, row.venue || null, row.capacity || null,
        row.batch_number || null, row.group_id || null, row.notes || null,
        row.active, row.created_at,
      );
      return row;
    },
    async updateEvent(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.eventById(id);
      const set = keys.map(k => `${k} = ?`).join(", ");
      await run(`UPDATE events SET ${set} WHERE id = ?`, ...keys.map(k => patch[k]), id);
      return this.eventById(id);
    },
    async deleteEvent(id) {
      await run(`UPDATE events SET active = 0 WHERE id = ?`, id);
      return { ok: true };
    },
    async attendanceForEvent(eventId) {
      return all(`SELECT * FROM attendance WHERE event_id = ?`, eventId);
    },
    async upsertAttendance(fields) {
      const existing = await one(
        `SELECT * FROM attendance WHERE event_id = ? AND person_id = ?`,
        fields.event_id, fields.person_id,
      );
      const now = nowIso();
      if (existing) {
        await run(
          `UPDATE attendance SET attended = ?, marked_by = ?, marked_at = ?, notes = ?
           WHERE id = ?`,
          fields.attended ?? existing.attended,
          fields.marked_by ?? existing.marked_by ?? null,
          now,
          fields.notes ?? existing.notes ?? null,
          existing.id,
        );
        return one(`SELECT * FROM attendance WHERE id = ?`, existing.id);
      }
      const row = {
        id: newId(), attended: 1, marked_at: now, ...fields,
      };
      await run(
        `INSERT INTO attendance (id, event_id, person_id, attended, marked_by, marked_at, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.event_id, row.person_id, row.attended ? 1 : 0,
        row.marked_by || null, row.marked_at, row.notes || null,
      );
      return row;
    },

    // ---------------- sadhana ----------------
    async upsertSadhana(fields) {
      const existing = await one(
        `SELECT * FROM sadhana_entries WHERE person_id = ? AND entry_date = ?`,
        fields.person_id, fields.entry_date,
      );
      const now = nowIso();
      const cols = [
        "wake_up_time","wake_up_pts","mangala_arati_pts",
        "rounds_before_7","rounds_7_8","rounds_8_10","rounds_after_10",
        "chanting_pts","reading_mins","reading_pts","hearing_mins","hearing_pts",
        "seva_pts","preaching_pts","total_pts",
      ];
      if (existing) {
        const set = cols.filter(c => c in fields).map(c => `${c} = ?`);
        set.push(`updated_at = ?`);
        const binds = cols.filter(c => c in fields).map(c => fields[c]);
        binds.push(now, existing.id);
        await run(`UPDATE sadhana_entries SET ${set.join(", ")} WHERE id = ?`, ...binds);
        return one(`SELECT * FROM sadhana_entries WHERE id = ?`, existing.id);
      }
      const row = { id: newId(), created_at: now, updated_at: now, ...fields };
      const allCols = ["id","person_id","entry_date", ...cols, "created_at","updated_at"];
      await run(
        `INSERT INTO sadhana_entries (${allCols.join(",")}) VALUES (${allCols.map(()=>"?").join(",")})`,
        ...allCols.map(c => row[c] ?? 0),
      );
      return row;
    },
    async sadhanaFor(personId, from, to) {
      let sql = `SELECT * FROM sadhana_entries WHERE person_id = ?`;
      const binds = [personId];
      if (from) { sql += ` AND entry_date >= ?`; binds.push(from); }
      if (to)   { sql += ` AND entry_date <= ?`; binds.push(to);   }
      sql += ` ORDER BY entry_date`;
      return all(sql, ...binds);
    },
    async recentSadhana(limit = 20) {
      return all(
        `SELECT * FROM sadhana_entries ORDER BY updated_at DESC LIMIT ?`,
        limit,
      );
    },
    async sadhanaById(id) {
      return one(`SELECT * FROM sadhana_entries WHERE id = ?`, id);
    },
    async deleteSadhanaEntry(id) {
      await run(`DELETE FROM sadhana_entries WHERE id = ?`, id);
      return { ok: true };
    },

    // ---------------- group reports ----------------
    async createGroupReport(fields) {
      const now = nowIso();
      const row = { id: fields.id || newId(), created_at: now, updated_at: now, ...fields };
      const cols = [
        "id","group_id","reported_by","week_number","report_date","period_start","period_end",
        "avg_attendance","highest_attendance","irregular_members","children_program_avg","bvlc_avg",
        "brahmana_initiated","harinama_initiated","guru_ashraya","prabhupada_ashraya",
        "krishna_sadhaka","krishna_sevaka","shraddhavan","potential_leaders",
        "h2h_programs","nagara_sankirtans","outreach_programs","other_preaching",
        "temple_services_engaged","monthly_contributors","contribution_amount","life_members",
        "service_details","other_contribution","created_at","updated_at",
      ];
      await run(
        `INSERT INTO group_reports (${cols.join(",")}) VALUES (${cols.map(()=>"?").join(",")})`,
        ...cols.map(c => row[c] ?? null),
      );
      return row;
    },
    async groupReportById(id) {
      return one(`SELECT * FROM group_reports WHERE id = ?`, id);
    },
    async listGroupReports(groupId) {
      return all(
        `SELECT * FROM group_reports WHERE group_id = ? ORDER BY report_date DESC`,
        groupId,
      );
    },
    async updateGroupReport(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return one(`SELECT * FROM group_reports WHERE id = ?`, id);
      const set = keys.map(k => `${k} = ?`).concat("updated_at = ?").join(", ");
      const binds = keys.map(k => patch[k]).concat(nowIso(), id);
      await run(`UPDATE group_reports SET ${set} WHERE id = ?`, ...binds);
      return one(`SELECT * FROM group_reports WHERE id = ?`, id);
    },
    async deleteGroupReport(id) {
      await run(`DELETE FROM group_reports WHERE id = ?`, id);
      return { ok: true };
    },

    // ---------------- duties ----------------
    async dutiesFor(userId, { onlyPending = true } = {}) {
      const filter = onlyPending ? `AND done_at IS NULL` : ``;
      return all(
        `SELECT * FROM duties
         WHERE user_id = ? AND active = 1 ${filter}
         ORDER BY due_date`,
        userId,
      );
    },
    async dutyById(id) {
      return one(`SELECT * FROM duties WHERE id = ?`, id);
    },
    async deleteDuty(id) {
      await run(`UPDATE duties SET active = 0 WHERE id = ?`, id);
      return { ok: true };
    },
    async createDuty(fields) {
      const row = { id: fields.id || newId(), active: 1, ...fields };
      await run(
        `INSERT INTO duties (id, user_id, kind, target_kind, target_id, due_date, done_at, done_by, notes, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.user_id, row.kind,
        row.target_kind || null, row.target_id || null,
        row.due_date,
        row.done_at || null, row.done_by || null,
        row.notes || null, row.active,
      );
      return row;
    },
    async markDutyDone(id, userId) {
      const now = nowIso();
      await run(
        `UPDATE duties SET done_at = ?, done_by = ? WHERE id = ?`,
        now, userId, id,
      );
      return one(`SELECT * FROM duties WHERE id = ?`, id);
    },

    // ---------------- web push ----------------
    async listWebPushSubs(userId) {
      return all(
        `SELECT * FROM web_push_subscriptions WHERE user_id = ? AND active = 1`,
        userId,
      );
    },
    async addWebPushSub(fields) {
      const now = nowIso();
      const existing = await one(
        `SELECT * FROM web_push_subscriptions WHERE endpoint = ?`,
        fields.endpoint,
      );
      if (existing) {
        await run(`UPDATE web_push_subscriptions SET active = 1 WHERE id = ?`, existing.id);
        return existing;
      }
      const row = { id: newId(), active: 1, created_at: now, ...fields };
      await run(
        `INSERT INTO web_push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.user_id, row.endpoint, row.p256dh, row.auth, row.created_at, row.active,
      );
      return row;
    },
    async removeWebPushSub(endpoint, userId) {
      if (userId) {
        await run(
          `UPDATE web_push_subscriptions SET active = 0 WHERE endpoint = ? AND user_id = ?`,
          endpoint, userId,
        );
      } else {
        await run(`UPDATE web_push_subscriptions SET active = 0 WHERE endpoint = ?`, endpoint);
      }
    },

    // ---------------- leader touch actions ----------------
    // See schema/0010_leader_touch.sql for the ledger shape. Points and
    // uniqueness rules live in application code (lib/handlers.js) —
    // the store just enforces the composite unique index and returns
    // aggregates for the 3-bucket prorated leader leaderboard.
    async logLeaderTouch({ leaderUserId, actionKey, points, dayIso, refId }) {
      const now = nowIso();
      const row = {
        id: newId(),
        leader_user_id: leaderUserId,
        action_key: actionKey,
        awarded_at: now,
        day_iso: dayIso,
        points: Math.max(0, Number(points) || 0),
        ref_id: refId || "",
      };
      // OR IGNORE swallows the UNIQUE(leader,action,day,ref_id) collision
      // so callers can fire this on every eligible event without a
      // pre-check round-trip. Returns whether a row was actually inserted.
      const r = await run(
        `INSERT OR IGNORE INTO leader_touch_actions
           (id, leader_user_id, action_key, awarded_at, day_iso, points, ref_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.leader_user_id, row.action_key,
        row.awarded_at, row.day_iso, row.points, row.ref_id,
      );
      const inserted = !!(r && r.meta && r.meta.changes);
      return { inserted, row };
    },
    // Count of rows this leader already has today for a given action_key
    // — used by the +3-per-coord-per-day cap on contact_coord logging.
    async countLeaderTouchForDay(leaderUserId, actionKey, dayIso) {
      const r = await one(
        `SELECT COUNT(*) AS n FROM leader_touch_actions
          WHERE leader_user_id = ? AND action_key = ? AND day_iso = ?`,
        leaderUserId, actionKey, dayIso,
      );
      return (r && r.n) || 0;
    },
    // All of a leader's touch rows for one day. Callers roll up to
    // buckets (per action_key) for the /api/leader/points-breakdown
    // response so the UI can show the per-action tally.
    async leaderTouchRowsForDay(leaderUserId, dayIso) {
      return all(
        `SELECT action_key, points, ref_id, awarded_at
           FROM leader_touch_actions
          WHERE leader_user_id = ? AND day_iso = ?
          ORDER BY awarded_at`,
        leaderUserId, dayIso,
      );
    },
    // ONE query returns (leader_user_id → total touch points that day).
    // Feeds the leader leaderboard's 15%-weight Leader-Touch bucket in
    // a single round-trip rather than N per-leader queries.
    async leaderTouchSumByLeaderForDay(dayIso) {
      const rows = await all(
        `SELECT leader_user_id AS leader_id, SUM(points) AS pts,
                COUNT(*) AS n
           FROM leader_touch_actions
          WHERE day_iso = ?
          GROUP BY leader_user_id`,
        dayIso,
      );
      const map = new Map();
      for (const r of rows) map.set(r.leader_id, { pts: r.pts || 0, n: r.n || 0 });
      return map;
    },
    // Cumulative Leader-Touch across all days (overall board).
    async leaderTouchSumByLeaderAll() {
      const rows = await all(
        `SELECT leader_user_id AS leader_id, SUM(points) AS pts, COUNT(*) AS n
           FROM leader_touch_actions
          GROUP BY leader_user_id`,
      );
      const map = new Map();
      for (const r of rows) map.set(r.leader_id, { pts: r.pts || 0, n: r.n || 0 });
      return map;
    },

    // ---------------- notifications ----------------
    async recordNotification(fields) {
      const row = {
        id: newId(), status: "pending",
        created_at: nowIso(), ...fields,
      };
      const payload = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload || {});
      await run(
        `INSERT INTO notifications
           (id, kind, target_user_id, target_person_id, payload, scheduled_for, status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id, row.kind,
        row.target_user_id || null, row.target_person_id || null,
        payload, row.scheduled_for || null,
        row.status, row.error || null, row.created_at,
      );
      return row;
    },
  };
}
