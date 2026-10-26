// Id + timestamp helpers. All ids are uuid v4 strings. Timestamps are
// ISO-8601 in the temple's timezone (Asia/Kolkata). "today" and "now"
// live here so tests can override.

// crypto.randomUUID() is a Web Crypto global in both Cloudflare Workers
// and Node.js >= 19, so no Node-specific fallback is needed.
export function newId() {
  return crypto.randomUUID();
}

const APP_TZ = "Asia/Kolkata";

export function nowIso() {
  return new Date().toISOString();
}

export function todayInTz(tz = APP_TZ) {
  return dateInTz(new Date(), tz);
}

// YYYY-MM-DD of an instant in the target timezone. Stored timestamps
// (last_marked_at etc.) are UTC ISO strings, so slicing them gives the
// UTC date — wrong for anything marked 00:00–05:30 IST.
export function dateInTz(instant, tz = APP_TZ) {
  if (!instant) return null;
  const date = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(date)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const y = parts.find(p => p.type === "year").value;
  const m = parts.find(p => p.type === "month").value;
  const d = parts.find(p => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

// [start, end) UTC ISO bounds of a local calendar day, for range
// comparisons on UTC timestamp columns.
export function utcBoundsOfLocalDay(dateIso, tz = APP_TZ) {
  const offsetAt = (t) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
  };
  const midnight = (iso) => {
    const guess = Date.parse(iso + "T00:00:00Z");
    return new Date(guess - offsetAt(guess)).toISOString();
  };
  const next = new Date(Date.parse(dateIso + "T00:00:00Z") + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return [midnight(dateIso), midnight(next)];
}

export function daysBetween(a, b) {
  const da = new Date(a + "T00:00:00Z");
  const db = new Date(b + "T00:00:00Z");
  return Math.round((db - da) / (24 * 60 * 60 * 1000));
}
