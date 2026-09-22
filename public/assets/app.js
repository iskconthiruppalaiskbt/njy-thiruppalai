// NJY — single-page client with hash routing. Views are role-gated
// on the server (via feature_gates); we mirror the check in the UI so
// only relevant nav items render, but the server remains authoritative.

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else if (v != null && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

// Turn a raw error code from the server (or an in-app validation code)
// into a friendly, actionable sentence the operator can act on. Add a
// case here whenever the backend introduces a new bad(...) code, so the
// UI never falls back to opaque "http_500" or "duplicate_phone".
const ERROR_MESSAGES = {
  // Auth
  invalid_credentials: "Wrong username or password.",
  missing_credentials: "Type both username and password.",
  wrong_current_password: "Current password is wrong.",
  password_too_short: "New password must be at least 6 characters.",
  both_passwords_required: "Fill in both current and new password.",
  session_secret_missing: "Server misconfigured (SESSION_SECRET not set). Contact admin.",
  unauthorized: "You need to sign in again.",
  forbidden: "You don't have permission for this action.",
  // Not found
  not_found: "Nothing found at this path.",
  user_not_found: "That user doesn't exist.",
  target_user_not_found: "The user you're trying to update doesn't exist.",
  person_not_found: "That member doesn't exist.",
  event_not_found: "That event doesn't exist.",
  leader_not_found: "That NJY Leader doesn't exist.",
  duty_not_found: "That duty doesn't exist.",
  not_your_roll: "That member belongs to a different coordinator.",
  // Users
  username_taken: "That username is already used, pick another.",
  missing_fields: "One or more required fields are blank.",
  bad_role: "Role must be one of: hk_leader, njy_leader, njy_coordinator, servant_leader, sector_servant, circle_servant.",
  manager_not_found: "manager_username points to a leader that doesn't exist yet. Did you import the leader row first?",
  // Chanter import
  duplicate_phone: "A member with that phone number already exists.",
  duplicate_coupon: "A member with that coupon number already exists.",
  duplicate_sl_no: "That serial number is already used.",
  coupon_or_range_required: "Enter a coupon number, or ask Director to assign your coord an sl_range.",
  range_exhausted_or_missing: "Your assigned sl_no range is exhausted. Ask Director to widen it.",
  name_and_mobile_required: "Both name and mobile are required.",
  // Bulk
  rows_required: "The request had no rows to import.",
  bad_body: "The request body was malformed.",
  bad_status: "That status value isn't allowed.",
  no_templates: "Nothing was changed. WhatsApp templates were empty.",
  bad_subscription: "Push subscription data was incomplete.",
  endpoint_required: "Push endpoint missing.",
  person_id_required: "Missing person_id.",
  person_ids_required: "Select at least one member first.",
  user_id_required: "Pick a coordinator to assign to.",
  leader_username_required: "Pick which leader the new coordinator reports to.",
  not_your_coord: "That coordinator isn't in your team.",
  bad_sl_no: "SL can only contain letters, digits, and hyphens (max 32 chars).",
  username_required: "Type a username first.",
  group_id_required: "Missing group_id.",
  // Network / HTTP
  http_400: "The server rejected the request (400 Bad Request). Check your input.",
  http_401: "Session expired. Sign in again.",
  http_403: "You don't have permission for this action.",
  http_404: "Not found.",
  http_409: "That conflicts with existing data (usually a duplicate).",
  http_500: "The server hit an error. Try again in a minute; if it repeats, check dev console for the exact cause.",
  http_502: "Server unreachable (bad gateway). Cloudflare may still be deploying. Wait 60 seconds and retry.",
  http_503: "Server temporarily unavailable. Retry shortly.",
};
// Preferred lookup: the i18n dictionary. Falls back to the English
// ERROR_MESSAGES table above (which is the source of truth for the
// English copy), then to the raw code. This keeps every operator-visible
// server-error sentence translatable while remaining backward-safe.
function localizedError(code) {
  const key = "err." + code;
  const translated = t(key);
  if (translated !== key) return translated;
  return ERROR_MESSAGES[code] || null;
}
function humanizeError(err) {
  if (!err) return t("err.generic") !== "err.generic" ? t("err.generic") : "Something went wrong.";
  if (typeof err === "string") return localizedError(err) || err;
  const code = err.body?.error || err.error || err.message || "";
  const direct = localizedError(code);
  if (direct) return direct;
  if (err.status) {
    const gen = localizedError(`http_${err.status}`);
    if (gen) return `${gen} (code: ${code})`;
  }
  return code || String(err);
}
window.humanizeError = humanizeError;

const api = async (path, opts = {}) => {
  const method = (opts.method || "GET").toUpperCase();
  try {
    const res = await fetch(path, {
      ...opts, credentials: "same-origin",
      headers: { "content-type": "application/json", ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Structured console log for every API failure — the top ask
      // was "why nothing in console??? everytime it comes error, must
      // be in console across everywhere". So we ALWAYS log the path,
      // status, and full server payload with a group so it's easy to
      // scan in devtools.
      console.groupCollapsed(`%c[api] ${method} ${path} → ${res.status}`, "color:#c02020;font-weight:600");
      console.log("error:", body.error || "(none)");
      console.log("body:", body);
      console.log("request opts:", opts);
      console.groupEnd();
      // Raw code preserved for exact-match branches (e.g. some UIs
      // still branch on wrong_current_password). But err.message is
      // now the FRIENDLY sentence, so every "catch (err) { view.append
      // (err.message) }" spot upgrades automatically without touching
      // 30 call sites.
      const code = body.error || `http_${res.status}`;
      const friendly = humanizeError({ body, status: res.status });
      const e = new Error(friendly);
      e.code = code;
      e.status = res.status; e.body = body; e.path = path; e.method = method;
      throw e;
    }
    // Successful non-200 (like 207 partial), or a 200 with an `errors`
    // array (common on bulk endpoints) — surface it too.
    if (Array.isArray(body.errors) && body.errors.length) {
      console.groupCollapsed(`%c[api] ${method} ${path} → 200 with ${body.errors.length} row error(s)`, "color:#c07a00;font-weight:600");
      body.errors.slice(0, 10).forEach((e, i) => console.log(`row ${i}:`, e));
      if (body.errors.length > 10) console.log(`…${body.errors.length - 10} more`);
      console.groupEnd();
    }
    return body;
  } catch (netErr) {
    if (netErr && netErr.status != null) throw netErr; // already logged above
    console.error(`[api] ${method} ${path} — network/JS error:`, netErr);
    throw netErr;
  }
};

// Global safety net — any promise rejection or JS error that reaches
// the runtime unwrapped goes to console with context. Without this a
// silent await in an event handler dies with no trace.
window.addEventListener("unhandledrejection", (e) => {
  console.error("[unhandledrejection]", e.reason);
});
window.addEventListener("error", (e) => {
  console.error("[window.error]", e.message, "at", e.filename + ":" + e.lineno, e.error);
});

const STATE_LABEL = ["uncontacted", "contacted", "responded"];
const LIFECYCLE = ["chanter","daily","njy1","njy2","njy3","manjari","bv_member","dropped"];
// Prettify lifecycle enum values for dropdown display (Plan 4: statuses
// should read Daily, not daily). Special cases keep NJY / BV as acronyms.
const LIFECYCLE_LABEL = {
  chanter: "Member",
  daily: "Daily",
  njy1: "NJY 1",
  njy2: "NJY 2",
  njy3: "NJY 3",
  manjari: "Manjari",
  bv_member: "BV Member",
  dropped: "Dropped",
};
function lifecycleLabel(s) { return LIFECYCLE_LABEL[s] || s; }

// Compute the 5-color bead on the client after a mark/chant tap. The
// server does the authoritative first render (including the 3-day-miss
// red state); after that, tap-driven updates use this cheap local
// recompute so we don't refetch on every click.
function recomputeBead(r) {
  // Red survives a mark tap only if the server flagged it originally
  // and the person hasn't chanted since. Simplest: assume red persists
  // until the next render refresh unless the user just chanted.
  if (r.bead_color === "red" && !r.chanted_today) return "red";
  if (r.chanted_today) return "green";
  if (r.contact_state === 2) return "orange";
  if (r.contact_state === 1) return "yellow";
  return "white";
}
const humanRole = (r) => t("role." + r) !== "role." + r ? t("role." + r) : r;

// Adjust a devotee's legal name into the form used in WhatsApp greetings:
//   1. Strip a leading honorific prefix (HG / HH / Bhakta / Bhaktin /
//      Srila / Sri) so "HG Adideva Giridhari Dasa" collapses to
//      "Adideva Giridhari Dasa".
//   2. Suffix swap (whole-word, case-insensitive):
//        "Devi Dasi"    → "Mataji"   (checked BEFORE "Dasi" alone)
//        "Dasi"         → "Mataji"
//        "Dasa" / "Das" → "Prabhu"
// A pre-initiate ("Anand") returns unchanged. Server-side twin lives in
// lib/handlers.js honorificAdjust() — keep the two in sync.
function honorificAdjust(name) {
  if (!name) return "";
  let out = String(name).trim();
  const PREFIX_RE = /^(?:HG|HH|Srila|Sri|Bhakta|Bhaktin)\b[.\s]+/i;
  while (PREFIX_RE.test(out)) out = out.replace(PREFIX_RE, "");
  if (/\bDevi\s+Dasi\b/i.test(out)) {
    out = out.replace(/\bDevi\s+Dasi\b/i, "Mataji");
  } else if (/\bDasi\b/i.test(out)) {
    out = out.replace(/\bDasi\b/i, "Mataji");
  } else if (/\b(?:Dasa|Das)\b/i.test(out)) {
    out = out.replace(/\b(?:Dasa|Das)\b/i, "Prabhu");
  }
  return out.replace(/\s+/g, " ").trim();
}

// Infer gender from a devotee display_name by matching honorific suffixes.
// Returns "F", "M", or "?" — never null so callers can compare with ===.
// Used by the gender-aware bulk-assign UI (Members tab, HK view).
//   "Mataji", "Devi Dasi", "Dasi", "Bhaktin"     → F
//   "Prabhu", "Dasa", "Das", "Bhakta"            → M
//   Anything else (pre-initiate or ambiguous)    → ?
function inferGender(name) {
  if (!name) return "?";
  const s = String(name);
  if (/\b(?:Mataji|Devi\s+Dasi|Dasi|Bhaktin)\b/i.test(s)) return "F";
  if (/\b(?:Prabhu|Dasa|Das|Bhakta)\b/i.test(s)) return "M";
  return "?";
}

// Preferred entrypoint for coord/leader gender: trust the DB value if
// present (populated by migration 0016 + the name-heuristic seed
// 06-coord-genders.sql), else fall back to display-name inference.
// Accepts either a user object ({gender, display_name}) or a raw name.
function userGender(u) {
  if (u && typeof u === "object") {
    const raw = String(u.gender || "").toUpperCase();
    if (raw === "M" || raw === "F") return raw;
    return inferGender(u.display_name || u.name || "");
  }
  return inferGender(u);
}

let ME = null, GATES = {};

// -------------------------------------- route token (BUG 1+2) ------
// Global monotonic token bumped by every hashchange-driven renderRoute().
// Any render function that does `await api(...)` before painting should
// capture `const myToken = routeToken;` at the top and, after each await,
// bail with `if (myToken !== routeToken) return;`. This prevents an
// earlier route's stale fetch from appending its UI onto whatever
// screen the user has since navigated to. NOTE: the sort toggle inside
// renderLeaderboard re-invokes renderLeaderboard(kind, rest) directly —
// that path does NOT bump the token (only renderRoute does), so
// intra-page re-renders still work correctly.
let routeToken = 0;

// ------------------------------------------------------------ boot ---
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  // Only re-render the nav if we're actually signed in — otherwise
  // ME is still null and renderNav() reads ME.role and crashes.
  if (ME) renderNav();
});
(async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  try {
    const me = await api("/api/me");
    if (me.user) { ME = me.user; GATES = me.gates; return showApp(); }
  } catch (_) {}
  showLogin();
})();

window.addEventListener("hashchange", () => { if (ME) renderRoute(); });

// ----------------------------------------------------------- login ---
function showLogin() {
  $("view-app").hidden = true;
  $("view-login").hidden = false;
  // Translate login screen
  if ($("login-title")) $("login-title").textContent = t("login.title");
  if ($("login-u-label")) $("login-u-label").textContent = t("field.username");
  if ($("login-p-label")) $("login-p-label").textContent = t("field.password");
  if ($("login-btn")) $("login-btn").textContent = t("btn.sign_in");
  if ($("login-hint")) $("login-hint").textContent = t("login.contact_authority");
  // Language toggle on the login card — same behaviour as the post-login
  // header toggle: click flips to the other language, persists in
  // localStorage, reloads. Kept on the login screen so devotees can pick
  // Tamil BEFORE signing in.
  const loginLang = $("login-lang-toggle");
  if (loginLang) {
    const cur = getLang();
    const other = window.LANGS.find(l => l.code !== cur);
    loginLang.textContent = "🌐 " + other.label;
    loginLang.onclick = (e) => { e.preventDefault(); setLang(other.code); };
  }
  // Wire the eye toggle on the login password
  const eye = $("login-eye");
  if (eye && !eye._wired) {
    eye._wired = true;
    eye.addEventListener("click", () => {
      const p = $("p");
      if (p.type === "password") { p.type = "text"; eye.textContent = "🙈"; }
      else { p.type = "password"; eye.textContent = "👁"; }
    });
  }
  $("login-form").onsubmit = async (e) => {
    e.preventDefault();
    $("login-err").hidden = true;
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({
        username: $("u").value.trim(), password: $("p").value,
      })});
      const me = await api("/api/me");
      ME = me.user; GATES = me.gates;
      showApp();
    } catch { $("login-err").textContent = t("msg.wrong_password"); $("login-err").hidden = false; }
  };
}

// ------------------------------------------------------------- app ---
async function showApp() {
  $("view-login").hidden = true;
  $("view-app").hidden = false;
  $("who-name").textContent = ME.display_name;
  $("who-role").textContent = " · " + humanRole(ME.role);
  $("logout").textContent = t("nav.sign_out");
  $("logout").onclick = async (e) => { e.preventDefault(); await api("/api/logout", { method: "POST" }); location.hash = ""; location.reload(); };
  renderHeaderContactPills();
  // Language quick-toggle in header
  const langBtn = $("lang-toggle");
  if (langBtn) {
    const cur = getLang();
    const other = window.LANGS.find(l => l.code !== cur);
    langBtn.textContent = "🌐 " + other.label;
    langBtn.onclick = (e) => { e.preventDefault(); setLang(other.code); };
  }
  renderNav();
  renderRoute();
  refreshPointsChip();
  refreshLbSide();
  refreshDupPendingCount();
  maybeShowOnboardingTour();
}

// Poll the pending-duplicate-count endpoint once on boot and after every
// resolve, so the HK nav badge and the leader Team-page info line stay
// current without a full-page reload. Coord role gets it too but doesn't
// render a badge (their submission returns the same count).
async function refreshDupPendingCount() {
  try {
    if (!["hk_leader", "njy_leader", "njy_coordinator"].includes(ME.role)) return;
    const { count } = await api("/api/duplicate-requests/pending-count");
    window._njyPendingDupCount = count || 0;
    if (ME.role === "hk_leader") renderNav();
  } catch { /* silent */ }
}

// Show a 5-slide onboarding tour to a coordinator EVERY sign-in until
// they tap "Never Show Again". Dismissal via that button is remembered
// in localStorage per user id so the tour never nags after opt-out. The
// close (X)/backdrop tap dismisses this session only, without persisting.
function maybeShowOnboardingTour() {
  if (ME.role !== "njy_coordinator") return;
  const key = "njy-tour-never-" + ME.id;
  try { if (localStorage.getItem(key)) return; } catch { /* private mode */ }

  const slides = [
    { emoji: "🙏 🌸", title: t("tour.slide1_title"), body: t("tour.slide1_body") },
    { emoji: "⚪ 🟡 🟠 🟢 🔴", title: t("tour.slide2_title"), body: t("tour.slide2_body") },
    { emoji: "✓ " + t("btn.chanted").replace("✓ ",""), title: t("tour.slide3_title"), body: t("tour.slide3_body") },
    { emoji: "💬", title: t("tour.slide4_title"), body: t("tour.slide4_body") },
    { emoji: "🪙 🏆", title: t("tour.slide5_title"), body: t("tour.slide5_body") },
  ];

  const overlay = el("div", { class: "tour-overlay" });
  const card = el("div", { class: "tour-card", role: "dialog", "aria-modal": "true" });
  overlay.append(card);
  document.body.append(overlay);

  let i = 0;
  const closeSession = () => { overlay.remove(); };
  const dismissForever = () => {
    try { localStorage.setItem(key, "1"); } catch {}
    overlay.remove();
  };
  const render = () => {
    const s = slides[i];
    card.innerHTML = "";
    const actions = el("div", { class: "tour-actions", style: "display:flex;gap:.4rem;flex-wrap:wrap;align-items:center;justify-content:space-between" });
    // Left: Never Show Again (persistent opt-out)
    const neverBtn = el("button", { class: "tour-skip", type: "button" }, t("btn.never_show_again"));
    neverBtn.addEventListener("click", dismissForever);
    // Right: back + next/got-it
    const navRow = el("div", { style: "display:flex;gap:.4rem" });
    if (i > 0) {
      const backBtn = el("button", { class: "btn", type: "button" }, t("btn.tour_back"));
      backBtn.addEventListener("click", () => { i--; render(); });
      navRow.append(backBtn);
    }
    const nextBtn = el("button", { class: "primary", type: "button" },
      i === slides.length - 1 ? t("btn.got_it") : t("btn.tour_next"));
    nextBtn.addEventListener("click", () => {
      if (i === slides.length - 1) closeSession();
      else { i++; render(); }
    });
    navRow.append(nextBtn);
    actions.append(neverBtn, navRow);

    card.append(
      el("div", { class: "tour-emoji-row" }, s.emoji),
      el("h3", {}, s.title),
      el("p", { class: "tour-body", html: s.body }),
      el("div", { class: "tour-progress" },
        ...slides.map((_, idx) => el("span", { class: idx === i ? "on" : "" })),
      ),
      actions,
    );
  };
  render();
}
// Expose a way to relaunch the tour from anywhere (for testing).
window.replayTour = () => {
  try {
    localStorage.removeItem("njy-tour-never-" + ME.id);
    localStorage.removeItem("njy-tour-done-" + ME.id);  // legacy key from pre-v59
  } catch {}
  maybeShowOnboardingTour();
};

// Header points chip — small oval showing today's and overall points.
// Coord:   own points (existing /api/me/points).
// Leader:  their team roll-up from /api/leaderboard/leaders/*, own row.
// HK:      sum across every leader row (whole-install total).
async function refreshPointsChip() {
  const chip = $("pts-chip");
  if (!chip) return;

  const render = (todayN, overallN, href) => {
    chip.innerHTML = "";
    if (href) chip.setAttribute("href", href);
    chip.append(
      t("chip.today") + " ", el("span", { class: "pts-num" }, String(todayN || 0)),
      el("span", { class: "pts-sep" }, " · "),
      t("chip.overall") + " ", el("span", { class: "pts-num" }, String(overallN || 0)),
    );
    chip.hidden = false;
  };

  try {
    if (ME.role === "njy_coordinator") {
      const p = await api("/api/me/points");
      if (!p.applicable) { chip.hidden = true; return; }
      render(p.daily, p.overall, "#/profile");
      return;
    }

    if (ME.role === "njy_leader") {
      // Own leader row on daily + overall leader boards.
      const [daily, overall] = await Promise.all([
        api("/api/leaderboard/leaders/daily").catch(() => ({ rows: [] })),
        api("/api/leaderboard/leaders/overall").catch(() => ({ rows: [] })),
      ]);
      const dRow = (daily.rows || []).find(r => r.user_id === ME.id) || {};
      const oRow = (overall.rows || []).find(r => r.user_id === ME.id) || {};
      render(dRow.pts, oRow.pts, "#/leaderboard/leaders");
      return;
    }

    if (ME.role === "hk_leader") {
      // Roll-up: sum every leader's team on both scopes.
      const [daily, overall] = await Promise.all([
        api("/api/leaderboard/leaders/daily").catch(() => ({ rows: [] })),
        api("/api/leaderboard/leaders/overall").catch(() => ({ rows: [] })),
      ]);
      const sum = (rows) => (rows || []).reduce((s, r) => s + (r.pts || 0), 0);
      render(sum(daily.rows), sum(overall.rows), "#/leaderboard/leaders");
      return;
    }

    chip.hidden = true;
  } catch (_) { chip.hidden = true; }
}
window.refreshPointsChip = refreshPointsChip;

// Persistent header Contact pills — always visible in the top-right so
// the user can WhatsApp their upstream contact from any page.
//   njy_coordinator → "💬 Leader" + "💬 HK"
//   njy_leader      → "💬 HK"
//   hk_leader       → omitted (no upstream)
// Reuses ME.manager_phone / ME.hk_phone (already returned by /api/me);
// no new endpoint. Pills open api.whatsapp.com/send/?phone=<digits>
// (same fix as CHANGE 1 — no wa.me redirect that mangles emoji).
function renderHeaderContactPills() {
  // Remove any previous pass (re-render on language change / role switch).
  document.querySelectorAll(".hdr-contact").forEach(n => n.remove());
  const line = document.querySelector(".who-line");
  if (!line) return;
  const logout = $("logout");
  const pill = (label, phone) => {
    const digits = String(phone || "").replace(/[^\d]/g, "");
    if (!digits) return null;
    return el("a", {
      class: "hdr-contact",
      href: `https://api.whatsapp.com/send/?phone=${digits}`,
      target: "_blank", rel: "noopener",
      title: `WhatsApp ${label}: ${phone}`,
    }, "💬 ", label);
  };
  const pills = [];
  if (ME.role === "njy_coordinator") {
    const p1 = pill(t("pill.leader"), ME.manager_phone); if (p1) pills.push(p1);
    const p2 = pill(t("pill.hk"), ME.hk_phone); if (p2) pills.push(p2);
  } else if (ME.role === "njy_leader") {
    const p = pill(t("pill.hk"), ME.hk_phone); if (p) pills.push(p);
  }
  // Insert before logout so the order reads: name · role | contact... | Sign out | lang
  for (const p of pills) line.insertBefore(p, logout);
}
window.renderHeaderContactPills = renderHeaderContactPills;

// Floating leaderboard sidebar — desktop-only, always visible while
// scrolling. Shows today's top 3 coords + your own rank if you're
// competing. Refreshes every 45 seconds so numbers stay live.
let _lbSideTimer = null;
async function refreshLbSide() {
  const side = $("lb-side");
  const strip = $("lb-strip");
  if (!side && !strip) return;
  const isCompetitor = ["njy_coordinator","njy_leader","hk_leader"].includes(ME.role);
  if (!isCompetitor) {
    if (side) side.hidden = true;
    if (strip) strip.hidden = true;
    return;
  }
  try {
    const { rows } = await api("/api/leaderboard/daily");
    // --- mobile strip: top 3 + you (compact, single row) ---
    if (strip) {
      strip.innerHTML = "";
      const inner = el("div", { class: "lb-strip-inner" });
      const top3s = rows.slice(0, 3);
      const medalsS = ["🥇","🥈","🥉"];
      if (!top3s.length) {
        inner.append(el("span", { class: "lb-strip-empty" }, t("hd.no_points_yet_today")));
      } else {
        top3s.forEach((r, i) => {
          inner.append(el("span", { class: "lb-strip-slot" + (r.user_id === ME.id ? " me" : "") },
            el("span", {}, medalsS[i]),
            el("span", { class: "nm", title: r.name }, r.name),
            el("span", { class: "pt" }, String(r.pts)),
          ));
        });
        const myIdx = rows.findIndex(r => r.user_id === ME.id);
        if (myIdx >= 3) {
          inner.append(el("span", { class: "lb-strip-slot you" },
            el("span", {}, "🪙"),
            el("span", { class: "nm" }, `${t("lb.you")} #${myIdx + 1}`),
            el("span", { class: "pt" }, String(rows[myIdx].pts)),
          ));
        }
      }
      inner.append(el("a", { class: "lb-strip-more", href: "#/leaderboard/daily" }, t("lb.full_short")));
      strip.append(inner);
      strip.hidden = false;
    }
    if (!side) {
      clearTimeout(_lbSideTimer);
      _lbSideTimer = setTimeout(refreshLbSide, 45_000);
      return;
    }
    side.innerHTML = "";
    side.append(el("h4", {}, t("hd.today_leaders"), el("span", { style: "font-size:.7rem;color:var(--muted)" }, "🏆")));
    const top3 = rows.slice(0, 3);
    if (!top3.length) {
      side.append(el("p", { class: "hint", style: "font-size:.75rem" }, t("hd.no_points_yet_today")));
      side.hidden = false;
      return;
    }
    const container = el("div", { class: "lb-rows" });
    const medals = ["🥇","🥈","🥉"];
    top3.forEach((r, i) => {
      container.append(el("div", { class: "lb-row" + (r.user_id === ME.id ? " me" : "") },
        el("span", {}, medals[i]),
        el("span", { class: "name", title: r.name }, r.name),
        el("span", { class: "pts" }, String(r.pts)),
      ));
    });
    side.append(container);
    // Always show a dedicated "You" row so the coord sees where they
    // stand — even if they're in the top three, they see it here in
    // the golden coin style, not just implicit.
    const myIdx = rows.findIndex(r => r.user_id === ME.id);
    if (ME.role === "njy_coordinator" && myIdx >= 0) {
      const me = rows[myIdx];
      side.append(el("div", { class: "lb-you-row" },
        el("span", { class: "lb-you-label" }, t("lb.you")),
        el("span", { class: "lb-you-rank" }, `#${myIdx + 1}`),
        el("span", { class: "lb-you-pts" }, `${me.pts} pts`),
      ));
    }
    side.append(el("a", { class: "lb-open", href: "#/leaderboard/daily" }, t("lb.full_link")));
    side.hidden = false;
  } catch (_) { side.hidden = true; }
  clearTimeout(_lbSideTimer);
  _lbSideTimer = setTimeout(refreshLbSide, 45_000);
}
window.refreshLbSide = refreshLbSide;

function can(feature) {
  if (ME.role === "hk_leader") return true;
  return (GATES[feature] || []).includes(ME.role);
}

function renderNav() {
  const nav = $("nav"); nav.innerHTML = "";
  // Nav visibility is CURATED per role — separate from feature-gate
  // access. HK Leader still has permission to visit every URL directly,
  // but tabs only appear when they're part of that role's day-to-day
  // work. Rule of thumb:
  //   - "My roll"   → the person who *owns* a chanter list
  //   - "Sadhana"   → BV Member (self-fills) or Servant Leader (reviews)
  //   - "BV"        → structure editors (CS/SS + HK for setup)
  const OWNS_ROLL = ["njy_coordinator", "servant_leader", "member"];
  const SADHANA_ROLES = ["servant_leader", "member", "sector_servant", "circle_servant"];
  const BV_ROLES = ["hk_leader", "circle_servant", "sector_servant", "servant_leader"];
  const items = [
    { href: "#/",          label: t("nav.my_roll"),  when: () => can("coordinator_roll") && OWNS_ROLL.includes(ME.role) },
    { href: "#/leader",    label: t("nav.team"),     when: () => can("leader_dashboard") },
    // HK tab hidden for HK Leader — the Team tab now carries the 4 KPI
    // tiles + all coordinators. Other roles (if ever granted hk_dashboard
    // by feature-gate) still see it.
    { href: "#/hk",        label: t("nav.hk"),       when: () => can("hk_dashboard") && ME.role !== "hk_leader" },
    { href: "#/leaderboard", label: t("nav.leaderboard"), when: () => (can("leaderboard_coord_daily") || can("leaderboard_coord_overall") || can("leaderboard_leaders_daily") || can("leaderboard_leaders_overall")) && ["njy_coordinator","njy_leader","hk_leader"].includes(ME.role) },
    { href: "#/duties",    label: t("nav.duties"),   when: () => true },
    { href: "#/events",    label: t("nav.events"),   when: () => can("event_attendance") || can("events_view_list") },
    { href: "#/sadhana",   label: t("nav.sadhana"),  when: () => can("sadhana_chart") && SADHANA_ROLES.includes(ME.role) },
    { href: "#/bv",        label: t("nav.bv"),       when: () => can("bv_structure_editor") && BV_ROLES.includes(ME.role) },
    { href: "#/janmashtami", label: t("nav.janmashtami"), when: () => can("janmashtami_view_page") && ["njy_coordinator","njy_leader","hk_leader"].includes(ME.role) },
    { href: "#/members",     label: t("nav.members"),     when: () => can("members_tab") && ["hk_leader","njy_leader","njy_coordinator"].includes(ME.role) },
    { href: "#/duplicates",  label: t("dup.nav_link"),    when: () => ME.role === "hk_leader",
      badge: () => window._njyPendingDupCount || 0 },
    { href: "#/profile",     label: t("nav.profile"), when: () => ["njy_coordinator","njy_leader","hk_leader"].includes(ME.role) },
    { href: "#/settings",  label: t("nav.settings"), when: () => ["njy_coordinator","njy_leader","hk_leader","servant_leader","manjari_servant_leader"].includes(ME.role) },
    { href: "#/admin",     label: t("nav.admin"),    when: () => can("feature_admin") },
  ];
  const here = location.hash || "#/";
  for (const it of items) {
    if (!it.when()) continue;
    const a = el("a", { href: it.href, class: (here === it.href ? "active" : "") }, it.label);
    // Small count badge (red pill) rendered inside the nav item when
    // the entry defines a badge() reader returning a positive number.
    if (typeof it.badge === "function") {
      const n = it.badge();
      if (n && n > 0) {
        a.append(el("span", {
          style: "display:inline-block;margin-left:.35rem;padding:0 .4rem;"
               + "background:#c0392b;color:#fff;border-radius:999px;"
               + "font-size:.72rem;font-weight:700;line-height:1.3;"
               + "vertical-align:middle",
        }, String(n)));
      }
    }
    nav.append(a);
  }
  if (deferredInstall) {
    const btn = el("a", { href: "#", style: "background:var(--tint-followed);border-color:var(--mark-followed);color:var(--mark-followed);margin-left:auto" }, t("nav.install"));
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      deferredInstall.prompt();
      await deferredInstall.userChoice.catch(() => {});
      deferredInstall = null; renderNav();
    });
    nav.append(btn);
  }
}

// ------------------------------------------------------ router ---
function renderRoute() {
  routeToken++;  // BUG 1+2: invalidate any in-flight fetches from the prior route
  renderNav();
  const view = $("view"); view.innerHTML = "";
  const h = location.hash || "#/";
  const [path, ...rest] = h.slice(2).split("/"); // strip "#/"
  const arg = rest.join("/");
  // Auto-land each role on their most-useful tab ONLY the very first
  // time we render after login. If the user later clicks "My roll"
  // (which is href="#/"), we don't bounce them back to their home tab.
  if (!window._njyLandedOnce && (location.hash === "" || location.hash === "#/")) {
    window._njyLandedOnce = true;
    let home = null;
    if (ME.role === "hk_leader") home = "#/leader";
    else if (ME.role === "njy_leader") home = "#/leader";
    else if (ME.role === "njy_coordinator") home = "#/leaderboard/overall/coords";
    // Coord default is Leaderboard (post-Janmashtami). Janmashtami campaign
    // is over, so we no longer auto-land coords on #/janmashtami. My Roll
    // remains available in the nav for explicit navigation.
    if (home) { location.replace(home); return; }
  } else if (location.hash === "" || location.hash === "#/") {
    // second and later empty-hash renders → treat as "My roll" (or
    // whatever renderCoordRoll shows for this role).
    window._njyLandedOnce = true;
  }
  const routes = {
    "":         renderCoordRoll,
    "leader":   () => arg ? renderLeaderDrill(arg) : renderLeaderDashboard($("view")),
    "hk":       renderHkDashboard,
    "user":     () => renderUserDrill(arg),
    "duties":   renderDuties,
    "events":   () => arg ? renderEventAttendance(arg) : renderEvents(view),
    "sadhana":  () => renderSadhana(arg),
    "bv":       renderBvStructure,
    "admin":    () => renderAdmin(arg || "gates"),
    "settings": renderSettings,
    "janmashtami": renderJanmashtami,
    "leaderboard": () => renderLeaderboard(arg || "daily", rest.join("/")),
    "broadcast":   renderBroadcast,
    "wa-group":    renderWaGroup,
    "profile":      () => renderProfile(arg),
    "points-rules": () => renderPointsRules(view),
    "member":   () => renderMemberDetails(arg),
    "members":  () => renderMembers(view),
    "duplicates": () => renderDuplicateQueue(view),
    "group-report": () => renderGroupReport(arg),
  };
  const fn = routes[path] || renderCoordRoll;
  fn(view);
}

// ============================================================ views

// ---------------------------------------------- coordinator roll ---
// See "route token (BUG 1+2)" above — captures the current routeToken
// on entry and bails after every await if the user has since navigated.
async function renderCoordRoll(view) {
  const myToken = routeToken;
  try {
    // Refresh the pending-duplicate cache in parallel with the roll fetch
    // so the pills paint on first render.
    const [{ roll, tally }] = await Promise.all([
      api("/api/roll"),
      refreshPendingDupCache(),
    ]);
    if (myToken !== routeToken) return;
    // Coord banner: show who their NJY Leader is (or a nudge if unassigned).
    // CHANGE 5 — bold the leader's name (label stays regular weight),
    // and render a small WhatsApp button next to it when the leader
    // has a phone. Same for the "Contact HK" full-mesh link.
    if (ME.role === "njy_coordinator") {
      const line = el("p", { class: "hint",
        style: "display:flex;flex-wrap:wrap;gap:.4rem;align-items:center" });
      if (ME.manager_display_name) {
        line.append(
          el("span", {}, t("hd.your_leader"), ": "),
          el("strong", { style: "font-weight:700;color:var(--ink-2)" }, ME.manager_display_name),
        );
        if (ME.manager_phone) line.append(wame(ME.manager_phone, t("pill.contact_leader")));
      } else {
        line.append(el("span", {}, t("msg.no_leader")));
      }
      if (ME.hk_phone) line.append(wame(ME.hk_phone, t("pill.contact_hk")));
      view.append(line);
    }
    // Inline WhatsApp template editor — coords see and edit the message
    // FIRST so they know what will be sent before tapping Broadcast.
    if (roll.length > 0 && ME.role === "njy_coordinator" && can("settings_wa_templates")) {
      view.append(renderWaTemplateCard());
    }
    // Prominent Broadcast CTA — sits BELOW the template so the flow is
    // review-the-message → tap-Broadcast in one downward motion.
    if (roll.length > 0 && ME.role === "njy_coordinator" && can("myroll_broadcast_button")) {
      const cta = el("a", { class: "broadcast-cta", href: "#/broadcast" },
        el("span", { class: "broadcast-cta-label" }, t("bc.myroll_broadcast_btn")),
        el("span", { class: "broadcast-cta-sub" }, t("bc.myroll_broadcast_sub")),
      );
      view.append(cta);
    }
    view.append(tallyStrip(tally, ["assigned","chanted_today","followed_up","needs_visit"]));
    // Secondary actions row — WA group setup + CSV download. Broadcast
    // moved to the prominent card above.
    if (roll.length > 0 && ME.role === "njy_coordinator") {
      const secondaryRow = el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0" });
      if (can("myroll_wa_group_button")) {
        secondaryRow.append(el("a", { class: "btn", href: "#/wa-group",
          style: "text-decoration:none;padding:.55rem 1rem;border-radius:8px;font-size:.9rem" },
          ME.wa_group_link ? t("bc.myroll_wa_group_btn_have") : t("bc.myroll_wa_group_btn_setup")));
      }
      // Download CSV — client-side (data already fetched into `roll`),
      // no server round-trip. Filename embeds the coord's own name.
      secondaryRow.append(csvDownloadButton(roll, ME.display_name || "me", "my-sangha"));
      // Save-all-contacts — bundles every roll member into one .vcf so
      // the coord's phone imports them all at once.
      secondaryRow.append(saveAllContactsBtn(roll, ME.display_name || "me"));
      if (secondaryRow.children.length) view.append(secondaryRow);
    }
    // Care-moment surfacing — coords only, shown right below the tally.
    // Also gated on myroll_care_moments_panel so HK can hide it per role.
    if (roll.length > 0 && ME.role === "njy_coordinator" && can("myroll_care_moments_panel")) {
      const carePlaceholder = el("div", {});
      view.append(carePlaceholder);
      // Fetch care moments async so the roll UI renders immediately.
      // BUG 1+2 guard — bail if the user navigated away while fetching.
      (async () => {
        try {
          const cm = await api("/api/roll/care-moments");
          if (myToken !== routeToken) return;
          renderCareMomentPanel(carePlaceholder, cm);
        } catch { /* silent — nice-to-have, not blocking */ }
      })();
    }
    view.append(beadLegend());
    view.append(garlandStrip(roll, /* editable */ true));
    view.append(rollList(roll, /* editable */ true));
    if (!roll.length) {
      view.append(el("p", { class: "hint" }, t("msg.no_chanters_assigned")));
    }
  } catch (err) {
    if (err.status === 403) view.append(el("p", { class: "hint" }, t("msg.no_coord_roll")));
    else view.append(el("p", { class: "error" }, t("msg.could_not_load") + err.message));
  }
}

// ----------------------------------------------- Care-Moment panel ---
// Compact "Needs your attention" section on the coord's Roll. Each row
// is a one-tap deep-link to send a specific pre-composed WhatsApp
// message to that chanter. Keeps the outreach targeted and human.
function renderCareMomentPanel(container, cm) {
  container.innerHTML = "";
  const total = (cm.counts.missed_3_plus || 0) + (cm.counts.missed_2 || 0) + (cm.counts.milestones || 0);
  if (!total) {
    container.append(el("div", { class: "care-empty" },
      el("span", { style: "font-size:1.05rem" }, t("care.on_track")),
      el("span", { class: "hint", style: "margin-left:.4rem;font-size:.85rem" }, t("msg.hare_krsna")),
    ));
    return;
  }
  const wrap = el("div", { class: "care-panel" });
  wrap.append(el("h3", {},
    el("span", {}, "🎯"),
    el("span", {}, t("care.needs_attention")),
    el("span", { class: "hint", style: "font-weight:400;font-size:.78rem;margin-left:auto" }, `${total} ${total === 1 ? t("care.chanter_count_suffix") : t("care.chanter_count_suffix_plural")}`),
  ));

  const buildRow = (item, icon, subtitle) => {
    const row = el("div", { class: "care-row" });
    row.append(
      el("span", { class: "care-icon" }, icon),
      el("div", {},
        el("div", { class: "care-name" }, item.name),
        el("div", { class: "care-sub" }, subtitle),
      ),
      el("a", { class: "care-send", href: item.wa_url, target: "_blank" }, t("care.send_btn")),
    );
    return row;
  };

  for (const item of (cm.missed_3_plus || [])) {
    wrap.append(buildRow(item, "🔴", `${t("care.missed_days_prefix")}${item.days_missed}${t("care.missed_days_suffix")}`));
  }
  for (const item of (cm.missed_2 || [])) {
    wrap.append(buildRow(item, "🟠", t("care.missed_yesterday")));
  }
  for (const item of (cm.milestones || [])) {
    wrap.append(buildRow(item, "🎉", `${item.streak_days}${t("care.streak_suffix")}`));
  }

  wrap.append(el("p", { class: "hint", style: "margin:.6rem 0 0;font-size:.72rem" },
    t("care.tap_send_hint")));
  container.append(wrap);
}

// CHANGE 4 — a small card that lets the caller send a pre-filled text
// message INTO their WhatsApp group. WhatsApp doesn't support
// pre-filled messages to a group via URL, so we use the "no-phone"
// wa.me picker (`https://wa.me/?text=...`) — WhatsApp opens the
// contact/group picker with the text pre-filled, the caller taps
// their group, then Send. Draft persists in localStorage (per browser).
function renderWaGroupPickerCard() {
  const STORAGE_KEY = "njy_wa_group_pick_msg";
  const card = el("div", { class: "card" });
  card.append(
    el("h3", { class: "section", style: "margin-top:0" }, t("hd.send_msg_group")),
    el("p", { class: "hint" }, t("help.send_msg_group")),
  );
  const ta = el("textarea", { id: "wg-pick-msg", rows: 4,
    placeholder: t("help.wa_group_placeholder"),
    style: "width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px" });
  try { ta.value = localStorage.getItem(STORAGE_KEY) || ""; } catch { /* private mode */ }
  ta.addEventListener("input", () => {
    try { localStorage.setItem(STORAGE_KEY, ta.value); } catch { /* private mode */ }
  });
  card.append(ta);
  const msg = el("span", { class: "hint", style: "margin-left:.5rem" });
  const openBtn = el("button", { class: "primary", type: "button", id: "wg-pick-open",
    style: "font-size:1rem;padding:.6rem 1.1rem" }, t("wg.picker_open_btn"));
  card.append(el("p", { style: "margin-top:.7rem" }, openBtn, msg));
  openBtn.addEventListener("click", () => {
    const text = (ta.value || "").trim();
    if (!text) { msg.textContent = t("msg.type_msg_first"); return; }
    // api.whatsapp.com/send/ with no phone opens the contact/group
    // picker with the text pre-filled. Used instead of wa.me because
    // wa.me's redirect ASCII-fies 4-byte emoji codepoints — see the
    // waUrl comment in renderBroadcastQueue.
    const url = `https://api.whatsapp.com/send/?text=${encodeURIComponent(text)}`;
    window.open(url, "_blank", "noopener");
    msg.textContent = t("msg.opened_pick_group");
  });
  return card;
}

// Inline "Your WhatsApp Message" editor rendered on My Sangha, right
// below the Broadcast CTA. One template per coord — applies to every
// member on the roll regardless of lifecycle status (change 2). Save
// posts { wa_template } to /api/me/wa-templates and updates ME so the
// wa.me links on the page pick it up on next reload.
function renderWaTemplateCard() {
  const card = el("div", { class: "wa-template-card" });
  card.append(
    el("h3", { class: "section", style: "margin-top:0" }, t("hd.wa_template_yours")),
    el("p", { class: "hint" }, t("help.wa_template_inline")),
  );
  // Emoji-corruption guard. U+FFFD (REPLACEMENT CHARACTER, "�") shows
  // up when a legacy save mangled 4-byte UTF-8. Silently drop the
  // corrupted template and warn the coord so they can re-save.
  const isCorrupt = (s) => typeof s === "string" && s.indexOf("�") >= 0;
  if (isCorrupt(ME.wa_template_daily)) { ME.wa_template_daily = ""; }
  const ta = el("textarea", { id: "wa-template-inline", rows: 5,
    placeholder: t("bc.default_template"),
    style: "width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px;font-family:inherit" });
  ta.value = ME.wa_template_daily || "";
  card.append(ta);
  const msg = el("span", { class: "hint", style: "margin-left:.5rem" });
  const saveBtn = el("button", { class: "primary", type: "button" }, t("btn.save"));
  card.append(el("p", { style: "margin-top:.7rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap" }, saveBtn, msg));
  saveBtn.addEventListener("click", async () => {
    if (isCorrupt(ta.value)) { msg.textContent = t("st.corrupt_encoding"); return; }
    try {
      await api("/api/me/wa-templates", { method: "POST", body: JSON.stringify({
        wa_template: ta.value,
      }) });
      ME.wa_template_daily = ta.value;
      msg.textContent = t("msg.template_saved");
    } catch (err) {
      msg.textContent = err.message || t("st.save_failed");
    }
  });
  return card;
}

// CHANGE 5 — canonical wa.me anchor helper. Strips "+" and non-digits
// (matches server-side waDeepLink so the fix in CHANGE 1 applies
// everywhere), and returns an inline "💬 <label>" pill. Returns an
// empty placeholder if the phone is missing so callers don't need to
// null-check.
function wame(phone, label) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return el("span", { hidden: true });
  return el("a", {
    class: "btn",
    href: `https://api.whatsapp.com/send/?phone=${digits}`,
    target: "_blank", rel: "noopener",
    title: `WhatsApp: ${phone}`,
    style: "text-decoration:none;padding:.15rem .55rem;border-radius:6px;font-size:.78rem;font-weight:500;background:#25D366;color:#fff;border:none",
  }, "💬 ", label || "WhatsApp");
}

// SMS fallback pill (rendered when wa_status === 0). Opens the native
// SMS composer with an optional pre-filled body. Uses the same +91
// prefix rule as callBtn so the composer resolves the country code.
function smsBtn(phone, body) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return el("span", { hidden: true });
  const tel = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  const href = body
    ? `sms:${tel}?body=${encodeURIComponent(body)}`
    : `sms:${tel}`;
  return el("a", {
    class: "btn",
    href,
    title: `${t("btn.sms")} ${tel}`,
    style: "text-decoration:none;padding:.15rem .55rem;border-radius:6px;font-size:.78rem;font-weight:500;background:#f97316;color:#fff;border:none",
    onclick: (e) => e.stopPropagation(),
  }, t("btn.sms"));
}

// "Invite to WhatsApp" pill — an SMS with a WA download link. Rendered
// alongside smsBtn so a coord can nudge a non-WA member to install.
function inviteWaBtn(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return el("span", { hidden: true });
  const tel = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  const body = "Hare Krsna! Please install WhatsApp: https://whatsapp.com/dl";
  return el("a", {
    class: "btn",
    href: `sms:${tel}?body=${encodeURIComponent(body)}`,
    title: t("btn.invite_to_wa"),
    style: "text-decoration:none;padding:.15rem .55rem;border-radius:6px;font-size:.78rem;font-weight:500;background:#eab308;color:#111;border:none",
    onclick: (e) => e.stopPropagation(),
  }, t("btn.invite_to_wa"));
}

// Tiny "Not on WhatsApp?" toggle. Renders as a small text link next to
// the row's WA button. Clicking flips wa_status between null (unknown)
// and 0 (confirmed not on WA), swapping the row's button set in place.
//   row: the roll row (mutated on success so the caller's cached copy
//        stays in sync with the DOM after the toggle round-trips).
//   onFlipped: callback the caller uses to re-render the button strip
//              (rollList wires this to swap wa ↔ sms/invite pills).
function markNonWaBtn(row, onFlipped) {
  const btn = el("button", {
    type: "button",
    class: "mini-btn",
    title: t("btn.mark_non_wa"),
    style: "background:transparent;border:none;color:var(--muted);font-size:.72rem;text-decoration:underline;cursor:pointer;padding:.15rem .25rem",
  }, row.wa_status === 0 ? t("btn.on_wa_toggle") : t("btn.mark_non_wa"));
  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.disabled = true;
    // Toggle: 0 ↔ null. If it's currently 1 (confirmed WA), treat as null
    // for the toggle — a coord flipping "Not on WhatsApp?" resets an old
    // confirmation.
    const next = row.wa_status === 0 ? null : 0;
    try {
      await api(`/api/member/${encodeURIComponent(row.id)}/wa-status`, {
        method: "POST",
        body: JSON.stringify({ wa_status: next }),
      });
      row.wa_status = next;
      if (typeof onFlipped === "function") onFlipped();
    } catch (err) {
      alert(err.message || t("msg.could_not_update_status"));
      btn.disabled = false;
    }
  });
  return btn;
}

// Tel: dial-out button. `<a href="tel:+91<digits>">` prompts the phone
// to dial. Returns a hidden placeholder if the phone is missing so
// callers don't need to null-check. Prefixes +91 to bare 10-digit
// Indian numbers so the dialler doesn't ambiguously interpret them.
function callBtn(phone) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return el("span", { hidden: true });
  const tel = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  return el("a", {
    class: "btn",
    href: `tel:${tel}`,
    title: `${t("btn.call")} ${tel}`,
    style: "text-decoration:none;padding:.15rem .55rem;border-radius:6px;font-size:.78rem;font-weight:500;background:#22c55e;color:#fff;border:none",
    onclick: (e) => e.stopPropagation(),
  }, t("btn.call"));
}

// vCard (v3.0) download button. Generates a .vcf file on the fly with
// the honorific-adjusted display name + a +91-prefixed mobile number,
// so tapping it on a phone opens the contact-app "Add contact" flow.
// Client-side only: Blob + URL.createObjectURL() + <a download>. Works
// on iOS Safari + Android Chrome; no backend, no permissions.
//   sl_no / pincode are optional — they land in the NOTE field for
//   quick recognition when the contact is later looked up.
function saveContactBtn(rawName, phone, sl_no, pincode) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return el("span", { hidden: true });
  // Append " NJY" suffix so all app-saved contacts group together in the
  // coord's phonebook — searchable/filterable as one set.
  const baseName = honorificAdjust(rawName || "").trim() || String(rawName || "").trim() || "Member";
  const fn = `${baseName} NJY`;
  const btn = el("button", {
    type: "button",
    class: "btn",
    title: t("btn.save_contact"),
    style: "text-decoration:none;padding:.15rem .55rem;border-radius:6px;font-size:.78rem;font-weight:500;background:#0ea5e9;color:#fff;border:none;cursor:pointer",
  }, t("btn.save_contact"));
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    // Prefix with +91 if not already E.164-ish. Digits-only + 10 chars →
    // add "+91"; anything else use as-is with a leading + (11-13 digit
    // countries or already-e164 numbers). Never strip a "+".
    const tel = digits.length === 10 ? `+91${digits}` : `+${digits}`;
    const parts = [];
    parts.push("BEGIN:VCARD");
    parts.push("VERSION:3.0");
    parts.push(`FN:${vcardEscape(fn)}`);
    parts.push(`N:${vcardEscape(fn)};;;;`);
    parts.push(`TEL;TYPE=CELL:${tel}`);
    const noteBits = ["NJY Member"];
    if (sl_no != null && sl_no !== "") noteBits.push(`SL ${sl_no}`);
    if (pincode) noteBits.push(String(pincode));
    parts.push(`NOTE:${vcardEscape(noteBits.join(" · "))}`);
    parts.push("END:VCARD");
    parts.push("");
    const vcf = parts.join("\r\n");
    const blob = new Blob([vcf], { type: "text/vcard;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(fn)}.vcf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
  return btn;
}

// Build a single vCard block for one person. Returns the multiline
// string (no trailing newline). Used both by the per-row button and
// the bulk "Save all contacts" download.
function vcardFor(rawName, phone, sl_no, pincode) {
  const digits = String(phone || "").replace(/[^\d]/g, "");
  if (!digits) return null;
  const baseName = honorificAdjust(rawName || "").trim() || String(rawName || "").trim() || "Member";
  const fn = `${baseName} NJY`;
  const tel = digits.length === 10 ? `+91${digits}` : `+${digits}`;
  const noteBits = ["NJY Member"];
  if (sl_no != null && sl_no !== "") noteBits.push(`SL ${sl_no}`);
  if (pincode) noteBits.push(String(pincode));
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${vcardEscape(fn)}`,
    `N:${vcardEscape(fn)};;;;`,
    `TEL;TYPE=CELL:${tel}`,
    `NOTE:${vcardEscape(noteBits.join(" · "))}`,
    "END:VCARD",
  ].join("\r\n");
}

// Bulk button: downloads a single .vcf carrying every roll member's
// contact card at once. Phones import all of them in one prompt.
function saveAllContactsBtn(roll, coordName) {
  const btn = el("button", {
    type: "button",
    class: "btn",
    style: "padding:.3rem .7rem;border-radius:6px;font-size:.85rem;font-weight:500;background:#0ea5e9;color:#fff;border:none;cursor:pointer",
  }, t("btn.save_all_contacts"));
  btn.addEventListener("click", (ev) => {
    ev.preventDefault();
    const blocks = [];
    for (const r of (roll || [])) {
      const v = vcardFor(r.name, r.phone, r.sl_no, r.pincode);
      if (v) blocks.push(v);
    }
    if (!blocks.length) { alert(t("msg.no_contacts")); return; }
    const vcf = blocks.join("\r\n") + "\r\n";
    const blob = new Blob([vcf], { type: "text/vcard;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const date = new Date().toISOString().slice(0, 10);
    a.download = `${slugify(coordName || "my-sangha")}-njy-members-${date}.vcf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
  return btn;
}

// vCard 3.0 escape: backslash, comma, semicolon and newline. FN + N +
// NOTE are the only free-text fields we write, so this covers all.
function vcardEscape(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

// Renders the two nav buttons (Broadcast + WA Group) shown on the
// coord's My Roll, the leader's Team page, and the HK Leader's leaders
// list. Recipient list is derived from the role — see
// loadBroadcastRecipients().
function broadcastAndWaGroupNav() {
  const row = el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap;margin:.6rem 0" });
  row.append(
    el("a", { class: "primary", href: "#/broadcast",
      style: "text-decoration:none;padding:.55rem 1rem;border-radius:8px;font-size:.9rem" },
      t("bc.myroll_broadcast_btn")),
    el("a", { class: "btn", href: "#/wa-group",
      style: "text-decoration:none;padding:.55rem 1rem;border-radius:8px;font-size:.9rem" },
      ME.wa_group_link ? t("bc.myroll_wa_group_btn_have") : t("bc.myroll_wa_group_btn_setup")),
  );
  return row;
}

// -------------------------------------------------- Broadcast queue ---
// Steps a coord/leader/hk_leader through their recipients one at a
// time, opening wa.me with a pre-personalised message each time. The
// caller physically taps WhatsApp's Send button — no automation, zero
// ban risk. See docs/BROADCAST.md for the full rationale.
async function renderBroadcast(view) {
  // CHANGE 3: coord/leader/hk all get broadcast. Recipient list is
  // scoped per role — see loadBroadcastRecipients() below.
  if (!["njy_coordinator", "njy_leader", "hk_leader"].includes(ME.role)) {
    view.append(el("h2", { class: "section" }, t("hd.broadcast")));
    view.append(el("p", { class: "hint" }, t("msg.broadcast_access")));
    return;
  }
  // Split: setup screen if no queue in-progress; queue mode if there is.
  if (window._njyBroadcast && window._njyBroadcast.queue) {
    return renderBroadcastQueue(view);
  }
  return renderBroadcastSetup(view);
}

// Load the broadcast recipient list, normalised to
// [{ id, name, phone, chanted_today?, bead_color? }]. Scoped by the
// caller's role:
//   njy_coordinator → their assigned members  (~50-100)   /api/roll
//   njy_leader      → their assigned coords   (~10)       /api/leader/coordinators
//   hk_leader       → all NJY leaders         (~30)       /api/hk/leaders
async function loadBroadcastRecipients() {
  if (ME.role === "njy_coordinator") {
    const { roll } = await api("/api/roll");
    // Exclude members already known to be off WhatsApp (wa_status === 0)
    // — tapping Send on a broadcast row for them just wastes the coord's
    // time. Unknown (null) and confirmed-WA (1) both stay in.
    const eligible = (roll || []).filter(r => r.wa_status !== 0);
    return {
      kind: "members",
      label: t("wg.invitees_chanters"),
      recipients: eligible.map(r => ({
        id: r.id, name: r.name, phone: r.phone,
        chanted_today: !!r.chanted_today, bead_color: r.bead_color,
      })),
    };
  }
  if (ME.role === "njy_leader") {
    const { coordinators } = await api("/api/leader/coordinators");
    return {
      kind: "coords",
      label: t("wg.invitees_coords"),
      recipients: (coordinators || []).map(c => ({
        id: c.user_id, name: c.name, phone: c.phone,
      })),
    };
  }
  if (ME.role === "hk_leader") {
    const { leaders } = await api("/api/hk/leaders");
    return {
      kind: "leaders",
      label: t("wg.invitees_leaders"),
      recipients: (leaders || []).map(l => ({
        id: l.user_id, name: l.name, phone: l.phone,
      })),
    };
  }
  return { kind: "none", label: t("wg.invitees_chanters"), recipients: [] };
}

async function renderBroadcastSetup(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(el("div", { class: "spread" },
    el("h2", { class: "section" }, t("hd.broadcast_today")),
    el("a", { class: "btn", href: "#/" }, t("btn.back")),
  ));
  const roleHelp = ME.role === "njy_coordinator"
    ? t("bc.roles_coord_intro")
    : ME.role === "njy_leader"
    ? t("bc.roles_leader_intro")
    : t("bc.roles_hk_intro");
  view.append(helpBanner(roleHelp + t("bc.help_common")));
  const loader = loadingLine(t("bc.loading_recipients"));
  view.append(loader);
  try {
    const { kind, label, recipients } = await loadBroadcastRecipients();
    if (myToken !== routeToken) return;
    loader.remove();
    if (!recipients.length) {
      view.append(el("p", { class: "hint" }, `${t("bc.no_recipients_prefix")}${label}${t("bc.no_recipients_suffix")}`));
      return;
    }
    // Message editor — defaults to caller's saved daily template.
    const defaultMsg = ME.wa_template_daily || t("bc.default_template");
    const msgTa = el("textarea", { id: "bc-msg", rows: 5 });
    msgTa.value = defaultMsg;

    // Skip-filters only make sense for the coord flow (they operate on
    // per-chanter chant/bead state that leader/hk recipients don't have).
    const isMembers = kind === "members";
    const skipChanted = el("input", { type: "checkbox", id: "bc-skip-chanted", checked: true });
    const skipRed = el("input", { type: "checkbox", id: "bc-skip-red", checked: false });

    const countLine = el("div", { class: "bc-count-line" });
    function recount() {
      const filtered = recipients.filter(r => {
        if (!isMembers) return true;
        if (skipChanted.checked && r.chanted_today) return false;
        if (skipRed.checked && r.bead_color === "red") return false;
        return true;
      });
      countLine.innerHTML = "";
      countLine.append(
        el("strong", {}, `${filtered.length}`),
        `${t("bc.will_receive_infix")}${recipients.length} ${label}${t("bc.will_receive_suffix")}`,
      );
    }
    if (isMembers) {
      skipChanted.addEventListener("change", recount);
      skipRed.addEventListener("change", recount);
    }
    recount();

    // Message card
    const msgCard = el("div", { class: "bc-card" });
    msgCard.append(
      el("h3", {}, t("hd.message")),
      el("p", { class: "bc-hint" },
        t("bc.use_name_prefix"), el("code", { style: "background:var(--tint-followed);padding:.05rem .3rem;border-radius:3px" }, "{name}"),
        isMembers ? t("bc.use_name_suffix_chanter") : t("bc.use_name_suffix_recipient")),
      msgTa,
    );
    view.append(msgCard);

    // Filters card — only for the coord/members flow.
    const filterCard = el("div", { class: "bc-card" });
    if (isMembers) {
      filterCard.append(
        el("h3", {}, t("hd.who_receives")),
        el("label", { class: "bc-check-row" }, skipChanted,
          el("span", { class: "bc-check-label" },
            el("strong", {}, t("hd.skip_chanted")),
            el("span", { class: "bc-check-sub" }, t("bc.skip_chanted_sub")))),
        el("label", { class: "bc-check-row" }, skipRed,
          el("span", { class: "bc-check-label" },
            el("strong", {}, t("hd.skip_disqualified")),
            el("span", { class: "bc-check-sub" }, t("bc.skip_disqualified_sub")))),
        countLine,
      );
    } else {
      filterCard.append(el("h3", {}, t("hd.who_receives")), countLine);
    }
    filterCard.append(
      el("p", { style: "margin-top:1rem;text-align:right" },
        el("button", { class: "primary", id: "bc-start", style: "font-size:1rem;padding:.7rem 1.4rem" },
          t("bc.start_btn")),
      ),
    );
    view.append(filterCard);

    $("bc-start").addEventListener("click", () => {
      const messageTemplate = msgTa.value.trim();
      if (!messageTemplate) { alert(t("msg.type_msg_first")); return; }
      const filtered = recipients.filter(r => {
        if (!isMembers) return true;
        if (skipChanted.checked && r.chanted_today) return false;
        if (skipRed.checked && r.bead_color === "red") return false;
        return true;
      });
      if (!filtered.length) { alert(t("msg.no_match_filter")); return; }
      // Init session state — note `kind` gates whether the Sent-tap
      // fires mark-contacted (only for members/chanters — coords and
      // leaders are staff, not on any coord's roll).
      window._njyBroadcast = {
        queue: filtered.map(r => ({
          id: r.id, name: r.name, phone: r.phone,
          sent: false, skipped: false,
        })),
        index: 0,
        messageTemplate,
        startedAt: new Date().toISOString(),
        kind,
      };
      // Re-render into queue mode.
      const v = $("view"); v.innerHTML = "";
      renderBroadcastQueue(v);
    });
  } catch (err) {
    loader.remove();
    view.append(el("p", { class: "error" }, t("msg.could_not_load_recipients") + err.message));
  }
}

function renderBroadcastQueue(view) {
  const state = window._njyBroadcast;
  if (!state) { location.hash = "#/broadcast"; return; }
  const total = state.queue.length;
  const sentCount = state.queue.filter(x => x.sent).length;
  const skipCount = state.queue.filter(x => x.skipped).length;
  const done = state.index >= total;

  // Fire the broadcast-marker touch-point ONCE per queue session, on
  // first mount. Server enforces once-per-day uniqueness via
  // leader_touch_actions, so a second fire the same day is a silent
  // no-op — the client-side flag just avoids the extra round-trip on
  // every re-render (each Sent/Skip tap re-enters this function).
  // Leader + HK only; coord broadcasts don't earn a leader-touch.
  if (!state.markerFired && total > 0
      && (ME.role === "njy_leader" || ME.role === "hk_leader")) {
    state.markerFired = true;
    api("/api/leader/broadcast-marker", { method: "POST" })
      .catch(() => { /* silent — non-blocking */ });
  }

  view.append(el("div", { class: "spread" },
    el("h2", { class: "section" }, done ? t("hd.broadcast_complete") : t("hd.broadcast_running")),
    el("button", { class: "btn", id: "bc-cancel", type: "button" }, done ? t("btn.close") : t("btn.pause_exit")),
  ));

  $("bc-cancel").addEventListener("click", () => {
    if (done || confirm(`${t("confirm.pause_broadcast")} ${sentCount} / ${total - sentCount - skipCount}`)) {
      window._njyBroadcast = null;
      location.hash = "#/";
    }
  });

  // Progress card
  const pct = Math.min(100, Math.round(100 * (sentCount + skipCount) / total));
  const progressCard = el("div", { class: "bc-card", style: "padding:.9rem 1.2rem;margin-top:.5rem" });
  progressCard.append(
    el("div", { class: "spread", style: "margin-bottom:.4rem" },
      el("strong", { style: "color:var(--peacock-deep);font-size:.9rem" },
        // BUG: the previous label was `${state.index + 1} of ${total}`
        // — a position indicator, not a send count. On the final
        // chanter it read "3 of 3" while the coord had only actually
        // sent 2 (they hadn't tapped Sent on the third yet). Users
        // read that as "3 sent" and reported an off-by-one. Show the
        // true sent count instead; the current-chanter card still
        // carries `#${state.index + 1}` for position context.
        done ? `${t("bc.finished_prefix")}${total}${t("bc.finished_suffix_chanters")}` : `${t("bc.sent_progress_prefix")}${sentCount}${t("bc.of_infix")}${total}`),
      el("span", { class: "hint", style: "font-size:.8rem" }, `${pct}%`),
    ),
    el("div", { class: "pbar", "data-mid": "0",
      style: `--pct:${pct}%;height:8px;border-radius:4px` }),
    el("div", { class: "hint", style: "margin-top:.4rem;font-size:.75rem;display:flex;gap:1rem" },
      el("span", {}, t("chip.sent") + " ", el("strong", { style: "color:var(--peacock-deep)" }, sentCount)),
      el("span", {}, t("chip.skipped") + " ", el("strong", {}, skipCount)),
      el("span", {}, t("chip.remaining") + " ", el("strong", {}, Math.max(0, total - sentCount - skipCount))),
    ),
  );
  view.append(progressCard);

  if (done) {
    // Tally the auto-contacted upgrades from the Sent taps.
    const upgradedCount = state.queue.filter(x => x.contact_changed).length;
    const summary = el("div", { class: "care-empty" },
      el("h3", { style: "margin:0 0 .3rem" }, t("hd.broadcast_complete_card")),
      el("p", { style: "margin:0;font-size:.9rem" },
        t("bc.sent_to_prefix"), el("strong", {}, sentCount), ` ${sentCount === 1 ? t("bc.sent_to_suffix_chanter") : t("bc.sent_to_suffix_chanters")}. `,
        skipCount ? `${t("bc.skipped_prefix")}${skipCount}. ` : "",
        `${t("bc.started_prefix")}${new Date(state.startedAt).toLocaleTimeString()}${t("bc.finished_time_prefix")}${new Date().toLocaleTimeString()}.`),
      upgradedCount ? el("p", { class: "hint", style: "margin:.4rem 0 0;font-size:.85rem" },
        el("strong", { style: "color:var(--peacock-deep)" }, `${upgradedCount}`),
        t("bc.upgraded_suffix")) : null,
      el("p", { style: "margin-top:.9rem" },
        el("a", { class: "bc-big-btn", href: "#/",
          style: "background:var(--peacock-deep);box-shadow:0 2px 6px rgba(14,79,82,.3)" },
          t("bc.return_myroll")),
      ),
    );
    view.append(summary);
    return;
  }

  // Current chanter card
  const cur = state.queue[state.index];
  // Case-insensitive placeholder — {name}, {Name}, {NAME} all resolve.
  // Substitute the FULL name (not just first name) after passing it
  // through honorificAdjust, so "HG Krishna Dasa" reads "Krishna Prabhu"
  // and "Radha Devi Dasi" reads "Radha Mataji".
  const filledMsg = state.messageTemplate.replace(/\{name\}/gi, honorificAdjust(cur.name || ""));
  // wa.me wants phone digits only — leaving "+" in (encoded as %2B) breaks
  // recipient matching on some WhatsApp clients and falls back to the
  // compose picker, which re-parses the ?text= param under a non-UTF-8
  // codec on some Android/iOS builds → emojis land as U+FFFD (�).
  // Strip the "+" first so the URL is canonical wa.me/<digits>?text=...
  // (matches what the server-side waDeepLink() emits for care-moments).
  // api.whatsapp.com/send/ is used instead of wa.me because wa.me's
  // 302 → api.whatsapp.com redirect ASCII-fies any 4-byte UTF-8 codepoint
  // (emoji, U+1F338 🌸, U+1F64F 🙏, …) in the ?text= param to U+FFFD, which
  // WhatsApp Web then renders as "?". Reproduce with:
  //   curl -sI 'https://wa.me/9999?text=%F0%9F%8C%B8' | grep Location
  // → Location: …&text=%EF%BF%BD…  (the replacement character)
  // api.whatsapp.com/send/ is the endpoint wa.me redirects to and it
  // preserves the codepoints intact. Works on WA mobile app + Web + Desktop.
  const waPhone = String(cur.phone || "").replace(/[^\d]/g, "");
  const waUrl = waPhone
    ? `https://api.whatsapp.com/send/?phone=${waPhone}&text=${encodeURIComponent(filledMsg)}`
    : `https://api.whatsapp.com/send/?text=${encodeURIComponent(filledMsg)}`;

  const card = el("div", { class: "bc-card" });
  card.append(
    el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;gap:.5rem;margin-bottom:.7rem;padding-bottom:.7rem;border-bottom:1px solid var(--line)" },
      el("div", {},
        el("h3", { style: "margin:0;font-size:1.15rem;color:var(--ink)" }, cur.name),
        el("span", { class: "hint", style: "font-family:var(--font-mono);font-size:.8rem" }, cur.phone),
      ),
      el("span", { style: "font-size:.75rem;color:var(--muted);align-self:flex-start" }, `#${state.index + 1}`),
    ),
    el("div", { class: "bc-hint", style: "margin-bottom:.4rem" }, t("bc.message_that_sent")),
    el("div", {
      style: "background:var(--tint-followed,#f6f2ea);padding:.75rem .9rem;border-radius:6px;border-left:3px solid var(--peacock-deep);white-space:pre-wrap;font-size:.88rem;line-height:1.45;color:var(--ink-2);margin-bottom:1rem",
    }, filledMsg),
    // Primary row: "Sent, Next" (green big) sits DIRECTLY under the
    // message so the coord's eye lands on it the moment they return
    // from WhatsApp. The previous layout hid it below the WA button
    // and hint, which coords consistently missed → re-sent the same
    // person 3-5 times.
    el("p", { style: "margin:0 0 .7rem" },
      el("button", { class: "primary bc-big-btn", id: "bc-next", type: "button",
        style: "background:var(--peacock-deep,#0e4f52);padding:.85rem 1.3rem;font-size:1rem;width:100%" },
        t("bc.sent_next")),
    ),
    el("p", { class: "bc-hint", style: "margin:0 0 .6rem;font-size:.78rem" },
      t("bc.after_tap_hint")),
    // Secondary row: "Load via WhatsApp" + Skip. WA button is a muted
    // pill so the green primary above wins the eye. Skip sits right
    // next to WhatsApp because both are lower-priority actions.
    el("div", { style: "display:flex;flex-wrap:wrap;gap:.6rem;align-items:center" },
      el("a", { class: "btn bc-wa-secondary", href: waUrl, target: "_blank", id: "bc-send",
        style: "display:inline-block;padding:.55rem 1rem;font-size:.9rem" },
        t("bc.load_via_wa")),
      el("button", { class: "btn", id: "bc-skip", type: "button",
        style: "padding:.55rem .9rem" }, t("btn.skip")),
    ),
  );
  view.append(card);

  $("bc-send").addEventListener("click", () => {
    // Only records the intent — actual send is the coord tapping WA's Send
    cur._opened = true;
  });
  $("bc-next").addEventListener("click", async () => {
    cur.sent = true;
    // Anti-false-positive: only the explicit Sent tap upgrades status,
    // not the mere wa.me open (which the coord may have abandoned). If
    // the person is already at 2 (responded) or higher, the server will
    // not downgrade — the endpoint's guard is "only 0 → 1".
    // Only fire mark-contacted when the queue is over MEMBERS (people
    // on a coord's roll). For leader→coord and hk→leader broadcasts,
    // the "recipient" is a staff user with no person_id and no
    // contact_state — the endpoint would 404.
    if (cur.id && state.kind === "members") {
      try {
        const r = await api("/api/roll/mark-contacted", {
          method: "POST", body: JSON.stringify({ person_id: cur.id }),
        });
        cur.contact_state_after = r.contact_state;
        cur.contact_changed = r.changed;
      } catch { /* non-blocking — don't stall the queue on an API blip */ }
    }
    state.index += 1;
    const v = $("view"); v.innerHTML = "";
    renderBroadcastQueue(v);
  });
  $("bc-skip").addEventListener("click", () => {
    cur.skipped = true;
    state.index += 1;
    const v = $("view"); v.innerHTML = "";
    renderBroadcastQueue(v);
  });
}

// -------------------------------------------------- WhatsApp Group ---
// Per-coord group management: paste the WA invite link once, then
// multi-select chanters and run the sequential queue to send them
// personalised invite messages. WhatsApp doesn't allow programmatic
// group-adds from personal accounts, so the flow is always
// "chanter taps the link → WhatsApp shows Join Group screen".
async function renderWaGroup(view) {
  const myToken = routeToken;  // BUG 1+2
  // CHANGE 3: coord/leader/hk all get WhatsApp Group Helper. The
  // recipient list is scoped by role — see loadBroadcastRecipients().
  if (!["njy_coordinator", "njy_leader", "hk_leader"].includes(ME.role)) {
    view.append(el("h2", { class: "section" }, t("hd.wa_group_page")));
    view.append(el("p", { class: "hint" }, t("msg.wa_group_access")));
    return;
  }
  const inviteeWord = ME.role === "njy_coordinator" ? t("wg.invitees_chanters")
    : ME.role === "njy_leader" ? t("wg.invitees_coords")
    : t("wg.invitees_leaders");
  view.append(el("div", { class: "spread" },
    el("h2", { class: "section" }, t("hd.my_wa_group")),
    el("a", { class: "btn", href: "#/" }, t("btn.back")),
  ));
  view.append(helpBanner(
    t("wg.setup_help_prefix") + inviteeWord + t("wg.setup_help_mid") + inviteeWord + t("wg.setup_help_suffix")
  ));

  // --- Setup card ---
  const setup = el("div", { class: "card" });
  setup.append(el("h3", { class: "section", style: "margin-top:0" }, t("hd.group_settings")));

  const nameI = el("input", { id: "wg-name", placeholder: t("wg.ph_name") });
  nameI.value = ME.wa_group_name || "";
  const linkI = el("input", { id: "wg-link", placeholder: t("wg.ph_link") });
  linkI.value = ME.wa_group_link || "";
  const msg = el("span", { class: "hint", style: "margin-left:.5rem" });
  const saveBtn = el("button", { class: "primary", id: "wg-save" }, t("btn.save"));
  const testBtn = el("button", { class: "btn", id: "wg-test", style: "margin-left:.4rem" }, t("btn.test_link"));
  const clearBtn = el("button", { class: "btn", id: "wg-clear", style: "margin-left:.4rem" }, t("btn.clear"));

  setup.append(
    formField(t("wg.group_name_field"), nameI),
    formField(t("wg.link_field"), linkI),
    el("p", { style: "margin-top:.7rem" }, saveBtn, testBtn, clearBtn, msg),
  );

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      const link = linkI.value.trim();
      if (link && !/^https:\/\/chat\.whatsapp\.com\//i.test(link)) {
        throw new Error(t("wg.link_must_start"));
      }
      await api("/api/me/wa-group", { method: "POST",
        body: JSON.stringify({ wa_group_link: link, wa_group_name: nameI.value.trim() }) });
      ME.wa_group_link = link || null;
      ME.wa_group_name = nameI.value.trim() || null;
      msg.textContent = t("msg.saved_short");
    } catch (err) { msg.textContent = t("msg.error_prefix") + err.message; }
    finally { saveBtn.disabled = false; }
  });
  testBtn.addEventListener("click", () => {
    const link = linkI.value.trim();
    if (!link) { msg.textContent = t("msg.paste_link_first"); return; }
    window.open(link, "_blank");
  });
  clearBtn.addEventListener("click", async () => {
    if (!confirm(t("confirm.clear_group"))) return;
    nameI.value = ""; linkI.value = "";
    try {
      await api("/api/me/wa-group", { method: "POST",
        body: JSON.stringify({ wa_group_link: "", wa_group_name: "" }) });
      ME.wa_group_link = null; ME.wa_group_name = null;
      msg.textContent = t("msg.cleared");
    } catch (err) { msg.textContent = t("msg.error_prefix") + err.message; }
  });
  view.append(setup);

  // --- CHANGE 4: Send-to-group message picker ---
  view.append(renderWaGroupPickerCard());

  // --- Invite recipients card ---
  const linkNow = () => (linkI.value || "").trim();
  const invite = el("div", { class: "card" });
  invite.append(el("h3", { class: "section", style: "margin-top:0" }, `${t("wg.invite_title_prefix")}${inviteeWord}${t("wg.invite_title_suffix")}`));

  const loader = loadingLine(t("bc.loading_recipients"));
  invite.append(loader);
  view.append(invite);

  try {
    const { kind, label, recipients } = await loadBroadcastRecipients();
    if (myToken !== routeToken) return;
    loader.remove();
    if (!recipients.length) {
      invite.append(el("p", { class: "hint" }, `${t("bc.no_recipients_prefix")}${label}${t("bc.no_recipients_suffix")}`));
      return;
    }

    invite.append(el("p", { class: "hint" },
      t("wg.select_intro_prefix") + label + t("wg.select_intro_mid") + t("wg.select_intro_suffix")));

    // Message template for invites
    const inviteMsg = el("textarea", { id: "wg-inv-msg", rows: 4,
      style: "width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px" });
    inviteMsg.value = t("wg.default_invite");
    invite.append(el("p", { class: "hint" }, t("help.invite_message")));
    invite.append(inviteMsg);

    // Recipients multi-select list
    const listHead = el("div", { class: "spread", style: "margin-top:1rem;padding:.5rem .1rem;border-bottom:1px solid var(--line)" });
    const selectAll = el("input", { type: "checkbox", id: "wg-select-all" });
    listHead.append(
      el("label", { style: "display:flex;gap:.5rem;align-items:center;cursor:pointer;font-weight:500;margin:0" },
        selectAll, el("span", {}, t("wg.select_all"))),
      el("span", { class: "hint", id: "wg-count", style: "font-size:.85rem" }, "0" + t("wg.selected_suffix")),
    );
    invite.append(listHead);

    const ul = el("div", { style: "max-height:280px;overflow-y:auto;margin-top:0;border:1px solid var(--line);border-radius:6px;background:var(--surface)" });
    const rowChecks = [];
    recipients.forEach((r) => {
      const cb = el("input", { type: "checkbox", value: r.id, "data-name": r.name, "data-phone": r.phone || "" });
      rowChecks.push(cb);
      cb.addEventListener("change", updateCount);
      const row = el("label", {
        style: "display:flex;gap:.7rem;align-items:center;cursor:pointer;padding:.5rem .7rem;border-bottom:1px solid var(--line);margin:0",
      },
        cb,
        el("span", { style: "flex:1;min-width:0" },
          el("div", { style: "font-weight:500;font-size:.9rem;color:var(--ink-2);text-overflow:ellipsis;overflow:hidden;white-space:nowrap" }, r.name),
          el("div", { class: "hint", style: "font-size:.72rem;font-family:var(--font-mono)" }, r.phone || t("wg.no_phone"))),
      );
      ul.append(row);
    });
    invite.append(ul);
    function updateCount() {
      const selected = rowChecks.filter(c => c.checked).length;
      $("wg-count").textContent = `${selected}${t("wg.selected_suffix")}`;
    }
    selectAll.addEventListener("change", () => {
      rowChecks.forEach(c => { c.checked = selectAll.checked; });
      updateCount();
    });

    // Send-invite button
    const sendBtn = el("button", { class: "primary", id: "wg-send-invites", type: "button" },
      t("wg.start_invite_queue"));
    invite.append(el("p", { style: "margin-top:.7rem" }, sendBtn));

    sendBtn.addEventListener("click", () => {
      const link = linkNow();
      if (!link) { alert(t("msg.saved_link_first")); return; }
      const selected = rowChecks.filter(c => c.checked);
      if (!selected.length) { alert(t("msg.select_at_least_one")); return; }
      const template = inviteMsg.value.trim();
      if (!template.includes("{link}")) {
        if (!confirm(t("confirm.no_link_placeholder"))) return;
      }
      const compiled = template.replace(/\{link\}/g, link);
      // Reuse the broadcast queue infrastructure with this invite message.
      window._njyBroadcast = {
        queue: selected.map(c => ({
          id: c.value,
          name: c.dataset.name,
          phone: c.dataset.phone,
          sent: false, skipped: false,
        })),
        index: 0,
        messageTemplate: compiled,
        startedAt: new Date().toISOString(),
        kind,
      };
      location.hash = "#/broadcast";
    });
  } catch (err) {
    loader.remove();
    invite.append(el("p", { class: "error" }, t("msg.could_not_load_recipients") + err.message));
  }
}


// Small legend explaining what the bead colors mean, shown above the
// garland on any roll view. Compact — fits on one line most screens.
function beadLegend() {
  const item = (c, label) => el("span", { class: "item" },
    el("span", { class: "swatch", "data-c": c }), label);
  return el("div", { class: "bead-legend" },
    item("white", t("bead.fresh")),
    item("yellow", t("bead.contacted")),
    item("orange", t("bead.responded")),
    item("green", t("bead.chanted")),
    item("red", t("bead.needs_attn")),
  );
}

// A one-liner "what this tab is for" note. Shown right under the h2
// on every tab so non-technical users know what they can do here.
function helpBanner(text) {
  return el("div", { class: "help-banner" }, text);
}

// Pulsing "Loading…" line to show while async fetches complete.
function loadingLine(text = "Loading…") {
  return el("p", { class: "loading-line" }, text);
}

function tallyStrip(tally, keys) {
  const map = {
    assigned: t("hd.assigned"),
    chanted_today: t("hd.chanted_today"),
    followed_up: t("hd.followed_up"),
    needs_visit: t("hd.needs_visit"),
    responded: t("bead.responded"),
  };
  const row = el("div", { class: "tally" });
  for (const k of keys) {
    row.append(el("div", { class: "cell", "data-key": k },
      el("div", { class: "n" }, String(tally[k] ?? 0)),
      el("div", { class: "k" }, map[k] || k),
    ));
  }
  return row;
}

// Adjust a live tally cell's number by delta (e.g. +1 / -1). Silently
// no-ops if the cell isn't present (some views don't include it).
function bumpTallyCell(key, delta) {
  const n = document.querySelector(`.tally .cell[data-key="${key}"] .n`);
  if (!n) return;
  const cur = parseInt(n.textContent, 10) || 0;
  n.textContent = String(Math.max(0, cur + delta));
}

// Human-readable label for a bead color — used in tooltips.
function beadColorLabel(c) {
  return t("bead.color." + c) !== "bead.color." + c ? t("bead.color." + c) : t("bead.color.white");
}

// Build a 14-day history strip for one person. Each day is a small
// clickable dot — grey for "not chanted", green for "chanted", ringed
// for today. Tap any dot to toggle that day. Backfilling past dates
// covers the "they forgot to mark yesterday" case.
async function buildHistoryStrip(personId, opts = {}) {
  // opts.row     — the row object from rollList; toggled today-cell syncs
  //                r.chanted_today + r.bead_color so the row's chant chip,
  //                row bead, garland bead, and tally counter stay live.
  // opts.chantBtn — the .chant-tag button for this row (kept in sync).
  const { row, chantBtn } = opts;
  const strip = el("div", { class: "history-strip" });
  strip.append(el("div", { class: "hint", style: "grid-column:1/-1;font-size:.7rem" }, t("hist.loading")));
  try {
    const { history } = await api(`/api/roll/${encodeURIComponent(personId)}/history?days=14`);
    strip.innerHTML = "";
    for (const d of history) {
      // Format short date label: "26" for the day, "Aug" for the month
      const [_, m, day] = d.date.split("-");
      const monthName = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][parseInt(m, 10) - 1];
      const cell = el("div", {
        class: "history-day" + (d.chanted ? " chanted" : "") + (d.is_today ? " today" : ""),
        title: `${d.date} — ${d.chanted ? t("hist.chanted") : t("hist.not_chanted")}${d.is_today ? t("hist.today_suffix") : ""}${t("hist.tap_toggle")}`,
      },
        el("div", { class: "label" }, day),
        el("div", { class: "month" }, monthName),
        el("div", { class: "dot" }),
      );
      cell.addEventListener("click", async () => {
        const next = !d.chanted;
        try {
          await api("/api/roll/chant", { method: "POST", body: JSON.stringify({
            person_id: personId, chanted: next, entry_date: d.date,
          }) });
          d.chanted = next;
          cell.classList.toggle("chanted", next);
          cell.title = `${d.date} — ${next ? t("hist.chanted") : t("hist.not_chanted")}${d.is_today ? t("hist.today_suffix") : ""}${t("hist.tap_toggle")}`;
          // When the toggled day IS today, the person's row-level state
          // (chant chip, bead color, and tally counter) is derived from
          // "chanted today" — sync those so the UI matches the DB without
          // a page reload. Past-date toggles only affect history + the
          // 3-day-miss red state, which is refreshed on next full load.
          if (d.is_today && row) {
            row.chanted_today = next;
            row.bead_color = recomputeBead(row);
            document.querySelectorAll(`.bead[data-person="${row.id}"]`)
              .forEach(x => x.dataset.color = row.bead_color);
            if (chantBtn) {
              chantBtn.className = "chant-tag" + (next ? " on" : "");
              chantBtn.textContent = next ? t("btn.chanted") : t("btn.chant_q");
            }
            bumpTallyCell("chanted_today", next ? 1 : -1);
          }
        } catch (err) { alert(err.message || t("msg.could_not_update")); }
      });
      strip.append(cell);
    }
  } catch (err) {
    strip.innerHTML = "";
    strip.append(el("p", { class: "hint", style: "grid-column:1/-1;font-size:.7rem" }, t("msg.could_not_load") + err.message));
  }
  return strip;
}

// Bead now takes a color name — one of white/yellow/orange/green/red.
// The old numeric state param still works (falls back to yellow/orange
// mapping) for callers that haven't been updated yet.
function bead(colorOrState, onclick) {
  const attrs = { class: "bead" };
  if (typeof colorOrState === "string") attrs["data-color"] = colorOrState;
  else attrs["data-color"] = ["white", "yellow", "orange", "white"][Number(colorOrState) || 0] || "white";
  const b = el("button", attrs);
  if (onclick) b.addEventListener("click", onclick);
  return b;
}

function garlandStrip(roll, editable) {
  const g = el("div", { class: "garland", "aria-label": t("aria.roll_glance") });
  roll.forEach((r) => {
    const b = bead(r.bead_color || "white", editable ? async () => {
      const upd = await api("/api/roll/mark", { method: "POST", body: JSON.stringify({ person_id: r.id }) });
      r.contact_state = upd.contact_state;
      r.bead_color = recomputeBead(r);
      // sync all beads for this person (row bead + this garland bead)
      document.querySelectorAll(`.bead[data-person="${r.id}"]`).forEach(x => x.dataset.color = r.bead_color);
    } : null);
    // Tagging garland beads with data-person so row-tap can update them too
    b.dataset.person = r.id;
    b.title = `${r.name} — ${beadColorLabel(r.bead_color)}`;
    g.append(b);
  });
  return g;
}

// ------------------------------------------------ CSV export button ---
// Client-side CSV of the roll rows already fetched into the view — no
// server round-trip. Blob + object-URL + <a download> works on all
// evergreen mobile browsers (verified iOS Safari 15+, Android Chrome).
// Called from My Sangha (coord's own roll) and from renderUserDrill
// (leader / HK drilling into a coord).
function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "unknown";
}

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Map a roll row's contact_state to the human-readable status label
// used on the roll UI (fresh / contacted / responded / needs_attention).
// The row also carries lifecycle `status` (fresh/chanter/daily/etc); we
// export the contact-flow state because that's what the bead reflects
// and what field-staff recognise as "status" in the app.
function contactStateLabel(cs, personStatus) {
  // needs_visit / needs_attention takes precedence when set.
  if (cs === 3) return "needs_attention";
  if (personStatus === "daily") return "chanted";   // daily = enrolled chanter
  if (cs === 2) return "responded";
  if (cs === 1) return "contacted";
  return "fresh";
}

// Excel mangles anything that looks like a number, so a raw mobile like
// "+919876543210" or "9876543210" gets rendered in scientific notation
// or with the leading + stripped. Wrapping the value as ="…" tells Excel
// "this cell is a text formula" and preserves the exact string on open.
// The wrapped formula still needs standard CSV quoting because it
// contains =, so we escape any embedded quotes and wrap in double quotes.
function csvMobileCell(phone) {
  const s = String(phone ?? "").trim();
  if (!s) return "";
  return `"=""${s.replace(/"/g, '""""')}"""`;
}

function rollToCsv(roll) {
  const header = [
    "SL Number", "Name", "Mobile", "Pincode", "Status",
    "Daily Member", "Last Chanted Date", "Notes",
  ];
  const lines = [header.join(",")];
  roll.forEach((r) => {
    lines.push([
      csvEscape(r.sl_no ?? ""),
      csvEscape(r.name),
      csvMobileCell(r.phone),
      csvEscape(r.pincode ?? ""),
      csvEscape(contactStateLabel(r.contact_state || 0, r.status)),
      csvEscape(r.status === "daily" ? "yes" : "no"),
      csvEscape(r.last_chanted_date ?? ""),
      csvEscape(r.notes ?? ""),
    ].join(","));
  });
  // Prepend BOM so Excel opens Tamil/UTF-8 names correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}

function csvDownloadButton(roll, ownerName, filenamePrefix) {
  const btn = el("button", { class: "btn", type: "button",
    style: "text-decoration:none;padding:.55rem 1rem;border-radius:8px;font-size:.9rem" },
    t("myroll.download_csv"));
  btn.addEventListener("click", () => {
    const today = new Date().toISOString().slice(0, 10);
    const filename = `${filenamePrefix}-${slugify(ownerName)}-${today}.csv`;
    const blob = new Blob([rollToCsv(roll)], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    // Revoke on next tick so Safari has time to start the download.
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
  return btn;
}

// -------------------------------- auto-mark-contacted with undo toast ---
// Shared helper for the individual WhatsApp button on a roll row (both
// rollList and rollListManageable). We can't observe WhatsApp's Send
// tap from a wa.me link — so at wa.me open time we optimistically fire
// mark-contacted and show a 5s "Marked · Undo" toast. Tapping Undo
// within 5s reverts the row back to its prior contact_state via
// /api/roll/mark. If the person is already at contact_state >= 2
// (responded), the server's guard is a no-op and we simply skip the
// toast — nothing changed, nothing to undo.
//
// Sibling beads for the same person on the garland strip stay in sync
// via the .bead[data-person="..."] selector, the same channel the row
// beadwrap and chant toggle use.
function attachWaAutoMarkContacted(anchor, row, rowBead) {
  anchor.addEventListener("click", () => {
    // Only fire when there's an assigned person id and the current
    // state is fresh (0). The server also guards this (0 → 1 only), but
    // client-side gating avoids a wasted round-trip and a stale toast.
    if (!row || !row.id) return;
    const priorState = row.contact_state || 0;
    if (priorState !== 0) return;   // already contacted/responded/needs_visit

    // Optimistic UI: flip row + garland to "yellow" (contacted) now.
    row.contact_state = 1;
    row.bead_color = recomputeBead(row);
    if (rowBead) rowBead.dataset.color = row.bead_color;
    document.querySelectorAll(`.bead[data-person="${row.id}"]`)
      .forEach(x => x.dataset.color = row.bead_color);

    // Fire the mark-contacted API in the background. If it fails we
    // revert the optimistic UI — no toast in that case, the user
    // didn't ask for an undo they never saw offered.
    let committed = false;
    api("/api/roll/mark-contacted", {
      method: "POST", body: JSON.stringify({ person_id: row.id }),
    }).then((r) => {
      committed = true;
      // Server may report a different final state if a race happened.
      row.contact_state = r.contact_state ?? row.contact_state;
    }).catch(() => {
      // API blip — revert optimistic UI, no toast.
      row.contact_state = priorState;
      row.bead_color = recomputeBead(row);
      if (rowBead) rowBead.dataset.color = row.bead_color;
      document.querySelectorAll(`.bead[data-person="${row.id}"]`)
        .forEach(x => x.dataset.color = row.bead_color);
    });

    // Show the toast. Undo reverts the state on the server AND the UI.
    showUndoToast(row.name, async () => {
      // Wait for the commit round-trip if it's still in flight, so an
      // Undo tap immediately after the WA open still finds a server
      // state to revert from.
      const revertUi = () => {
        row.contact_state = priorState;
        row.bead_color = recomputeBead(row);
        if (rowBead) rowBead.dataset.color = row.bead_color;
        document.querySelectorAll(`.bead[data-person="${row.id}"]`)
          .forEach(x => x.dataset.color = row.bead_color);
      };
      revertUi();
      if (committed) {
        try {
          await api("/api/roll/mark", {
            method: "POST", body: JSON.stringify({ person_id: row.id, contact_state: priorState }),
          });
        } catch { /* undo is best-effort */ }
      }
    });
  });
}

// Minimal, self-contained toast — one at a time, bottom-centered,
// auto-commits after 5s (dismissed with no action taken). Undo tap
// fires the callback and dismisses immediately. Reuses no existing
// styles; footprint is one absolutely-positioned <div>.
let _njyToastEl = null;
let _njyToastTimer = null;
function showUndoToast(personName, onUndo) {
  // Dismiss any prior toast — one at a time, latest wins.
  if (_njyToastTimer) { clearTimeout(_njyToastTimer); _njyToastTimer = null; }
  if (_njyToastEl && _njyToastEl.isConnected) _njyToastEl.remove();

  const msg = (t("toast.marked_contacted_prefix") || "Marked ")
            + personName
            + (t("toast.marked_contacted_suffix") || " as contacted");
  const undoLabel = t("toast.undo") || "Undo";

  const box = el("div", {
    role: "status",
    style: [
      "position:fixed",
      "left:50%", "bottom:24px",
      "transform:translateX(-50%)",
      "background:#1f2937", "color:#fff",
      "padding:.7rem 1rem", "border-radius:8px",
      "box-shadow:0 4px 14px rgba(0,0,0,.25)",
      "display:flex", "align-items:center", "gap:.7rem",
      "z-index:9999", "font-size:.9rem",
      "max-width:min(92vw,420px)",
    ].join(";"),
  },
    el("span", { style: "flex:1" }, msg),
    el("button", { type: "button", style:
      "background:transparent;color:#facc15;border:none;font-weight:700;cursor:pointer;padding:.2rem .4rem",
    }, "· " + undoLabel),
  );
  const undoBtn = box.querySelector("button");
  undoBtn.addEventListener("click", () => {
    if (_njyToastTimer) { clearTimeout(_njyToastTimer); _njyToastTimer = null; }
    _njyToastEl = null;
    box.remove();
    try { onUndo(); } catch { /* undo is best-effort */ }
  });
  document.body.append(box);
  _njyToastEl = box;
  _njyToastTimer = setTimeout(() => {
    _njyToastTimer = null;
    if (_njyToastEl === box) _njyToastEl = null;
    box.remove();
  }, 5000);
}

// -------------------------------- duplicate-request client helpers ---
// Client-side "does this member have a pending duplicate flag?" cache.
// Populated by renderCoordRoll / renderMemberDetails via a lightweight
// GET /api/duplicate-requests?status=pending call. Keys are person ids;
// values are truthy request rows. Cleared on every renderRoute() via
// the routeToken bump — the cache re-populates on the next page.
window._njyPendingDupIds = window._njyPendingDupIds || new Set();

function hasPendingDupFlag(personId) {
  try { return window._njyPendingDupIds.has(personId); }
  catch { return false; }
}

// Small pill rendered on any member row that currently has a pending
// duplicate_request. Read-only — the queue is where a Director acts.
function pendingDupPill() {
  return el("span", {
    class: "hint",
    style: "background:#fff4d6;border:1px solid #e6c56a;color:#7a5b00;"
         + "padding:.15rem .45rem;border-radius:6px;font-size:.72rem;"
         + "white-space:nowrap",
  }, t("dup.pending_pill"));
}

// "Mark as Duplicate" button — the primary entry point on any row that
// belongs to the caller (or that the caller can flag: leader/HK).
// Opens the modal below. Hidden when a pending flag already exists on
// this row (the pill takes its place).
function markDuplicateBtn(person, onSubmitted) {
  const btn = el("button", {
    class: "mini-btn",
    type: "button",
    title: t("btn.mark_duplicate"),
    style: "background:#fff8e6;border:1px solid #f0d68a;color:#7a5b00",
  }, t("btn.mark_duplicate"));
  btn.addEventListener("click", () => openDuplicateModal(person, onSubmitted));
  return btn;
}

// Modal — coord types the OTHER row's SL + an optional note and submits.
// On success we cache the pending flag id and invoke onSubmitted() so
// the caller can swap the button for the pill without a full re-render.
function openDuplicateModal(person, onSubmitted) {
  const backdrop = el("div", {
    style: "position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;"
         + "display:flex;align-items:flex-start;justify-content:center;"
         + "padding:2rem 1rem;overflow-y:auto",
  });
  const box = el("div", {
    style: "background:var(--surface);border:1px solid var(--line);"
         + "border-radius:var(--radius);max-width:440px;width:100%;"
         + "padding:1rem 1.2rem;box-shadow:var(--shadow)",
  });
  const closeBtn = el("button", { class: "ghost", type: "button" }, "✕");
  box.append(el("div", { class: "spread" },
    el("h3", { class: "section", style: "margin:0" }, t("dup.form_title")),
    closeBtn,
  ));
  const nameLine = el("p", { class: "hint", style: "margin:.3rem 0 .6rem" },
    person.name || person.legal_name || "",
    person.sl_no ? " · SL " + person.sl_no : "",
  );
  const slInput = el("input", {
    id: "dup-of-sl",
    placeholder: t("dup.of_sl_placeholder"),
    autofocus: true,
    style: "width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px",
  });
  const noteInput = el("textarea", {
    id: "dup-note",
    rows: 3,
    placeholder: t("dup.note_placeholder"),
    style: "width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px",
  });
  const msg = el("span", { class: "hint", style: "margin-left:.5rem" });
  const submit = el("button", { class: "primary", type: "button" }, t("dup.submit_btn"));
  const cancel = el("button", { class: "btn", type: "button", style: "margin-left:.4rem" }, t("dup.cancel_btn"));
  box.append(
    nameLine,
    formField(t("dup.of_sl_label"), slInput),
    formField(t("dup.note_label"), noteInput),
    el("p", { style: "margin-top:.7rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap" },
      submit, cancel, msg),
  );

  const close = () => backdrop.remove();
  closeBtn.addEventListener("click", close);
  cancel.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  submit.addEventListener("click", async () => {
    const sl = slInput.value.trim();
    if (!sl) { msg.textContent = t("err.duplicate_of_sl_required"); return; }
    submit.disabled = true;
    msg.textContent = t("msg.loading");
    try {
      const r = await api("/api/duplicate-requests", {
        method: "POST",
        body: JSON.stringify({
          flagged_person_id: person.id,
          duplicate_of_sl: sl,
          note: noteInput.value.trim() || null,
        }),
      });
      try { window._njyPendingDupIds.add(person.id); } catch {}
      msg.textContent = t("dup.submitted_pending");
      refreshDupPendingCount();
      if (typeof onSubmitted === "function") onSubmitted(r.request);
      setTimeout(close, 700);
    } catch (err) {
      msg.textContent = err.message;
      submit.disabled = false;
    }
  });
  backdrop.append(box);
  document.body.append(backdrop);
}

// One-shot fetch that populates the pending-flag cache for the current
// page. Safe to call from any render function; failures are swallowed
// because the pill is nice-to-have, not required for correctness.
async function refreshPendingDupCache() {
  try {
    // Only roles that can see the queue can call the endpoint. Coord
    // gets their own submissions back; leader/HK get their scope. All
    // three shapes are fine for populating a "pending" id set.
    if (!["njy_coordinator", "njy_leader", "hk_leader"].includes(ME.role)) return;
    const { requests } = await api("/api/duplicate-requests?status=pending");
    window._njyPendingDupIds = new Set((requests || []).map(r => r.flagged_person_id));
  } catch { /* silent */ }
}

function rollList(roll, editable) {
  const ul = el("ul", { class: "roll" });
  roll.forEach((r) => {
    const li = el("li", {});

    const rowBead = bead(r.bead_color || "white", editable ? async () => {
      const upd = await api("/api/roll/mark", { method: "POST", body: JSON.stringify({ person_id: r.id }) });
      r.contact_state = upd.contact_state;
      r.bead_color = recomputeBead(r);
      rowBead.dataset.color = r.bead_color;
      document.querySelectorAll(`.bead[data-person="${r.id}"]`).forEach(x => x.dataset.color = r.bead_color);
    } : null);
    rowBead.dataset.person = r.id;

    const name = el("div", { class: "name" });
    name.innerHTML = esc(r.name) + `<span class="phone">${esc(r.phone || "")}</span>`;

    // Lifecycle status dropdown — tracks the "daily chanter commitment"
    // for reporting/leaderboards, but no longer gates the Chant button
    // (coords chant any member on their roll, regardless of status).
    const lifecycle = el("select", { class: "lifecycle", "data-status": r.status || "chanter" },
      ...LIFECYCLE.map(s => el("option", { value: s, selected: r.status === s ? true : undefined }, lifecycleLabel(s))),
    );

    const chant = el("button", { class: "chant-tag" + (r.chanted_today ? " on" : "") },
      r.chanted_today ? t("btn.chanted") : t("btn.chant_q"));
    if (editable) chant.addEventListener("click", async () => {
      const next = !r.chanted_today;
      await api("/api/roll/chant", { method: "POST", body: JSON.stringify({ person_id: r.id, chanted: next }) });
      r.chanted_today = next;
      chant.className = "chant-tag" + (next ? " on" : "");
      chant.textContent = next ? t("btn.chanted") : t("btn.chant_q");
      r.bead_color = recomputeBead(r);
      rowBead.dataset.color = r.bead_color;
      document.querySelectorAll(`.bead[data-person="${r.id}"]`).forEach(x => x.dataset.color = r.bead_color);
    });

    if (editable) lifecycle.addEventListener("change", async () => {
      try {
        await api(`/api/person/${r.id}/status`, {
          method: "POST", body: JSON.stringify({ status: lifecycle.value }),
        });
        r.status = lifecycle.value;
        lifecycle.dataset.status = r.status;
      } catch (err) {
        alert(err.message || t("msg.could_not_update_status"));
        lifecycle.value = r.status || "chanter";
      }
    });

    // Contact-pill container — WA (or SMS + Invite-to-WA when the member
    // is confirmed not on WhatsApp), Call, Save contact, and a small
    // "Not on WhatsApp?" toggle. rebuildContact() rewrites this in place
    // so flipping wa_status shows the right pills without a full re-render.
    const contactWrap = el("span", { class: "contact-pills", style: "display:inline-flex;gap:.35rem;flex-wrap:wrap;align-items:center" });
    const rebuildContact = () => {
      contactWrap.innerHTML = "";
      if (r.wa_status === 0) {
        // Pre-fill SMS with the same message body the WhatsApp button
        // would send, so the coord doesn't have to re-type it.
        let smsBody = null;
        try {
          if (r.wa_url) smsBody = new URL(r.wa_url).searchParams.get("text");
        } catch {}
        contactWrap.append(smsBtn(r.phone, smsBody));
        contactWrap.append(inviteWaBtn(r.phone));
      } else {
        const wa = el("a", { class: "wa", href: r.wa_url, target: "_blank", rel: "noopener" }, t("btn.whatsapp"));
        if (editable) attachWaAutoMarkContacted(wa, r, rowBead);
        contactWrap.append(wa);
      }
      contactWrap.append(callBtn(r.phone));
      contactWrap.append(saveContactBtn(r.name, r.phone, r.sl_no, r.pincode));
      // "Not on WhatsApp?" and "Mark as Duplicate" moved to the Member
      // Details page to keep the roll row compact.
    };
    rebuildContact();

    // "History" button — expands a 14-day chant strip below the row
    const historyBtn = el("button", { class: "history-btn", title: t("title.chant_history") }, "📅");
    historyBtn.addEventListener("click", async () => {
      const existing = li.querySelector(".history-strip");
      if (existing) { existing.remove(); return; }
      const strip = await buildHistoryStrip(r.id, { row: r, chantBtn: chant });
      li.append(strip);
    });

    // Pending-duplicate pill still renders on the row so a coord can see
    // at a glance which members have an open flag. The action button
    // itself lives on the Member Details page.
    const dupSlot = el("span", { class: "dup-slot", style: "display:inline-flex;gap:.35rem;align-items:center" });
    const paintDupSlot = () => {
      dupSlot.innerHTML = "";
      if (hasPendingDupFlag(r.id)) dupSlot.append(pendingDupPill());
    };
    paintDupSlot();

    li.append(el("div", { class: "bead-wrap" }, rowBead), name, lifecycle, chant, contactWrap, historyBtn, dupSlot);
    ul.appendChild(li);
  });
  return ul;
}

// ------------------------------------------------- leader dashboard ---
async function renderLeaderDashboard(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(el("h2", { class: "section" }, t("nav.team")));
  // HK Leader: hierarchical view — NJY Leaders first, drill to their coords.
  if (ME.role === "hk_leader") return renderHkLeadersList(view);
  view.append(helpBanner(t("help.team")));
  // CHANGE 5 — leader → HK full-mesh contact link.
  if (ME.hk_phone) {
    view.append(el("p", { class: "hint", style: "display:flex;gap:.4rem;align-items:center;margin:.4rem 0" },
      t("team.hk_leader_prefix"), el("strong", { style: "font-weight:700;color:var(--ink-2)" }, ME.hk_display_name || t("team.hk_leader_fallback")),
      wame(ME.hk_phone, t("pill.contact_hk")),
    ));
  }
  // CHANGE 3 — leader gets Broadcast + WA Group over their coords.
  view.append(broadcastAndWaGroupNav());
  // Duplicate-request info line — read-only for leader; the Director
  // owns the review action. Rendered as a small notice card so it
  // stands out from the coord list without becoming a full CTA.
  if (ME.role === "njy_leader") {
    const dupNotice = el("p", { class: "hint",
      style: "background:#fff8e6;border:1px solid #f0d68a;color:#7a5b00;"
           + "padding:.4rem .7rem;border-radius:6px;margin:.4rem 0;"
           + "display:none;gap:.4rem;flex-wrap:wrap;align-items:center" });
    view.append(dupNotice);
    (async () => {
      try {
        const { count } = await api("/api/duplicate-requests/pending-count");
        if (myToken !== routeToken) return;
        if (count > 0) {
          dupNotice.style.display = "flex";
          dupNotice.append(
            el("span", {}, t("dup.leader_info_prefix")),
            el("strong", { style: "font-weight:700" }, String(count)),
            el("span", {}, t("dup.leader_info_pending")),
          );
        }
      } catch { /* silent */ }
    })();
  }
  const loader = loadingLine(t("team.loading_coords"));
  view.append(loader);
  try {
    const { coordinators } = await api("/api/leader/coordinators");
    if (myToken !== routeToken) return;
    loader.remove();
    if (!coordinators.length) {
      return view.append(el("p", { class: "hint" }, t("msg.no_coords_leader")));
    }
    view.append(el("h3", { class: "section" }, t("hd.your_coords")));
    const ul = el("ul", { class: "list" });
    for (const c of coordinators) {
      ul.append(el("li", {}, coordCard(c)));
    }
    view.append(ul);
  } catch (err) {
    loader.remove();
    view.append(el("p", { class: "error" }, err.message));
  }
}

// HK Leader home — the leaders list with per-leader aggregates. Each row
// drills into a leader-detail page showing that leader's coords.
async function renderHkLeadersList(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(helpBanner(t("help.hk_leaders_list")));
  // CHANGE 3 — HK gets Broadcast + WA Group over all NJY leaders.
  view.append(broadcastAndWaGroupNav());
  const loader = loadingLine(t("team.loading_leaders"));
  view.append(loader);
  try {
    // KPI tiles first (fast — single query behind the scenes)
    try {
      const s = await api("/api/hk/summary");
      if (myToken !== routeToken) return;
      const grid = el("div", { class: "tally" });
      grid.append(
        el("div", { class: "cell" }, el("div", { class: "n" }, String(s.total_people)), el("div", { class: "k" }, t("hd.people"))),
        el("div", { class: "cell" }, el("div", { class: "n" }, String(s.chanted_today)), el("div", { class: "k" }, t("hd.chanted_today"))),
        el("div", { class: "cell" }, el("div", { class: "n" }, String(s.njy_leaders)), el("div", { class: "k" }, t("hd.njy_leaders"))),
        el("div", { class: "cell" }, el("div", { class: "n" }, String(s.njy_coordinators)), el("div", { class: "k" }, t("hd.coordinators"))),
      );
      view.append(grid);
    } catch (_) {}
    const { leaders } = await api("/api/hk/leaders");
    if (myToken !== routeToken) return;
    loader.remove();
    view.append(el("h3", { class: "section" }, t("hd.hk_leaders_list")));
    if (!leaders.length) return view.append(el("p", { class: "hint" }, t("msg.no_coords_hk")));
    const ul = el("ul", { class: "list" });
    for (const l of leaders) ul.append(el("li", {}, leaderRowCard(l)));
    view.append(ul);
  } catch (err) {
    loader.remove();
    view.append(el("p", { class: "error" }, err.message));
  }
}

function leaderRowCard(l) {
  const activePct = l.coord_count ? Math.round(100 * l.active_coords_today / l.coord_count) : 0;
  const chantedPct = l.assigned ? Math.round(100 * l.chanted_today / l.assigned) : 0;
  // CHANGE 5 — HK → leader full-mesh: WhatsApp pill next to Open.
  const rightBtns = el("div", { style: "display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;justify-content:flex-end" });
  if (l.phone) rightBtns.append(wame(l.phone, t("pill.wa")));
  if (l.phone) rightBtns.append(callBtn(l.phone));
  rightBtns.append(el("a", { class: "btn", href: `#/leader/${l.user_id}` }, t("btn.open")));
  return el("div", { style: "width:100%;display:grid;grid-template-columns:1fr auto;gap:.5rem;align-items:center" },
    el("div", {},
      el("div", { class: "spread" },
        el("strong", {}, l.name),
        rightBtns,
      ),
      el("div", { class: "hint", style: "margin-top:.2rem" },
        `${l.coord_count} ${t("hd.coordinators").toLowerCase()} · ${l.assigned} ${t("hd.people").toLowerCase()}`,
      ),
      el("div", { class: "progress-line", style: "margin-top:.55rem" },
        el("span", {}, t("hd.coords_active_today")),
        el("span", { class: "fraction" }, `${l.active_coords_today}${t("team.of_infix")}${l.coord_count}`),
      ),
      el("div", { class: "pbar", "data-mid": String(activePct >= 60 ? 0 : (activePct >= 30 ? 1 : 2)), style: `--pct:${activePct}%` }),
      el("div", { class: "progress-line", style: "margin-top:.4rem" },
        el("span", {}, t("hd.chanted_today")),
        el("span", { class: "fraction" }, `${l.chanted_today}${t("team.of_infix")}${l.assigned}`),
      ),
      el("div", { class: "pbar", "data-mid": String(chantedPct >= 60 ? 0 : (chantedPct >= 30 ? 1 : 2)), style: `--pct:${chantedPct}%` }),
    ),
  );
}

// HK drills into a specific NJY Leader — sees that leader's coords with
// the same coordCard used elsewhere, PLUS an assign button that opens
// a picker to move coords under this leader.
async function renderLeaderDrill(leaderId) {
  const myToken = routeToken;  // BUG 1+2
  const view = $("view");
  const backHref = ME.role === "hk_leader" ? "#/leader" : "#/";
  const loader = loadingLine(t("team.loading_generic"));
  view.append(loader);
  try {
    // Fetch all three sources in parallel:
    //   /api/hk/leaders — for the leader's display name (single source
    //   with per-leader aggregates for the parent list). We DO NOT rely
    //   on it for the KPI strip any more, because when the director
    //   drilled in from a stale HK list the aggregated fields
    //   (chanted_today, active_coords_today, assigned) rendered blank
    //   or zero even when the coord rows below showed activity. The
    //   root cause: two independent aggregation paths (one for the
    //   HK leaders list, one for the coord rows) can diverge. We now
    //   compute the KPI strip from the SAME coord rows shown below so
    //   the totals always match.
    //   /api/leader/coordinators — full coord list w/ per-coord stats.
    //     For HK: returns ALL coords. For a leader: only their own.
    //     Either way we filter by manager_user_id === leaderId.
    //   /api/admin/users — HK-only fallback for the assign-coords picker
    //     (unassigned coords + coords under other leaders). Skipped
    //     for non-HK callers who can't see /api/admin/users anyway.
    const [{ leaders }, { coordinators }, usersResult] = await Promise.all([
      api("/api/hk/leaders").catch(() => ({ leaders: [] })),
      api("/api/leader/coordinators").catch(() => ({ coordinators: [] })),
      ME.role === "hk_leader"
        ? api("/api/admin/users").catch(() => ({ users: [] }))
        : Promise.resolve({ users: [] }),
    ]);
    if (myToken !== routeToken) return;
    const users = usersResult.users || [];
    const leaderInfo = leaders.find(l => l.user_id === leaderId) || {};
    const leaderUser = users.find(u => u.id === leaderId);
    const name = leaderInfo.name || leaderUser?.display_name || leaderUser?.username || t("team.leader_fallback");
    loader.remove();
    view.append(el("div", { class: "spread" },
      el("h2", { class: "section" }, `${name} · ${humanRole("njy_leader")}`),
      el("a", { class: "btn", href: backHref }, t("btn.back")),
    ));

    // Filter coordinators down to just this leader's — the field IS
    // returned by /api/leader/coordinators (see handlers.js:774) so
    // we don't need /api/admin/users at all for this filter.
    const myCoordRows = coordinators.filter(c => c.manager_user_id === leaderId);

    // KPI strip — computed from the same rows shown below. This is the
    // fix for the "coord row counts blank on director drill-in" bug:
    // when HK drills into a leader whose /api/hk/leaders aggregation
    // returned zero (stale row / missing entry / mismatched user id),
    // the KPI would render "0" for all fields while the coord cards
    // underneath clearly showed real activity. Computing from the
    // coord rows themselves keeps the KPI in lock-step with what the
    // director actually sees.
    const coordCount = myCoordRows.length;
    const activeCoordsToday = myCoordRows.filter(c => (c.chanted_today || 0) > 0).length;
    const totalPeople = myCoordRows.reduce((s, c) => s + (c.assigned || 0), 0);
    const chantedToday = myCoordRows.reduce((s, c) => s + (c.chanted_today || 0), 0);
    const grid = el("div", { class: "tally" });
    grid.append(
      el("div", { class: "cell" }, el("div", { class: "n" }, String(coordCount)), el("div", { class: "k" }, t("hd.coords_in_team"))),
      el("div", { class: "cell" }, el("div", { class: "n" }, String(activeCoordsToday)), el("div", { class: "k" }, t("hd.coords_active_today"))),
      el("div", { class: "cell" }, el("div", { class: "n" }, String(totalPeople)), el("div", { class: "k" }, t("hd.people"))),
      el("div", { class: "cell" }, el("div", { class: "n" }, String(chantedToday)), el("div", { class: "k" }, t("hd.chanted_today"))),
    );
    view.append(grid);

    // Assign button (HK only). The modal needs the full users list to
    // show unassigned + other-leader coords, so we already fetched it
    // above for HK callers.
    if (ME.role === "hk_leader") {
      const assignBtn = el("button", { class: "primary" }, t("btn.assign_coords"));
      assignBtn.addEventListener("click", () => openAssignCoordsModal(leaderId, name, users));
      view.append(el("p", { style: "margin:.6rem 0" }, assignBtn));
    }

    view.append(el("h3", { class: "section" }, t("hd.currently_assigned")));
    if (!coordCount) {
      view.append(el("p", { class: "hint" }, t("msg.no_coords_leader_assigned")));
      return;
    }
    const ul = el("ul", { class: "list" });
    for (const c of myCoordRows) ul.append(el("li", {}, coordCard(c)));
    view.append(ul);
  } catch (err) {
    if (myToken !== routeToken) return;
    loader.remove();
    view.append(el("p", { class: "error" }, err.message));
  }
}

// Modal to bulk-assign coords under a leader. Shows currently-assigned
// as ticked, and unassigned coords with a ✱ so HK can see who's floating.
function openAssignCoordsModal(leaderId, leaderName, allUsers) {
  const backdrop = el("div", {
    style: "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto",
  });
  const box = el("div", {
    style: "background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);max-width:520px;width:100%;padding:1rem 1.2rem;box-shadow:var(--shadow)",
  });
  box.append(el("div", { class: "spread" },
    el("h3", { class: "section", style: "margin:0" }, t("hd.assign_coords_title") + " " + leaderName),
    el("button", { class: "ghost", type: "button", id: "am-close" }, "✕"),
  ));
  box.append(el("p", { class: "hint" }, t("help.assign_coords")));

  const coords = allUsers.filter(u => u.role === "njy_coordinator" && u.active);
  const assigned = coords.filter(c => c.manager_user_id === leaderId);
  const otherAssigned = coords.filter(c => c.manager_user_id && c.manager_user_id !== leaderId);
  const unassigned = coords.filter(c => !c.manager_user_id);

  const list = el("div", { style: "max-height:50vh;overflow-y:auto;margin-top:.6rem" });
  const section = (title, items, ticked) => {
    if (!items.length) return null;
    const wrap = el("div", { style: "margin-bottom:.7rem" });
    wrap.append(el("h4", { style: "margin:.4rem 0 .3rem;color:var(--peacock-deep);font-size:.9rem" }, title));
    for (const c of items) {
      const cb = el("input", { type: "checkbox", value: c.id, style: "flex:0 0 auto;margin:0" });
      if (ticked) cb.checked = true;
      const row = el("label", {
        style: "display:flex;align-items:center;gap:.6rem;padding:.4rem .1rem;font-size:.9rem;border-bottom:1px dashed var(--line);cursor:pointer;line-height:1.3",
      },
        cb,
        el("span", { style: "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left" },
          el("strong", { style: "font-weight:500;color:var(--ink-2)" }, c.display_name || c.username),
          el("span", { class: "hint", style: "margin-left:.4rem;font-size:.8rem" }, `· ${c.username}`),
        ),
      );
      wrap.append(row);
    }
    list.append(wrap);
  };
  section(t("hd.currently_assigned"), assigned, true);
  section(t("team.unassigned_group"), unassigned, false);
  if (otherAssigned.length) {
    section(t("team.other_leader_group"), otherAssigned, false);
  }
  box.append(list);

  const msg = el("span", { class: "hint", style: "margin-left:.6rem" });
  const save = el("button", { class: "primary" }, t("btn.save_assignments"));
  box.append(el("p", { style: "margin-top:.7rem" }, save, msg));

  save.addEventListener("click", async () => {
    save.disabled = true;
    const checked = Array.from(box.querySelectorAll("input[type=checkbox]:checked")).map(x => x.value);
    const unchecked = Array.from(box.querySelectorAll("input[type=checkbox]:not(:checked)")).map(x => x.value);
    // Unassign coords that WERE this leader's but are now unchecked
    const toRelease = assigned.map(c => c.id).filter(id => unchecked.includes(id));
    try {
      if (checked.length) {
        await api(`/api/hk/leader/${leaderId}/assign`, { method: "POST",
          body: JSON.stringify({ coord_user_ids: checked }) });
      }
      if (toRelease.length) {
        await api(`/api/hk/leader/${leaderId}/assign`, { method: "POST",
          body: JSON.stringify({ coord_user_ids: toRelease, unassign: true }) });
      }
      msg.textContent = t("msg.assign_saved");
      // Refresh the drill page
      setTimeout(() => { backdrop.remove(); renderRoute(); }, 500);
    } catch (err) {
      msg.textContent = err.message || t("team.failed");
      save.disabled = false;
    }
  });
  box.querySelector("#am-close").addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.append(box);
  document.body.append(backdrop);
}

// Reusable per-coordinator progress card. SKJ-cohort focused (initially
// 100 daily-committed chanters). Two progress bars:
//   - SKJ chanted today → daily-committed people who chanted today
//   - Consistency       → daily-committed people with at least one chant
//                          in the last 3 days (3+ consecutive misses
//                          means they've been disqualified from the
//                          streak).
// Denominators for both = total daily-committed chanters, NOT whole roll.
function coordCard(c) {
  const dailyTotal = c.daily_chanter_total || 0;
  const denom = Math.max(1, dailyTotal);
  const daily_chanted = c.daily_chanted_today || 0;
  const consistent = c.consistent_daily ?? c.one_month_daily ?? 0;
  const disqualified = Math.max(0, dailyTotal - consistent);
  const pctToday = Math.min(100, Math.round(100 * daily_chanted / denom));
  const pctConsistent = Math.min(100, Math.round(100 * consistent / denom));
  const midToday = pctToday >= 60 ? 0 : (pctToday >= 30 ? 1 : 2);
  const midConsistent = pctConsistent >= 60 ? 0 : (pctConsistent >= 30 ? 1 : 2);
  // Whole-roll chants today — the summary Director actually cares about
  // when spotting which coord had activity. Independent of daily-commit
  // status. Uses `chanted_today` (total) / `assigned` (whole roll size).
  const rollTotal = c.assigned || 0;
  const rollDenom = Math.max(1, rollTotal);
  const rollChanted = c.chanted_today || 0;
  const pctRoll = Math.min(100, Math.round(100 * rollChanted / rollDenom));
  const midRoll = pctRoll >= 60 ? 0 : (pctRoll >= 30 ? 1 : 2);
  // CHANGE 5 — leader → coord + HK → coord full-mesh: WhatsApp pill next to Open.
  const coordBtns = el("div", { style: "display:flex;gap:.35rem;align-items:center;flex-wrap:wrap;justify-content:flex-end" });
  if (c.phone) coordBtns.append(wame(c.phone, t("pill.wa")));
  if (c.phone) coordBtns.append(callBtn(c.phone));
  coordBtns.append(el("a", { class: "btn", href: `#/user/${c.user_id}` }, t("btn.open")));
  // Edit + Delete — leader can act on their own coords; HK unrestricted.
  // Backend re-checks ownership, so it's safe to render the buttons for
  // any leader whose /api/leader/coordinators response included this
  // coord (that endpoint already filters to their own coords).
  const canManageCoord = ME.role === "hk_leader"
    || (ME.role === "njy_leader"
        && (!c.manager_user_id || c.manager_user_id === ME.id));
  if (canManageCoord) {
    const editBtn = el("button", { class: "mini-btn", type: "button" }, t("team.edit_coord_btn"));
    editBtn.addEventListener("click", () => openEditCoordModal(c));
    coordBtns.append(editBtn);
    const delBtn = el("button", { class: "danger", type: "button" }, t("team.delete_coord_btn"));
    delBtn.addEventListener("click", () => openDeleteCoordConfirm(c));
    coordBtns.append(delBtn);
  }
  return el("div", { style: "width:100%;display:grid;grid-template-columns:1fr auto;gap:.5rem;align-items:center" },
    el("div", {},
      el("div", { class: "spread" },
        el("strong", {}, c.name),
        coordBtns,
      ),
      el("div", { class: "hint", style: "margin-top:.2rem" },
        `${dailyTotal}${t("team.daily_committed_suffix")}${c.assigned || 0}${t("team.whole_roll_suffix")}`,
      ),
      // Whole-roll chants today — first + primary so Director sees who's
      // actually active regardless of daily-commit status.
      el("div", { class: "progress-line", style: "margin-top:.55rem" },
        el("span", {}, t("team.chanted_today_label")),
        el("span", { class: "fraction" }, `${rollChanted}${t("team.of_infix")}${rollTotal}`),
      ),
      el("div", { class: "pbar", "data-mid": String(midRoll), style: `--pct:${pctRoll}%` }),
      el("div", { class: "progress-line", style: "margin-top:.4rem" },
        el("span", { title: t("team.skj_today_title") }, t("team.skj_today_label")),
        el("span", { class: "fraction" }, `${daily_chanted}${t("team.of_infix")}${dailyTotal}`),
      ),
      el("div", { class: "pbar", "data-mid": String(midToday), style: `--pct:${pctToday}%` }),
      el("div", { class: "progress-line", style: "margin-top:.4rem" },
        el("span", { title: t("team.consistency_title") }, t("team.consistency_label")),
        el("span", { class: "fraction" }, `${consistent}${t("team.of_infix")}${dailyTotal}${disqualified ? ` · ${disqualified}${t("team.out_suffix")}` : ""}`),
      ),
      el("div", { class: "pbar", "data-mid": String(midConsistent), style: `--pct:${pctConsistent}%` }),
    ),
  );
}

// -------------------------- edit + delete coord modals ---------------
// Rendered from coordCard's Edit / Delete buttons. Backend endpoints:
//   POST   /api/leader/coord/:coordId — patch
//   DELETE /api/leader/coord/:coordId — soft-delete + unassign members
// Ownership check is enforced server-side; the UI hides the buttons
// for coords the caller doesn't own to spare the round-trip.
function openEditCoordModal(coord) {
  const backdrop = el("div", {
    style: "position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:100;display:flex;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto",
  });
  const box = el("div", {
    style: "background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);max-width:480px;width:100%;padding:1rem 1.2rem;box-shadow:var(--shadow)",
  });
  const currentName = coord.name || coord.username || "";
  box.append(el("div", { class: "spread" },
    el("h3", { class: "section", style: "margin:0" }, t("team.edit_coord_title") + " " + currentName),
    el("button", { class: "ghost", type: "button", id: "ec-close" }, "✕"),
  ));

  const displayI = el("input", { autocomplete: "off", value: coord.name || "" });
  const usernameI = el("input", {
    autocomplete: "off", autocapitalize: "none", value: coord.username || "",
  });
  const usernameFlag = el("span", { class: "hint", style: "margin-left:.4rem" }, "");
  const phoneI = el("input", { inputmode: "tel", placeholder: "+91…", value: coord.phone || "" });
  const pincodeI = el("input", {
    inputmode: "numeric", maxlength: "6", autocomplete: "postal-code",
    placeholder: "560001", value: coord.pincode || "",
  });
  const passwordI = el("input", {
    type: "text", autocomplete: "new-password",
    placeholder: t("team.edit_password_placeholder"),
  });
  // Gender radios — prefilled from coord.gender if the API returned it.
  const genderF = el("input", { type: "radio", name: "gender", value: "F" });
  const genderM = el("input", { type: "radio", name: "gender", value: "M" });
  if (coord.gender === "F") genderF.checked = true;
  if (coord.gender === "M") genderM.checked = true;
  const genderWrap = el("div", { style: "display:flex;gap:1rem;align-items:center" },
    el("label", { style: "display:flex;gap:.35rem;align-items:center" }, genderF, " " + t("field.gender_f")),
    el("label", { style: "display:flex;gap:.35rem;align-items:center" }, genderM, " " + t("field.gender_m")),
  );
  const msg = el("span", { class: "hint", style: "margin-left:.5rem" }, "");
  const saveBtn = el("button", { class: "primary", type: "submit" }, t("btn.save"));
  const cancelBtn = el("button", { class: "ghost", type: "button" }, t("btn.cancel"));

  const form = el("form", { method: "post", action: "javascript:void(0)" });
  form.append(
    el("div", {}, el("label", {}, t("field.display_name")), displayI),
    el("div", {}, el("label", {}, t("field.username")),
      el("div", { style: "display:flex;align-items:center" }, usernameI, usernameFlag)),
    el("div", {}, el("label", {}, t("field.phone")), phoneI),
    el("div", {}, el("label", {}, t("field.pincode")), pincodeI,
      el("p", { class: "hint", style: "margin:.15rem 0 .3rem;font-size:.78rem;color:var(--ink-2)" },
        t("field.pincode_hint"))),
    el("div", {}, el("label", {}, t("field.gender")), genderWrap),
    el("div", {}, el("label", {}, t("team.edit_password_label")), passwordI,
      el("p", { class: "hint", style: "margin:.15rem 0 .3rem;font-size:.78rem;color:var(--ink-2)" },
        t("team.edit_password_hint"))),
  );
  form.append(el("p", { style: "margin-top:.6rem" }, saveBtn, " ", cancelBtn, msg));
  box.append(form);

  // Live username-availability probe — same debounce + endpoint as the
  // add-coord form. Skip when unchanged (own username is always taken).
  let checkTimer = null;
  usernameI.addEventListener("input", () => {
    const v = usernameI.value.trim();
    usernameFlag.textContent = "";
    usernameFlag.style.color = "";
    clearTimeout(checkTimer);
    if (v.length < 3 || v === (coord.username || "")) return;
    checkTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/leader/coord-username-check?u=${encodeURIComponent(v)}`);
        if (r.available) {
          usernameFlag.textContent = "✓ " + t("members.uname_ok");
          usernameFlag.style.color = "var(--mark-followed)";
        } else {
          usernameFlag.textContent = "✗ " + t("members.uname_taken");
          usernameFlag.style.color = "var(--mark-attention)";
        }
      } catch { /* silent */ }
    }, 250);
  });

  const close = () => backdrop.remove();
  cancelBtn.addEventListener("click", close);
  box.querySelector("#ec-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  form.onsubmit = async (e) => {
    e.preventDefault();
    msg.textContent = "";
    const dn = displayI.value.trim();
    const un = usernameI.value.trim();
    const ph = phoneI.value.trim();
    const pc = pincodeI.value.trim();
    const pw = passwordI.value;  // no trim — spaces matter in passwords
    if (!dn) { msg.textContent = t("profile.edit_display_required"); return; }
    if (!un) { msg.textContent = t("profile.edit_username_required"); return; }
    if (pc && !/^\d{6}$/.test(pc)) { msg.textContent = t("field.pincode_invalid"); return; }
    if (pw && pw.length < 6) { msg.textContent = t("team.edit_password_too_short"); return; }
    const g = genderF.checked ? "F" : (genderM.checked ? "M" : null);
    const body = { display_name: dn, username: un, phone: ph, pincode: pc || null, gender: g };
    if (pw) body.password = pw;
    saveBtn.disabled = true;
    try {
      await api(`/api/leader/coord/${encodeURIComponent(coord.user_id)}`, {
        method: "POST", body: JSON.stringify(body),
      });
      close();
      showTeamToast(t("team.coord_updated_toast"));
      renderRoute();
    } catch (err) {
      msg.textContent = err.message;
      saveBtn.disabled = false;
    }
  };

  backdrop.append(box);
  document.body.append(backdrop);
}

function openDeleteCoordConfirm(coord) {
  const name = coord.name || coord.username || "";
  const n = Number(coord.assigned || 0);
  const prompt = t("team.delete_confirm_prompt")
    .replace("{name}", name)
    .replace("{n}", String(n));
  if (!confirm(prompt)) return;
  (async () => {
    try {
      const r = await api(`/api/leader/coord/${encodeURIComponent(coord.user_id)}`, {
        method: "DELETE",
      });
      const unassigned = Number(r && r.unassigned_count) || 0;
      const toast = t("team.coord_deleted_toast")
        .replace("{name}", name)
        .replace("{n}", String(unassigned));
      showTeamToast(toast);
      renderRoute();
    } catch (err) {
      alert(err.message || t("team.failed"));
    }
  })();
}

// Reuse the profile toast slot so we only ever have one on-screen.
function showTeamToast(text) {
  if (_njyToastTimer) { clearTimeout(_njyToastTimer); _njyToastTimer = null; }
  if (_njyToastEl && _njyToastEl.isConnected) _njyToastEl.remove();
  const box = el("div", {
    role: "status",
    style: [
      "position:fixed", "left:50%", "bottom:24px",
      "transform:translateX(-50%)",
      "background:#1f2937", "color:#fff",
      "padding:.7rem 1rem", "border-radius:8px",
      "box-shadow:0 4px 14px rgba(0,0,0,.25)",
      "z-index:9999", "font-size:.9rem",
      "max-width:min(92vw,420px)", "text-align:center",
    ].join(";"),
  }, text);
  document.body.append(box);
  _njyToastEl = box;
  _njyToastTimer = setTimeout(() => {
    _njyToastTimer = null;
    if (_njyToastEl === box) _njyToastEl = null;
    box.remove();
  }, 6000);
}

// -------------------------------------------------------- HK dashboard ---
async function renderHkDashboard(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(el("h2", { class: "section" }, t("hd.hk_dashboard")));
  view.append(helpBanner(t("help.hk_dashboard")));
  const loader = loadingLine(t("team.loading_dashboard"));
  view.append(loader);
  try {
    const s = await api("/api/hk/summary");
    if (myToken !== routeToken) return;
    loader.remove();
    const grid = el("div", { class: "tally" });
    grid.append(
      el("div", { class: "cell" }, el("div", { class: "n" }, String(s.total_people)), el("div", { class: "k" }, t("hd.people"))),
      el("div", { class: "cell" }, el("div", { class: "n" }, String(s.chanted_today)), el("div", { class: "k" }, t("hd.chanted_today"))),
      el("div", { class: "cell" }, el("div", { class: "n" }, String(s.njy_leaders)), el("div", { class: "k" }, t("hd.njy_leaders"))),
      el("div", { class: "cell" }, el("div", { class: "n" }, String(s.njy_coordinators)), el("div", { class: "k" }, t("hd.coordinators"))),
    );
    view.append(grid);
    view.append(el("h2", { class: "section" }, t("hd.hk_leaders_list")));
    const { leaders } = await api("/api/hk/leaders");
    if (myToken !== routeToken) return;
    if (!leaders || !leaders.length) return view.append(el("p", { class: "hint" }, t("msg.no_coords_admin")));
    const ul = el("ul", { class: "list" });
    for (const l of leaders) {
      ul.append(el("li", {}, leaderRowCard(l)));
    }
    view.append(ul);
  } catch (err) {
    loader.remove();
    view.append(el("p", { class: "error" }, err.message));
  }
}

// ------------------------------------------------------ user drill-in ---
let ALL_USERS_CACHE = null;
async function loadAllUsers() {
  if (ALL_USERS_CACHE) return ALL_USERS_CACHE;
  try {
    const { users } = await api("/api/admin/users");
    ALL_USERS_CACHE = users;
  } catch { ALL_USERS_CACHE = []; }
  return ALL_USERS_CACHE;
}

async function renderUserDrill(userId) {
  const myToken = routeToken;  // BUG 1+2
  const view = $("view");
  try {
    const { target, roll, tally } = await api(`/api/user/${encodeURIComponent(userId)}/roll`);
    if (myToken !== routeToken) return;
    view.append(el("div", { class: "spread" },
      el("h2", { class: "section" }, `${target.name} · ${humanRole(target.role)}`),
      el("a", { class: "btn", href: ME.role === "hk_leader" ? "#/hk" : "#/leader" }, t("btn.back")),
    ));
    view.append(tallyStrip(tally, ["assigned","chanted_today","followed_up","needs_visit"]));
    // Download CSV — leader/HK drilling into a coord gets the same
    // export button (only when there's actually a roll to export).
    // Release-all — Director/leader can send this coord's whole roll
    // back to the Unassigned Pool in one tap (use case: wrong-gender
    // batch, will re-fill via Members tab bulk-assign afterwards).
    if (roll.length > 0) {
      const toolbar = el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap;margin:.4rem 0 .6rem" });
      toolbar.append(csvDownloadButton(roll, target.name || "coord", "sangha"));
      if (target.role === "njy_coordinator"
          && (ME.role === "hk_leader" || ME.role === "njy_leader")) {
        const releaseBtn = el("button", { type: "button", class: "danger",
          style: "padding:.35rem .8rem;border-radius:6px;font-size:.85rem;font-weight:500;cursor:pointer" },
          t("team.release_all_btn"));
        releaseBtn.addEventListener("click", async () => {
          const prompt = t("team.release_all_confirm")
            .replace("{name}", target.name || "coord")
            .replace("{n}", String(roll.length));
          if (!confirm(prompt)) return;
          releaseBtn.disabled = true;
          try {
            const r = await api(`/api/leader/coord/${encodeURIComponent(target.id)}/release-members`, {
              method: "POST", body: JSON.stringify({}),
            });
            alert(t("team.release_all_toast")
              .replace("{name}", target.name || "coord")
              .replace("{n}", String(r.unassigned_count)));
            renderRoute();
          } catch (err) {
            alert(err.message || "Release failed");
            releaseBtn.disabled = false;
          }
        });
        toolbar.append(releaseBtn);
      }
      view.append(toolbar);
    }
    view.append(beadLegend());
    view.append(garlandStrip(roll, /* editable */ true));
    view.append(rollListManageable(roll, target.id));
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}

// A roll list where each row has a Manage button that opens an inline
// admin panel for reassign / lifecycle status / soft-delete. Only shown
// to hk_leader / njy_leader.
function rollListManageable(roll, currentOwnerUserId) {
  const canManage = (ME.role === "hk_leader" || ME.role === "njy_leader");
  const ul = el("ul", { class: "roll" });
  roll.forEach((r) => {
    const rowBead = bead(r.bead_color || "white", async () => {
      const upd = await api("/api/roll/mark", { method: "POST", body: JSON.stringify({ person_id: r.id }) });
      r.contact_state = upd.contact_state;
      r.bead_color = recomputeBead(r);
      // sync all beads for this person across garland strip AND row
      document.querySelectorAll(`.bead[data-person="${r.id}"]`).forEach(x => x.dataset.color = r.bead_color);
    });
    rowBead.dataset.person = r.id;

    const name = el("div", { class: "name" });
    name.innerHTML = esc(r.name) + `<span class="phone">${esc(r.phone || "")}</span>`;

    const lifecycle = el("select", { class: "lifecycle", "data-status": r.status || "chanter" },
      ...LIFECYCLE.map(s => el("option", { value: s, selected: r.status === s ? true : undefined }, lifecycleLabel(s))),
    );

    const chant = el("button", { class: "chant-tag" + (r.chanted_today ? " on" : "") },
      r.chanted_today ? t("btn.chanted") : t("btn.chant_q"));
    chant.addEventListener("click", async () => {
      const next = !r.chanted_today;
      await api("/api/roll/chant", { method: "POST", body: JSON.stringify({ person_id: r.id, chanted: next }) });
      r.chanted_today = next;
      chant.className = "chant-tag" + (next ? " on" : "");
      chant.textContent = next ? t("btn.chanted") : t("btn.chant_q");
      r.bead_color = recomputeBead(r);
      document.querySelectorAll(`.bead[data-person="${r.id}"]`).forEach(x => x.dataset.color = r.bead_color);
    });

    lifecycle.addEventListener("change", async () => {
      try {
        await api(`/api/person/${r.id}/status`, {
          method: "POST", body: JSON.stringify({ status: lifecycle.value }),
        });
        r.status = lifecycle.value;
        lifecycle.dataset.status = r.status;
      } catch (err) {
        alert(err.message || t("msg.could_not_update_status"));
        lifecycle.value = r.status || "chanter";
      }
    });

    // Contact-pill container — WA (or SMS + Invite-to-WA when confirmed
    // not on WhatsApp), Call, Save contact, plus a small "Not on
    // WhatsApp?" toggle. See rollList() for the shared shape. Leader/HK
    // drilling in are still contacting the same member, so mark-contacted
    // auto-fires on WA open (server-side auth check in
    // /api/roll/mark-contacted lets leader/hk act on any member in scope).
    const contactWrap = el("span", { class: "contact-pills", style: "display:inline-flex;gap:.35rem;flex-wrap:wrap;align-items:center" });
    const rebuildContact = () => {
      contactWrap.innerHTML = "";
      if (r.wa_status === 0) {
        // Pre-fill SMS with the same message body the WhatsApp button
        // would send, so the coord doesn't have to re-type it.
        let smsBody = null;
        try {
          if (r.wa_url) smsBody = new URL(r.wa_url).searchParams.get("text");
        } catch {}
        contactWrap.append(smsBtn(r.phone, smsBody));
        contactWrap.append(inviteWaBtn(r.phone));
      } else {
        const wa = el("a", { class: "wa", href: r.wa_url, target: "_blank", rel: "noopener" }, t("btn.whatsapp"));
        attachWaAutoMarkContacted(wa, r, rowBead);
        contactWrap.append(wa);
      }
      contactWrap.append(callBtn(r.phone));
      contactWrap.append(saveContactBtn(r.name, r.phone, r.sl_no, r.pincode));
      // "Not on WhatsApp?" moved to Member Details.
    };
    rebuildContact();

    const historyBtn = el("button", { class: "history-btn", title: t("title.chant_history") }, "📅");
    historyBtn.addEventListener("click", async () => {
      const existing = li.querySelector(".history-strip");
      if (existing) { existing.remove(); return; }
      const strip = await buildHistoryStrip(r.id, { row: r, chantBtn: chant });
      li.append(strip);
    });

    const li = el("li", {}, el("div", { class: "bead-wrap" }, rowBead), name, lifecycle, chant, contactWrap, historyBtn);
    ul.append(li);

    if (canManage) {
      const mgr = el("button", { class: "mini-btn" }, t("btn.manage"));
      li.append(mgr);
      mgr.addEventListener("click", async () => {
        const existing = li.querySelector(".manage");
        if (existing) { existing.remove(); return; }
        const panel = await buildManagePanel(r, currentOwnerUserId, () => li.querySelector(".manage")?.remove());
        li.append(panel);
      });
    }
  });
  return ul;
}

async function buildManagePanel(person, currentOwnerUserId, onDone) {
  const users = await loadAllUsers();
  const REASSIGN_ROLES = ["njy_coordinator", "njy_leader", "manjari_servant_leader", "servant_leader", "hk_leader"];
  const panel = el("div", { class: "manage" });

  // Reassign — two-step picker: pick role, then a filtered name list.
  const currentUser = users.find(u => u.id === currentOwnerUserId);
  const roleSel = el("select", {},
    ...REASSIGN_ROLES.map(r =>
      el("option", { value: r, selected: currentUser && currentUser.role === r ? true : undefined },
        humanRole(r))),
  );
  const userSel = el("select", {});
  function fillUserSel() {
    userSel.innerHTML = "";
    const filtered = users.filter(u => u.role === roleSel.value && u.active);
    if (!filtered.length) {
      userSel.append(el("option", { value: "" }, "- no active users in this role -"));
      return;
    }
    filtered.forEach(u => {
      userSel.append(el("option", { value: u.id, selected: u.id === currentOwnerUserId ? true : undefined },
        u.display_name || u.username));
    });
  }
  roleSel.addEventListener("change", fillUserSel);
  fillUserSel();

  const assignBtn = el("button", { class: "mini-btn" }, t("btn.move_short"));
  assignBtn.addEventListener("click", async () => {
    if (!userSel.value) return alert(t("team.pick_user_move"));
    try {
      await api(`/api/person/${person.id}/assign`, {
        method: "POST", body: JSON.stringify({ assigned_to_user_id: userSel.value }),
      });
      alert(t("team.moved_refreshing"));
      renderRoute();
    } catch (err) { alert(err.message); }
  });
  panel.append(el("div", {},
    el("label", {}, t("hd.reassign_role")), roleSel,
    el("label", { style: "margin-top:.4rem" }, t("hd.then_pick")), userSel,
    el("div", { style: "margin-top:.4rem" }, assignBtn),
  ));

  // Status change
  const statusSel = el("select", {},
    ...["chanter","qualified","daily","njy1","njy2","njy3","manjari","bv_member","dropped"]
      .map(s => el("option", { value: s, selected: person.status === s ? true : undefined }, lifecycleLabel(s) || (s === "qualified" ? "Qualified" : s))),
  );
  const statusBtn = el("button", { class: "mini-btn" }, t("btn.set_status_short"));
  statusBtn.addEventListener("click", async () => {
    try {
      await api(`/api/person/${person.id}/status`, {
        method: "POST", body: JSON.stringify({ status: statusSel.value }),
      });
      alert(`${t("team.status_now_prefix")}${statusSel.value}`);
    } catch (err) { alert(err.message); }
  });
  panel.append(el("div", {},
    el("label", {}, t("hd.lifecycle_status")), statusSel,
    el("div", { style: "margin-top:.4rem" }, statusBtn),
  ));

  // Delete
  const del = el("button", { class: "danger" }, t("btn.delete_person"));
  del.addEventListener("click", async () => {
    if (!confirm(`${t("team.delete_confirm_prefix")}${person.name}${t("team.delete_confirm_suffix")}`)) return;
    try {
      await api(`/api/member/${person.id}`, { method: "DELETE" });
      alert(t("team.deleted"));
      renderRoute();
    } catch (err) { alert(err.message); }
  });
  panel.append(el("div", { class: "full" }, del));
  return panel;
}

// -------------------------------------------------------- duties ---
async function renderDuties(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(el("h2", { class: "section" }, t("nav.duties")));
  view.append(helpBanner(t("help.duties")));
  if (!can("duties_view_list")) {
    view.append(el("p", { class: "hint" }, t("msg.no_access_duties")));
    return;
  }
  try {
    const { duties } = await api("/api/duties");
    if (myToken !== routeToken) return;
    if (!duties.length) return view.append(el("p", { class: "hint" }, t("msg.no_pending_duties")));
    const ul = el("ul", { class: "list" });
    for (const d of duties) {
      const done = el("button", { class: "primary" }, t("btn.done_short"));
      if (!can("duties_mark_done")) done.hidden = true;
      done.addEventListener("click", async () => {
        await api(`/api/duties/${d.id}/done`, { method: "POST" });
        renderRoute();
      });
      const li = el("li", {},
        el("div", {}, el("strong", {}, d.kind.replace(/_/g," ")),
          el("div", { class: "hint" }, `due ${d.due_date}${d.notes ? " · " + esc(d.notes) : ""}`)),
        el("div", {}), done,
      );
      // Delete option (gated: duties_delete — HK-only by default)
      if (can("duties_delete")) {
        const del = el("button", { class: "danger", style: "margin-left:.4rem" }, t("btn.delete_short"));
        del.addEventListener("click", async () => {
          if (!confirm(t("confirm.delete_duty"))) return;
          try {
            await api(`/api/duties/${d.id}`, { method: "DELETE" });
            renderRoute();
          } catch (err) { alert(err.message); }
        });
        li.children[2].append(del);
      }
      ul.append(li);
    }
    view.append(ul);
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}

// -------------------------------------------- events list clickable ---
// Each row links to its per-event attendance page.
async function renderEvents(view) {
  const myToken = routeToken;  // BUG 1+2
  view.innerHTML = "";
  view.append(el("h2", { class: "section" }, t("hd.events")));
  view.append(helpBanner(t("help.events")));
  if (!can("events_view_list")) {
    view.append(el("p", { class: "hint" }, t("msg.no_access_events")));
    return;
  }
  try {
    const { events } = await api("/api/events");
    if (myToken !== routeToken) return;
    if (!events.length) return view.append(el("p", { class: "hint" }, t("msg.no_events")));
    const ul = el("ul", { class: "list" });
    for (const ev of events) {
      ul.append(el("li", {},
        el("div", {}, el("strong", {}, ev.name),
          el("div", { class: "hint" }, `${ev.kind} · ${ev.event_date}${ev.venue ? " · " + esc(ev.venue) : ""}${ev.capacity ? " · cap " + ev.capacity : ""}`)),
        el("span", { class: "pill" }, ev.event_date),
        el("a", { class: "btn", href: `#/events/${ev.id}` }, t("btn.attendance")),
      ));
    }
    view.append(ul);
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}

// ----------------------------------------- per-event attendance ---
async function renderEventAttendance(eventId) {
  const myToken = routeToken;  // BUG 1+2
  const view = $("view");
  try {
    const { event, attended_ids, attended_count } = await api(`/api/events/${encodeURIComponent(eventId)}`);
    if (myToken !== routeToken) return;
    view.append(el("div", { class: "spread" },
      el("div", {}, el("h2", { class: "section" }, event.name),
        el("div", { class: "hint" }, `${event.kind} · ${event.event_date}${event.venue ? " · " + esc(event.venue) : ""}`)),
      el("a", { class: "btn", href: "#/events" }, t("btn.back")),
    ));
    const attendedSet = new Set(attended_ids);

    const tally = el("div", { class: "tally" });
    const capCell = el("div", { class: "cell" },
      el("div", { class: "n" }, String(event.capacity || "-")),
      el("div", { class: "k" }, t("ev.capacity_label")));
    const nCell = el("div", { class: "cell" },
      el("div", { class: "n", id: "att-n" }, String(attended_count)),
      el("div", { class: "k" }, t("ev.attended_label")));
    tally.append(nCell, capCell);
    view.append(tally);

    // Per-coordinator attendance card — now interactive. Each coord
    // row expands in place to show that coord's roll as a mark-present
    // checklist. Coordinators can only expand their own row (server
    // enforces via /api/user/:userId/roll access rules).
    const breakdown = (arguments && (await api(`/api/events/${encodeURIComponent(eventId)}`)).breakdown) || [];
    if (myToken !== routeToken) return;
    if (breakdown.length) {
      const card = el("div", { class: "card" });
      card.append(el("h3", { class: "section" }, t("hd.attendance_by_coord")));
      card.append(el("p", { class: "hint" }, ME.role === "njy_coordinator"
        ? t("help.attendance_by_coord_coord")
        : t("help.attendance_by_coord_leader")));
      const bul = el("ul", { class: "list" });
      for (const b of breakdown) {
        // Progress bar measured against the coord's real roll size,
        // not a hardcoded target.
        const denom = Math.max(1, b.assigned || 0);
        const pct = Math.min(100, Math.round(100 * b.attended / denom));
        const mid = pct >= 60 ? 0 : (pct >= 30 ? 1 : 2);
        const bodyId = `att-body-${b.user_id}`;
        const isSelf = b.user_id === ME.id;
        const header = el("div", {
          style: "cursor:pointer;width:100%",
          role: "button",
          "aria-expanded": "false",
        },
          el("div", { class: "spread" },
            el("strong", {}, b.name + (isSelf ? t("ev.you_suffix") : "")),
            el("span", { class: "hint" }, `${b.attended}/${b.assigned}${t("ev.in_roll_expand_suffix")}`),
          ),
          el("div", { class: "progress-line", style: "margin-top:.4rem" },
            el("span", {}, t("ev.attended_label")),
            el("span", { class: "fraction" }, `${b.attended}${t("ev.attendance_of_infix")}${b.assigned || 0}`),
          ),
          el("div", { class: "pbar", "data-mid": String(mid), style: `--pct:${pct}%` }),
        );
        const body = el("div", { id: bodyId, style: "display:none;margin-top:.75rem" });
        header.addEventListener("click", async () => {
          const shown = body.style.display === "block";
          if (shown) { body.style.display = "none"; header.setAttribute("aria-expanded", "false"); return; }
          if (!body.dataset.loaded) {
            try {
              const { roll } = await api(`/api/user/${encodeURIComponent(b.user_id)}/roll`);
              const ul = el("ul", { class: "roll" });
              for (const p of roll) {
                const isOn = attendedSet.has(p.id);
                const bd = bead(isOn ? "green" : "white", null);
                bd.title = isOn ? t("ev.tooltip_attended") : t("ev.tooltip_not_attended");
                const nameEl = el("div", { class: "name" });
                nameEl.innerHTML = esc(p.name) + `<span class="phone">${esc(p.phone || "")}</span>`;
                const toggle = el("button", { class: "chant-tag" + (isOn ? " on" : "") },
                  isOn ? t("ev.present_undo") : t("ev.mark_present"));
                toggle.addEventListener("click", async (ev) => {
                  ev.stopPropagation();
                  const next = !attendedSet.has(p.id);
                  try {
                    await api(`/api/events/${encodeURIComponent(event.id)}/attendance`, {
                      method: "POST", body: JSON.stringify({ person_id: p.id, attended: next }),
                    });
                    if (next) attendedSet.add(p.id); else attendedSet.delete(p.id);
                    toggle.className = "chant-tag" + (next ? " on" : "");
                    toggle.textContent = next ? t("ev.present_undo") : t("ev.mark_present");
                    bd.dataset.color = next ? "green" : "white";
                    $("att-n").textContent = String(attendedSet.size);
                  } catch (err) { alert(err.message); }
                });
                ul.append(el("li", {}, el("div", { class: "bead-wrap" }, bd), nameEl, el("span", {}), toggle, el("span", {})));
              }
              body.append(ul);
              body.dataset.loaded = "1";
            } catch (err) {
              body.append(el("p", { class: "hint" }, err.status === 403
                ? t("ev.cant_mark_other")
                : t("ev.could_not_load_roll") + err.message));
              body.dataset.loaded = "1";
            }
          }
          body.style.display = "block";
          header.setAttribute("aria-expanded", "true");
        });
        bul.append(el("li", {}, el("div", { style: "width:100%" }, header, body)));
        // Auto-expand the coord's own row so they land straight into it
        if (isSelf) queueMicrotask(() => header.click());
      }
      card.append(bul);
      view.append(card);
    }

    const searchCard = el("div", { class: "card" });
    searchCard.append(
      el("h3", { class: "section" }, t("hd.search_mark")),
      el("p", { class: "hint" }, t("help.search_mark")),
      formField(t("field.search"), el("input", { id: "att-q", placeholder: t("ev.ph_search"), autocapitalize: "none", autocorrect: "off" })),
    );
    const results = el("ul", { class: "roll", id: "att-results" });
    searchCard.append(results);
    view.append(searchCard);

    const doSearch = debounce(async () => {
      const q = $("att-q").value.trim();
      results.innerHTML = "";
      if (q.length < 2) return;
      const { people } = await api(`/api/people/search?q=${encodeURIComponent(q)}`);
      if (!people.length) { results.append(el("li", {}, el("span", { class: "hint" }, t("ev.no_match")))); return; }
      for (const p of people) {
        const isOn = attendedSet.has(p.id);
        const b = bead(isOn ? 2 : 0, null);
        b.title = isOn ? t("ev.tooltip_attended") : t("ev.tooltip_not_attended");
        const name = el("div", { class: "name", html: esc(p.name) + `<span class="phone">${esc(p.phone || "")}</span>` });
        const toggle = el("button", { class: "chant-tag" + (isOn ? " on" : "") },
          isOn ? t("ev.present_undo") : t("ev.mark_present"));
        toggle.addEventListener("click", async () => {
          const next = !attendedSet.has(p.id);
          try {
            await api(`/api/events/${encodeURIComponent(event.id)}/attendance`, {
              method: "POST", body: JSON.stringify({ person_id: p.id, attended: next }),
            });
            if (next) attendedSet.add(p.id); else attendedSet.delete(p.id);
            toggle.className = "chant-tag" + (next ? " on" : "");
            toggle.textContent = next ? t("ev.present_undo") : t("ev.mark_present");
            b.dataset.color = next ? "green" : "white";
            $("att-n").textContent = String(attendedSet.size);
          } catch (err) { alert(err.message); }
        });
        results.append(el("li", {}, el("div", { class: "bead-wrap" }, b), name, toggle, el("span", {})));
      }
    }, 250);

    searchCard.querySelector("#att-q").addEventListener("input", doSearch);
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ------------------------------------- Excel + CSV upload helper -----
// Lazy-load SheetJS (full build — needed for template generation too)
// only when the user first clicks upload or "Download template".
let _xlsxPromise = null;
function loadXlsx() {
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    if (window.XLSX) return resolve(window.XLSX);
    const s = document.createElement("script");
    s.src = "https://cdn.sheetjs.com/xlsx-latest/package/dist/xlsx.full.min.js";
    s.async = true;
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error(t("xl.load_err")));
    document.head.appendChild(s);
  });
  return _xlsxPromise;
}

// Build and download an .xlsx template with the "mobile" column
// pre-formatted as Text — this stops Excel from auto-converting long
// numbers to scientific notation.
async function downloadXlsxTemplate() {
  // Legacy default — the chanter template (kept for old call sites).
  return downloadChanterTemplate();
}

async function downloadChanterTemplate() {
  const XLSX = await loadXlsx();
  const data = [
    ["coupon_no", "name", "mobile", "pincode", "is_daily", "coord_username"],
    [1, "Ravi Kumar",    "9999000001", "625001", "yes", "coord01"],
    [2, "Priya Sundari", "9999000002", "625002", "no",  "coord01"],
    [3, "Anand Gopal",   "9999000003", "625003", "yes", "coord02"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  // Mobile column (index 2) as text
  for (let r = range.s.r; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 2 });
    if (ws[addr]) { ws[addr].t = "s"; ws[addr].z = "@"; }
  }
  ws["!cols"] = [{ wch: 10 }, { wch: 22 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Chanters");
  XLSX.writeFile(wb, "chanter-template.xlsx");
}

async function downloadUsersTemplate() {
  const XLSX = await loadXlsx();
  const data = [
    ["username", "password", "display_name", "phone", "role", "manager_username"],
    ["leader01", "pass1234", "Bhakti Vinod Leader",      "9999000101", "njy_leader", ""],
    ["coord01",  "pass1234", "Sri Krsna Coordinator",    "9999000201", "njy_coordinator", "leader01"],
    ["coord02",  "pass1234", "Radha Priya Coordinator",  "9999000202", "njy_coordinator", "leader01"],
    ["coord03",  "pass1234", "Gopala Coordinator",       "9999000203", "njy_coordinator", "leader01"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const range = XLSX.utils.decode_range(ws["!ref"]);
  // Phone column (index 3) as text
  for (let r = range.s.r; r <= range.e.r; r++) {
    const addr = XLSX.utils.encode_cell({ r, c: 3 });
    if (ws[addr]) { ws[addr].t = "s"; ws[addr].z = "@"; }
  }
  ws["!cols"] = [{ wch: 14 }, { wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 18 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Users");
  XLSX.writeFile(wb, "users-template.xlsx");
}

// Read an .xlsx/.xls/.csv file into an array of row objects. First row
// is the header; each subsequent row is mapped to {headerName: value}.
async function readSpreadsheetFile(file) {
  const XLSX = await loadXlsx();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

// Build a "Upload Excel / CSV" widget that:
//   1. Lets the user pick a file
//   2. Parses client-side, shows a preview table
//   3. Confirm button submits parsed rows to a caller-supplied handler
//
// mapRow(rowObj) → { name, mobile, pincode, ... } (or whatever the API
// expects). onCommit(mappedRows) does the actual API call.
function excelUploadWidget({ helperText, mapRow, onCommit, templateBuilder, templateLabel, previewCols, isValidRow, emptyMessage, previewRow, templateGateKey, commitGateKey }) {
  const wrap = el("div", {});
  const tplLabel = templateLabel || t("btn.download_template");
  const tplBtn = el("button", { type: "button", class: "ghost" }, tplLabel);
  // Hide template-download button if caller wired a gate that this role
  // can't access. Same for the commit button below.
  if (templateGateKey && !can(templateGateKey)) tplBtn.hidden = true;
  tplBtn.addEventListener("click", async () => {
    tplBtn.disabled = true;
    tplBtn.textContent = t("xl.generating");
    try {
      await (templateBuilder || downloadXlsxTemplate)();
      tplBtn.textContent = tplLabel;
    } catch (err) {
      tplBtn.textContent = t("xl.failed_try_again");
    } finally {
      tplBtn.disabled = false;
    }
  });
  wrap.append(
    el("p", { class: "hint" }, helperText),
    el("p", {}, tplBtn,
      el("span", { class: "hint" }, t("xl.helper_suffix")),
    ),
  );
  const fileInput = el("input", { type: "file", accept: ".xlsx,.xls,.csv" });
  const previewBox = el("div", { style: "margin-top:.7rem" });
  const commitBtn = el("button", { class: "primary", type: "button", disabled: true }, t("btn.confirm"));
  if (commitGateKey && !can(commitGateKey)) commitBtn.hidden = true;
  const msg = el("span", { class: "hint", style: "margin-left:.6rem" });

  let parsedRows = [];

  fileInput.addEventListener("change", async () => {
    previewBox.innerHTML = "";
    commitBtn.disabled = true;
    if (!fileInput.files[0]) return;
    msg.textContent = t("msg.parsing");
    try {
      const raw = await readSpreadsheetFile(fileInput.files[0]);
      const rowIsValid = isValidRow || ((r) => r.name && r.mobile);
      const mapped = raw.map(mapRow);
      parsedRows = mapped.filter(rowIsValid);
      // Console-log everything about the parse so client-side rejects
      // aren't invisible. The complaint was "nothing here as well" —
      // now every parse dump shows header keys, kept count, and each
      // rejected row with its reason.
      const droppedCount = mapped.length - parsedRows.length;
      console.groupCollapsed(`%c[import parse] raw:${raw.length}  kept:${parsedRows.length}  dropped:${droppedCount}`,
        droppedCount ? "color:#c07a00;font-weight:600" : "color:#0a7b52;font-weight:600");
      console.log("first raw row (sheet columns as-is):", raw[0] || "(empty)");
      console.log("first mapped row (after column rename):", mapped[0] || "(empty)");
      console.log("validator check:", rowIsValid.toString());
      if (droppedCount) {
        console.log("dropped rows (first 20):");
        let shown = 0;
        for (let i = 0; i < mapped.length && shown < 20; i++) {
          if (!rowIsValid(mapped[i])) {
            console.log(`  row ${i}: raw=`, raw[i], " mapped=", mapped[i]);
            shown++;
          }
        }
      }
      console.groupEnd();
      if (!parsedRows.length) {
        // Print header keys the sheet actually had so operator can
        // eyeball spelling issues (e.g. "Coupon_no" vs "coupon_no").
        const headers = raw[0] ? Object.keys(raw[0]) : [];
        previewBox.append(el("p", { class: "error" }, emptyMessage
          || t("xl.no_usable_default")));
        if (headers.length) {
          previewBox.append(el("p", { class: "hint", style: "font-family:var(--font-mono);font-size:.75rem;color:var(--muted)" },
            t("xl.headers_prefix"), el("code", {}, headers.join(", "))));
        }
        msg.textContent = "";
        return;
      }
      msg.textContent = `${t("xl.parsed_prefix")}${parsedRows.length}${t("xl.parsed_suffix")}`;
      const table = el("table", { style: "width:100%;border-collapse:collapse;font-size:.85rem;margin-top:.4rem" });
      // Default preview is chanter-shaped; each caller can override with
      // previewCols (header labels) + previewRow (row -> [cell values]).
      const cols = previewCols || [t("xl.col_name"), t("xl.col_mobile"), t("xl.col_pincode")];
      const rowFn = previewRow || ((r) => [r.name || "", r.mobile || "", r.pincode || ""]);
      const head = el("tr", {}, ...cols.map(c =>
        el("th", { style: "text-align:left;border-bottom:1px solid var(--line);padding:.3rem" }, c)));
      table.append(head);
      parsedRows.slice(0, 8).forEach(r => {
        table.append(el("tr", {},
          ...rowFn(r).map(v =>
            el("td", { style: "padding:.3rem;border-bottom:1px solid var(--line)" }, String(v ?? ""))),
        ));
      });
      previewBox.append(table);
      if (parsedRows.length > 8) previewBox.append(el("p", { class: "hint" }, `${t("xl.and_more_prefix")}${parsedRows.length - 8}${t("xl.and_more_suffix")}`));
      commitBtn.disabled = false;
    } catch (err) {
      previewBox.append(el("p", { class: "error" }, err.message || t("xl.could_not_read")));
      msg.textContent = "";
    }
  });

  const errBox = el("div", { style: "margin-top:.6rem" });
  commitBtn.addEventListener("click", async () => {
    commitBtn.disabled = true;
    msg.textContent = t("msg.importing");
    errBox.innerHTML = "";
    try {
      const result = await onCommit(parsedRows);
      const created = result.created ?? parsedRows.length;
      const errs = result.errors || [];
      msg.textContent = `${t("xl.imported_prefix")}${created}${errs.length ? `${t("xl.errors_middle")}${errs.length}${t("xl.errors_suffix")}` : ""}`;

      // Case A — some rows failed on the backend. Render each with a
      // friendly reason (humanizeError translates codes like
      // "username_taken" → "That username is already used…").
      if (errs.length) {
        const card = el("div", { class: "card", style: "border-color:#c02020;background:#fff5f5;margin-top:.5rem" });
        card.append(el("h4", { style: "color:#c02020;margin:0 0 .3rem" }, `${errs.length}${t("xl.rejected_suffix")}`));
        const ul = el("ul", { style: "margin:.2rem 0 0;padding-left:1.2rem;font-size:.85rem" });
        errs.slice(0, 20).forEach(e => {
          const label = e.row?.username || e.username || e.row?.name || e.name || e.row?.legal_name || e.legal_name || `row #${(e.index ?? "?") + 1}`;
          const rawReason = e.error || e.reason || (e.message ? e.message : "");
          const friendly = humanizeError({ body: { error: rawReason }, status: 400 });
          ul.append(el("li", { style: "margin-bottom:.2rem" },
            el("strong", {}, label), " - ",
            el("span", {}, friendly),
            el("span", { class: "hint", style: "margin-left:.4rem;font-family:var(--font-mono);font-size:.7rem" }, `[${rawReason}]`),
          ));
        });
        if (errs.length > 20) ul.append(el("li", { class: "hint" }, `…and ${errs.length - 20} more (see browser console)`));
        card.append(ul);
        errBox.append(card);
        console.groupCollapsed(`%c[import] ${errs.length} row error(s)`, "color:#c02020;font-weight:600");
        errs.forEach((e, i) => console.log(`row ${i}:`, e));
        console.groupEnd();
      }

      // Case B — the server returned created:0 with NO row-errors. Very
      // suspicious (usually means all rows were silently filtered or the
      // endpoint returned an unexpected shape). Surface it loudly.
      if (created === 0 && !errs.length) {
        const card = el("div", { class: "card", style: "border-color:#c07a00;background:#fff8ee;margin-top:.5rem" });
        card.append(el("h4", { style: "color:#c07a00;margin:0 0 .3rem" }, t("xl.zero_hd")));
        card.append(el("p", { style: "margin:0;font-size:.85rem" }, t("xl.zero_body")));
        errBox.append(card);
      }

      previewBox.innerHTML = "";
      fileInput.value = "";
      parsedRows = [];
      commitBtn.disabled = created > 0;
    } catch (err) {
      // Whole-request failure (network, 500, 403, etc). Show friendly
      // message on-screen AND full detail in the error box + console.
      const friendly = humanizeError(err);
      msg.textContent = t("xl.import_failed_prefix") + friendly;
      const card = el("div", { class: "card", style: "border-color:#c02020;background:#fff5f5;margin-top:.5rem" });
      card.append(el("h4", { style: "color:#c02020;margin:0 0 .3rem" }, t("msg.error_prefix").replace(":","")));
      card.append(el("p", { style: "margin:0 0 .3rem;font-size:.9rem" }, friendly));
      const detail = err.body?.error || err.message || "unknown";
      card.append(el("p", { class: "hint", style: "margin:0;font-family:var(--font-mono);font-size:.75rem" },
        `Raw: HTTP ${err.status || "?"} · ${detail}`));
      errBox.append(card);
      console.error("[import commit] failed:", err);
      commitBtn.disabled = false;
    }
  });

  wrap.append(fileInput, previewBox, el("p", { style: "margin-top:.6rem" }, commitBtn, msg), errBox);
  return wrap;
}

// --------------------------------------------------------- sadhana ---
// Two modes:
//   #/sadhana                → browse-mode: recent entries across everyone,
//                              plus a person picker. For HK Leader, SL, SS,
//                              CS reviewing their tier.
//   #/sadhana/<person_id>    → entry-mode: the 124-pt/day form for that
//                              person. Filled by the BV Member (self)
//                              or their Servant Leader on their behalf.
async function renderSadhana(personId) {
  const view = $("view");
  if (!personId) return renderSadhanaBrowse(view);
  view.append(el("div", { class: "spread" },
    el("h2", { class: "section" }, t("hd.sadhana_daily_entry")),
    el("a", { class: "btn", href: "#/sadhana" }, t("sd.back_browse")),
  ));
  view.append(el("p", { class: "hint" }, t("help.sadhana_daily")));
  const card = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
  const today = new Date().toISOString().slice(0, 10);
  card.append(
    formField(t("sd.field_person_id"), el("input", { id: "sd-person", value: personId || "", required: true, readonly: true })),
    formField(t("sd.field_date"), el("input", { id: "sd-date", type: "date", value: today })),
    el("div", { class: "grid2" },
      formField(t("sd.field_wakeup_time"), el("input", { id: "sd-wake", placeholder: t("sd.ph_wakeup") })),
      formField(t("sd.field_wakeup_pts"), el("input", { id: "sd-wake-pts", type: "number", min: "0", max: "10", value: "0" })),
    ),
    formField(t("sd.field_mangala"), el("input", { id: "sd-mangala", type: "number", value: "0", min: "0", max: "10" })),
    el("h3", { class: "section" }, t("hd.rounds_chanted")),
    el("div", { class: "grid2" },
      formField(t("sd.field_before7"), el("input", { id: "sd-r-1", type: "number", value: "0", min: "0" })),
      formField(t("sd.field_7_8"), el("input", { id: "sd-r-2", type: "number", value: "0", min: "0" })),
      formField(t("sd.field_8_10"), el("input", { id: "sd-r-3", type: "number", value: "0", min: "0" })),
      formField(t("sd.field_after10"), el("input", { id: "sd-r-4", type: "number", value: "0", min: "0" })),
    ),
    el("h3", { class: "section" }, t("hd.sravanam_seva")),
    el("div", { class: "grid2" },
      formField(t("sd.field_read_min"), el("input", { id: "sd-read-min", type: "number", value: "0" })),
      formField(t("sd.field_read_pts"), el("input", { id: "sd-read-pts", type: "number", value: "0" })),
      formField(t("sd.field_hear_min"), el("input", { id: "sd-hear-min", type: "number", value: "0" })),
      formField(t("sd.field_hear_pts"), el("input", { id: "sd-hear-pts", type: "number", value: "0" })),
      formField(t("sd.field_seva_pts"), el("input", { id: "sd-seva", type: "number", value: "0", max: "10" })),
      formField(t("sd.field_preach_pts"), el("input", { id: "sd-preach", type: "number", value: "0", max: "10" })),
    ),
    el("p", { style: "margin-top:1rem" },
      el("button", { type: "submit", class: "primary" }, t("btn.save_entry")),
      " ", el("span", { class: "hint", id: "sd-msg" }),
    ),
  );
  card.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      person_id: $("sd-person").value.trim(),
      entry_date: $("sd-date").value,
      wake_up_time: $("sd-wake").value || null,
      wake_up_pts: +$("sd-wake-pts").value,
      mangala_arati_pts: +$("sd-mangala").value,
      rounds_before_7: +$("sd-r-1").value,
      rounds_7_8: +$("sd-r-2").value,
      rounds_8_10: +$("sd-r-3").value,
      rounds_after_10: +$("sd-r-4").value,
      reading_mins: +$("sd-read-min").value,
      reading_pts: +$("sd-read-pts").value,
      hearing_mins: +$("sd-hear-min").value,
      hearing_pts: +$("sd-hear-pts").value,
      seva_pts: +$("sd-seva").value,
      preaching_pts: +$("sd-preach").value,
    };
    try {
      const r = await api("/api/sadhana", { method: "POST", body: JSON.stringify(body) });
      $("sd-msg").textContent = `${t("sd.saved_prefix")}${r.entry.total_pts}${t("sd.saved_suffix")}`;
    } catch (err) { $("sd-msg").textContent = t("sd.error_prefix") + err.message; }
  };
  view.append(card);
}

function formField(labelText, control) {
  const l = el("label", {}, labelText);
  return el("div", {}, l, control);
}

// Password field with an eye 👁 button that toggles between hidden and
// shown. Used in Settings > Change password and could be reused on the
// sign-in page in future.
function passwordFieldWithEye(id, labelText) {
  const input = el("input", { id, type: "password", required: true, autocomplete: "new-password" });
  const eye = el("button", { type: "button", class: "eye-btn", "aria-label": t("aria.show_hide_pw") }, "👁");
  eye.addEventListener("click", () => {
    if (input.type === "password") { input.type = "text"; eye.textContent = "🙈"; }
    else { input.type = "password"; eye.textContent = "👁"; }
  });
  const inputWrap = el("div", { class: "eye-wrap" }, input, eye);
  const wrap = el("div", {}, el("label", {}, labelText), inputWrap);
  return { wrap, input, eye };
}

// -------------------------------------------- sadhana browse mode ---
async function renderSadhanaBrowse(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(el("h2", { class: "section" }, t("hd.sadhana_browse")));
  view.append(el("p", { class: "hint" }, t("help.sadhana_browse")));

  const search = el("div", { class: "card" });
  search.append(
    el("h3", { class: "section" }, t("hd.find_member")),
    formField(t("field.search"), el("input", { id: "sd-q", placeholder: t("sd.ph_search"), autocapitalize: "none" })),
    el("ul", { class: "roll", id: "sd-results" }),
  );
  view.append(search);
  const doSearch = debounce(async () => {
    const q = $("sd-q").value.trim();
    const ul = $("sd-results"); ul.innerHTML = "";
    if (q.length < 2) return;
    const { people } = await api(`/api/people/search?q=${encodeURIComponent(q)}`);
    if (!people.length) return ul.append(el("li", {}, el("span", { class: "hint" }, t("ev.no_match"))));
    for (const p of people) {
      ul.append(el("li", {},
        el("div", { class: "bead-wrap" }, bead(0)),
        el("div", { class: "name", html: esc(p.name) + `<span class="phone">${esc(p.phone || "")}</span>` }),
        el("a", { class: "wa", href: `#/sadhana/${p.id}` }, t("sd.open")),
        el("span", {}),
      ));
    }
  }, 250);
  search.querySelector("#sd-q").addEventListener("input", doSearch);

  view.append(el("h3", { class: "section" }, t("hd.recent_entries")));
  try {
    const { entries } = await api("/api/sadhana?limit=20");
    if (myToken !== routeToken) return;
    if (!entries.length) return view.append(el("p", { class: "hint" }, t("msg.no_sadhana_entries")));
    const ul = el("ul", { class: "list" });
    for (const e of entries) {
      const li = el("li", {},
        el("div", {}, el("strong", {}, e.person_name),
          el("div", { class: "hint" }, `${e.entry_date}${t("sd.rounds_infix")}${(e.rounds_before_7||0)+(e.rounds_7_8||0)+(e.rounds_8_10||0)+(e.rounds_after_10||0)}`)),
        el("span", { class: "score" }, `${e.total_pts || 0}${t("sd.pts_of_124_suffix")}`),
        el("div", {}),
      );
      const actions = li.lastChild;
      const open = el("a", { class: "mini-btn", href: `#/sadhana/${e.person_id}` }, t("sd.open"));
      const del = el("button", { class: "danger", style: "margin-left:.4rem" }, t("sd.delete"));
      del.addEventListener("click", async () => {
        if (!confirm(`${t("sd.confirm_delete_prefix")}${e.person_name}${t("sd.confirm_delete_infix")}${e.entry_date}${t("sd.confirm_delete_suffix")}`)) return;
        try {
          await api(`/api/sadhana/${e.id}`, { method: "DELETE" });
          renderRoute();
        } catch (err) { alert(err.message); }
      });
      actions.append(open, del);
      ul.append(li);
    }
    view.append(ul);
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}

// -------------------------------------------------- BV structure ---
async function renderBvStructure(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(el("h2", { class: "section" }, t("hd.bv_structure")));
  view.append(helpBanner(t("bv.help_prefix")));
  view.append(el("p", { class: "hint" }, t("help.bv_structure")));
  try {
    const { circles, sectors, bv_groups } = await api("/api/bv/structure");
    if (myToken !== routeToken) return;
    view.append(el("h3", { class: "section" }, `${t("bv.circles_prefix")}${circles.length}${t("bv.count_suffix")}`));
    view.append(structureList(circles));
    view.append(el("h3", { class: "section" }, `${t("bv.sectors_prefix")}${sectors.length}${t("bv.count_suffix")}`));
    view.append(structureList(sectors));
    view.append(el("h3", { class: "section" }, `${t("bv.groups_prefix")}${bv_groups.length}${t("bv.count_suffix")}`));
    view.append(structureList(bv_groups));
    view.append(newGroupForm());
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}
function structureList(groups) {
  if (!groups.length) return el("p", { class: "hint" }, t("msg.none_yet"));
  const ul = el("ul", { class: "list" });
  for (const g of groups) {
    const li = el("li", {},
      el("div", {}, el("strong", {}, g.name),
        el("div", { class: "hint" }, `${g.kind}${g.meeting_day ? " · " + g.meeting_day : ""}${g.meeting_time ? " " + g.meeting_time : ""}`)),
      el("span", { class: "pill" }, g.target_strength ? `${g.target_strength}${t("bv.target_suffix")}` : ""),
      el("div", {}),
    );
    const actions = li.lastChild;
    const editBtn = el("button", { class: "mini-btn" }, t("btn.edit_short"));
    const delBtn = el("button", { class: "danger", style: "margin-left:.4rem" }, t("btn.delete_short"));
    actions.append(editBtn, delBtn);
    editBtn.addEventListener("click", () => {
      const existing = li.querySelector(".manage");
      if (existing) { existing.remove(); return; }
      const p = el("div", { class: "manage" },
        formField(t("bv.gform_name"), el("input", { id: `ge-name-${g.id}`, value: g.name })),
        formField(t("bv.gform_day"), el("input", { id: `ge-day-${g.id}`, value: g.meeting_day || "" })),
        formField(t("bv.gform_time"), el("input", { id: `ge-time-${g.id}`, value: g.meeting_time || "" })),
        formField(t("bv.gform_venue"), el("input", { id: `ge-venue-${g.id}`, value: g.meeting_venue || "" })),
        formField(t("bv.gform_target"), el("input", { id: `ge-str-${g.id}`, type: "number", value: g.target_strength || "" })),
      );
      const save = el("button", { class: "primary" }, t("btn.save"));
      save.addEventListener("click", async () => {
        try {
          await api("/api/bv/group", { method: "POST", body: JSON.stringify({
            id: g.id, name: $(`ge-name-${g.id}`).value, kind: g.kind,
            meeting_day: $(`ge-day-${g.id}`).value,
            meeting_time: $(`ge-time-${g.id}`).value,
            meeting_venue: $(`ge-venue-${g.id}`).value,
            target_strength: $(`ge-str-${g.id}`).value ? +$(`ge-str-${g.id}`).value : null,
          }) });
          renderRoute();
        } catch (err) { alert(err.message); }
      });
      p.append(el("div", { class: "full" }, save));
      li.append(p);
    });
    delBtn.addEventListener("click", async () => {
      if (!confirm(`${t("bv.delete_confirm_prefix")}${g.name}${t("bv.delete_confirm_suffix")}`)) return;
      try {
        await api(`/api/bv/group/${g.id}`, { method: "DELETE" });
        renderRoute();
      } catch (err) { alert(err.message); }
    });
    ul.append(li);
  }
  return ul;
}
function newGroupForm() {
  const card = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
  card.append(
    el("h3", { class: "section" }, t("hd.new_group")),
    formField(t("bv.gform_name"), el("input", { id: "g-name", required: true })),
    formField(t("bv.kind_label"), el("select", { id: "g-kind" },
      el("option", { value: "bv_group" }, t("bv.kind_bv_group")),
      el("option", { value: "sector" }, t("bv.kind_sector")),
      el("option", { value: "circle" }, t("bv.kind_circle")),
      el("option", { value: "manjari" }, t("bv.kind_manjari")),
      el("option", { value: "njy_group" }, t("bv.kind_njy_group")),
    )),
    el("div", { class: "grid2" },
      formField(t("bv.gform_day"), el("input", { id: "g-day", placeholder: t("bv.ph_day") })),
      formField(t("bv.gform_time"), el("input", { id: "g-time", placeholder: t("bv.ph_time") })),
    ),
    formField(t("bv.gform_venue_short"), el("input", { id: "g-venue" })),
    formField(t("bv.gform_target"), el("input", { id: "g-strength", type: "number" })),
    el("p", {}, el("button", { class: "primary", type: "submit" }, t("btn.save_group")),
      " ", el("span", { class: "hint", id: "g-msg" })),
  );
  card.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      name: $("g-name").value, kind: $("g-kind").value,
      meeting_day: $("g-day").value, meeting_time: $("g-time").value,
      meeting_venue: $("g-venue").value,
      target_strength: $("g-strength").value ? +$("g-strength").value : null,
    };
    try {
      await api("/api/bv/group", { method: "POST", body: JSON.stringify(body) });
      $("g-msg").textContent = t("msg.saved_short"); renderRoute();
    } catch (err) { $("g-msg").textContent = err.message; }
  };
  return card;
}

// -------------------------------------------------- member details ---
// ---------------------------------------------------- Members tab ---
// Three-section table view of every Member in the database:
//   1. My Members       — role-scoped ownership (coord: my roll;
//                         leader: my coords' rolls; hk: hidden).
//   2. Other Coords'    — assigned to someone else.
//   3. Unassigned Pool  — assigned_to_user_id IS NULL.
// One shared search box filters all three sections at once by name,
// phone, or SL. Column headers are click-sortable per section. Leader
// and HK see checkboxes on the Unassigned section plus a floating bar
// to bulk-assign selected members to one of the coords they manage.
async function renderMembers(view) {
  const myToken = routeToken;
  view.innerHTML = "";
  view.append(el("h2", { class: "section" }, t("hd.members")));
  view.append(helpBanner(t("help.members")));
  if (!can("members_tab")) {
    view.append(el("p", { class: "hint" }, t("msg.no_access_admin")));
    return;
  }

  const loading = el("p", { class: "hint" }, t("msg.loading"));
  view.append(loading);

  let payload;
  try {
    payload = await api("/api/members/list");
  } catch (err) {
    if (myToken !== routeToken) return;
    loading.remove();
    view.append(el("p", { class: "error" }, err.message));
    return;
  }
  if (myToken !== routeToken) return;
  loading.remove();

  const { people, eligible_coords } = payload;
  // Bulk-assign is HK Leader only. Leaders now see Unassigned Pool as
  // view-only (they must ask HK Leader to assign). Coord no longer sees
  // Unassigned Pool at all.
  const canBulkAssign = ME.role === "hk_leader" && eligible_coords.length > 0;

  // Optional "+ Add Coordinator" / "+ Add Leader" buttons — leader + HK.
  // Rendered above the search bar so they're the first thing operators
  // see on the tab. The forms themselves are deferred (built only on
  // first click) so the Members tab renders immediately for the common
  // case where the operator is just browsing.
  //   • Leader (njy_leader):   sees "+ Add Coordinator" only
  //   • Director (hk_leader): sees BOTH "+ Add Coordinator" and
  //                              "+ Add Leader" side-by-side
  const addSlot = el("div", { id: "add-coord-slot",
    style: "display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.4rem" });
  view.append(addSlot);
  if (["njy_leader", "hk_leader"].includes(ME.role)) {
    addSlot.append(buildAddPersonButton(addSlot, "coord"));
  }
  if (ME.role === "hk_leader") {
    addSlot.append(buildAddPersonButton(addSlot, "leader"));
  }

  // Sub-tab pill row: People / Coordinators / Leaders. Coord only sees
  // People; leader sees People + Coordinators (their team); HK sees all
  // three. Counts fill in as each tab loads its data (or 0 if unloaded).
  const tabRow = el("div", {
    class: "members-tabs",
    role: "tablist",
    style: "display:flex;gap:.4rem;flex-wrap:wrap;margin:.4rem 0 .7rem",
  });
  const peopleContent = el("div", { id: "members-tab-people" });
  const coordsContent = el("div", { id: "members-tab-coords", hidden: true });
  const leadersContent = el("div", { id: "members-tab-leaders", hidden: true });
  const tabsAvail = ["people"];
  if (["hk_leader", "njy_leader"].includes(ME.role)) tabsAvail.push("coords");
  if (ME.role === "hk_leader") tabsAvail.push("leaders");
  const labelKey = { people: "members.tab.people", coords: "members.tab.coords", leaders: "members.tab.leaders" };
  const pillRefs = {};   // { people: pillEl, coords: ..., leaders: ... }
  const contentByKey = { people: peopleContent, coords: coordsContent, leaders: leadersContent };
  const setPill = (kind, count) => {
    const pill = pillRefs[kind];
    if (!pill) return;
    pill.textContent = `${t(labelKey[kind])} (${count == null ? "…" : count})`;
  };
  const loadedTabs = new Set();
  const activateTab = (kind) => {
    for (const k of tabsAvail) {
      const on = k === kind;
      contentByKey[k].hidden = !on;
      if (pillRefs[k]) pillRefs[k].classList.toggle("active", on);
    }
    if (kind === "coords" && !loadedTabs.has("coords")) {
      loadedTabs.add("coords");
      renderMembersCoordsTab(coordsContent, (n) => setPill("coords", n));
    }
    if (kind === "leaders" && !loadedTabs.has("leaders")) {
      loadedTabs.add("leaders");
      renderMembersLeadersTab(leadersContent, (n) => setPill("leaders", n));
    }
  };
  for (const kind of tabsAvail) {
    const pill = el("button", {
      type: "button",
      role: "tab",
      class: "members-tab-pill" + (kind === "people" ? " active" : ""),
      style: "padding:.4rem .85rem;border-radius:999px;border:1px solid var(--line);"
        + "background:var(--surface);color:var(--ink);font-size:.85rem;cursor:pointer;font-weight:500",
    }, `${t(labelKey[kind])} (…)`);
    pill.addEventListener("click", () => activateTab(kind));
    pillRefs[kind] = pill;
    tabRow.append(pill);
  }
  view.append(tabRow);
  view.append(peopleContent);
  view.append(coordsContent);
  view.append(leadersContent);

  // Search bar (client-side filter across all 3 sections).
  const searchInput = el("input", {
    type: "search", id: "members-search",
    placeholder: t("members.search_ph"),
    autocomplete: "off", autocapitalize: "none", autocorrect: "off",
    style: "width:100%;padding:.55rem;border:1px solid var(--line);border-radius:6px;margin:.4rem 0 .7rem",
  });
  peopleContent.append(searchInput);

  // Bucketize. Members flagged not_interested=1 are hidden from every
  // section (they belong nowhere in the assignment pipeline). They
  // still exist in the DB and remain openable via Member Details from
  // other entry points (search, direct link) — the Leader/Director can
  // un-mark them from there.
  const assignable = people.filter(p => !p.not_interested);
  const byId = new Map(assignable.map(p => [p.id, p]));
  const buckets = { mine: [], others: [], unassigned: [] };
  for (const p of assignable) buckets[p.section].push(p);

  // Per-section state: search-filtered rows, sort key + direction.
  const sectionsState = {
    mine:       { rows: buckets.mine,       sortKey: "name", sortDir: 1 },
    others:     { rows: buckets.others,     sortKey: "name", sortDir: 1 },
    unassigned: { rows: buckets.unassigned, sortKey: "name", sortDir: 1 },
  };
  const selected = new Set();  // person ids checked in the unassigned bulk-assign UI

  const sectionsWrap = el("div", { id: "members-sections" });
  peopleContent.append(sectionsWrap);

  // Bulk-assign floating bar (leader + HK only, only for unassigned).
  const bulkBar = el("div", {
    id: "members-bulk-bar",
    style: "position:sticky;bottom:0;left:0;right:0;background:var(--surface);border-top:1px solid var(--line);"
      + "padding:.6rem;display:none;gap:.5rem;align-items:center;flex-wrap:wrap;box-shadow:0 -2px 8px rgba(0,0,0,.06);z-index:5",
  });
  const bulkCount = el("span", { style: "font-weight:600" }, "");
  const bulkSelect = el("select", { style: "flex:1;min-width:10rem;padding:.4rem" });
  // Precompute gender + a lookup by coord id (used by highlight + auto-fill).
  // Uses userGender(): DB `gender` column wins, name-inference is the
  // fallback for legacy rows and any name-only calls elsewhere.
  const coordById = new Map();
  for (const c of eligible_coords) {
    const g = userGender(c);
    coordById.set(c.id, { ...c, gender: g });
  }
  bulkSelect.append(el("option", { value: "" }, t("members.bulk_pick_coord")));
  for (const c of eligible_coords) {
    const g = userGender(c);
    const label = `${c.display_name} (${g})`;
    bulkSelect.append(el("option", { value: c.id }, label));
  }
  const autoFillBtn = el("button", {
    class: "ghost", type: "button", id: "members-autofill-btn",
    style: "min-width:8rem",
  }, t("members.auto_fill_btn"));
  const bulkBtn = el("button", { class: "primary", type: "button" }, t("members.bulk_assign_btn"));
  const bulkMsg = el("span", { class: "hint" }, "");
  const autoFillMsg = el("span", { class: "hint", id: "members-autofill-msg" }, "");
  bulkBar.append(bulkCount, bulkSelect, autoFillBtn, bulkBtn, autoFillMsg, bulkMsg);
  if (canBulkAssign) peopleContent.append(bulkBar);

  const refreshBulkBar = () => {
    if (!canBulkAssign) return;
    if (selected.size === 0 && !bulkSelect.value) { bulkBar.style.display = "none"; return; }
    bulkBar.style.display = "flex";
    bulkCount.textContent = `${selected.size} ${t("members.bulk_selected_suffix")}`;
  };

  // Effective gender of a chanter — DB value first, else inferred from name.
  const chanterGender = (p) => {
    const raw = String(p.gender || "").toUpperCase();
    if (raw === "M" || raw === "F") return raw;
    return inferGender(p.name);
  };

  // Repaint the Unassigned Pool with matching-gender chanters highlighted
  // and non-matching greyed out when the operator has picked a target
  // coord. Called on coord-select change and after auto-fill.
  const applyGenderHighlight = () => {
    if (!canBulkAssign) return;
    const coord = coordById.get(bulkSelect.value);
    const targetG = coord ? coord.gender : "?";
    const tbody = document.querySelector("#members-sections .members-table tbody");
    // We identify the Unassigned section's tbody by scanning cards.
    // Every row carries data-person-id (added below) + data-gender.
    document.querySelectorAll("#members-sections tr[data-person-id]").forEach((tr) => {
      const g = tr.getAttribute("data-gender") || "?";
      tr.classList.remove("gender-match", "gender-nomatch");
      if (!coord) return;
      if (g === targetG && (targetG === "M" || targetG === "F")) {
        tr.classList.add("gender-match");
      } else {
        tr.classList.add("gender-nomatch");
      }
    });
  };
  bulkSelect.addEventListener("change", () => {
    applyGenderHighlight();
    refreshBulkBar();
    autoFillMsg.textContent = "";
  });

  // Auto-fill: pre-select up to 40 matching-gender unassigned chanters
  // for the target coord, applying the assignment mix rule that seeds do:
  //   • 17 pincoded chanters (same-pin > first-3-digits > any-pincoded)
  //   • 23 no-pincode chanters (random)
  //   • Strict gender match — never mix
  //   • Within each tier the candidates are shuffled BEFORE slicing so
  //     the picked 40 isn't just an alphabetical prefix of the source
  //     list (the visible symptom that led to this fix).
  // If a bucket runs short, we top up from the other bucket to still
  // hit 40 where the pool allows.
  autoFillBtn.addEventListener("click", () => {
    autoFillMsg.textContent = "";
    const coord = coordById.get(bulkSelect.value);
    if (!coord) { autoFillMsg.textContent = t("members.auto_fill_pick_coord"); return; }
    if (coord.gender === "?") { autoFillMsg.textContent = t("members.auto_fill_ambiguous"); return; }
    const CAP = 40, PIN_TARGET = 17, NOPIN_TARGET = 23;
    const coordPin = String(coord.pincode || "");
    const coordPin3 = coordPin.slice(0, 3);
    const matches = buckets.unassigned.filter(p => chanterGender(p) === coord.gender);
    const shuffle = (arr) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    // Split by pincode presence
    const pinced = matches.filter(p => String(p.pincode || "").trim());
    const noPin  = matches.filter(p => !String(p.pincode || "").trim());
    // For pincoded: three tier buckets, shuffled inside each tier
    const tier1 = shuffle(pinced.filter(p => coordPin && String(p.pincode) === coordPin));
    const tier2 = shuffle(pinced.filter(p => coordPin3 && String(p.pincode).startsWith(coordPin3) && String(p.pincode) !== coordPin));
    const tier3 = shuffle(pinced.filter(p => !tier1.includes(p) && !tier2.includes(p)));
    const pincedOrdered = [...tier1, ...tier2, ...tier3];
    const noPinOrdered  = shuffle(noPin);
    let pinPicks   = pincedOrdered.slice(0, PIN_TARGET);
    let noPinPicks = noPinOrdered.slice(0, NOPIN_TARGET);
    // Top-up: if one bucket ran short, fill from the other so we still
    // reach 40 when the total pool allows it.
    if (pinPicks.length < PIN_TARGET) {
      const need = PIN_TARGET - pinPicks.length;
      noPinPicks = noPinOrdered.slice(0, NOPIN_TARGET + need);
    } else if (noPinPicks.length < NOPIN_TARGET) {
      const need = NOPIN_TARGET - noPinPicks.length;
      pinPicks = pincedOrdered.slice(0, PIN_TARGET + need);
    }
    const picked = [...pinPicks, ...noPinPicks].slice(0, CAP);
    selected.clear();
    for (const p of picked) selected.add(p.id);
    autoFillMsg.textContent = `${t("members.auto_fill_prefix")}${picked.length}${t("members.auto_fill_suffix")}`;
    renderAll();
    applyGenderHighlight();
    refreshBulkBar();
  });

  bulkBtn.addEventListener("click", async () => {
    const userId = bulkSelect.value;
    if (!userId) { bulkMsg.textContent = t("members.bulk_pick_coord"); return; }
    if (!selected.size) return;
    bulkBtn.disabled = true;
    bulkMsg.textContent = t("msg.loading");
    try {
      const ids = [...selected];
      const r = await api("/api/members/bulk-assign", {
        method: "POST", body: JSON.stringify({ person_ids: ids, user_id: userId }),
      });
      // Move the freshly-assigned rows out of the "unassigned" bucket
      // and into "others" (never "mine" — a leader assigning to their
      // own coord is still not the leader's ownership). Refresh the
      // three tables in place so the operator sees the change.
      const targetCoord = eligible_coords.find(c => c.id === userId);
      const targetName = targetCoord ? targetCoord.display_name : "";
      const still = [];
      for (const p of buckets.unassigned) {
        if (selected.has(p.id)) {
          p.assigned_to_user_id = userId;
          p.assigned_coord_name = targetName;
          // For a leader: their own coords count as "mine"; for HK the
          // caller has no "mine" bucket so it lands in "others".
          p.section = (ME.role === "njy_leader") ? "mine" : "others";
          if (p.section === "mine") buckets.mine.push(p);
          else buckets.others.push(p);
        } else {
          still.push(p);
        }
      }
      buckets.unassigned = still;
      sectionsState.mine.rows = buckets.mine;
      sectionsState.others.rows = buckets.others;
      sectionsState.unassigned.rows = buckets.unassigned;
      selected.clear();
      bulkMsg.textContent = `${t("members.bulk_ok_prefix")}${r.assigned}${t("members.bulk_ok_suffix")}`;
      bulkSelect.value = "";
      renderAll();
      refreshBulkBar();
    } catch (err) {
      bulkMsg.textContent = err.message;
    } finally {
      bulkBtn.disabled = false;
    }
  });

  // Sort helpers.
  const sortVal = (p, key) => {
    switch (key) {
      case "sl":     return (p.sl_no || "").toString().toLowerCase();
      case "name":   return (p.name || "").toLowerCase();
      case "phone":  return (p.phone || "").replace(/\D/g, "");
      case "pin":    return p.pincode || "";
      case "coord":  return (p.assigned_coord_name || "").toLowerCase();
      default:       return "";
    }
  };
  const applySort = (rows, key, dir) => {
    return rows.slice().sort((a, b) => {
      const av = sortVal(a, key), bv = sortVal(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });
  };
  const filterRows = (rows, q) => {
    if (!q) return rows;
    const lower = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    return rows.filter(p =>
      (p.name || "").toLowerCase().includes(lower)
      || (digits && (p.phone || "").replace(/\D/g, "").includes(digits))
      || (p.sl_no != null && String(p.sl_no).toLowerCase().includes(lower)),
    );
  };

  // Build one section's card (header + count + table).
  //
  // Uses the .members-table styles in app.css — compact, sticky-header,
  // zebra-striped, horizontally scrollable on narrow phones. Each cell
  // carries a semantic class (.sl-cell, .name-cell, .phone-cell, …) so
  // typography and alignment are consistent across the three sections
  // and don't drift when a caller tweaks inline styles.
  const buildSection = (kind, titleKey, showCoordCol, showCheckbox) => {
    const state = sectionsState[kind];
    const showGenderCol = showCheckbox;   // gender column rides with the HK-only bulk-assign column
    const card = el("div", { class: "card", style: "margin-bottom:.8rem;padding:0;overflow:hidden" });
    const header = el("div", { class: "spread",
      style: "padding:.6rem .8rem;background:var(--surface-sunk);border-bottom:1px solid var(--line)" });
    const countPill = el("span", { class: "pill" }, "0");
    header.append(el("h3", { class: "section", style: "margin:0" }, t(titleKey)), countPill);
    card.append(header);

    // Horizontal scroll wrapper — lets narrow phones swipe sideways
    // instead of the columns collapsing into unreadable slivers.
    const wrap = el("div", { class: "members-table-wrap" });
    const table = el("table", { class: "members-table" });
    const thead = el("thead");
    const trh = el("tr");
    const cols = [];
    if (showCheckbox) cols.push({ key: "_chk", label: "", cls: "col-check" });
    cols.push({ key: "sl",    label: t("members.col.sl"),    cls: "sl-cell" });
    cols.push({ key: "name",  label: t("members.col.name"),  cls: "name-cell" });
    if (showGenderCol) cols.push({ key: "gender", label: t("members.col.gender"), cls: "gender-cell" });
    cols.push({ key: "phone", label: t("members.col.phone"), cls: "phone-cell" });
    cols.push({ key: "pin",   label: t("members.col.pincode"), cls: "pin-cell" });
    if (showCoordCol) cols.push({ key: "coord", label: t("members.col.assigned_coord"), cls: "coord-cell" });
    cols.push({ key: "_go", label: "", cls: "actions-cell" });
    for (const col of cols) {
      const isSortable = !col.key.startsWith("_");
      const th = el("th", {
        class: (col.cls || "") + (isSortable ? " sortable" : ""),
        "data-key": col.key,
      }, col.label);
      if (isSortable) {
        th.addEventListener("click", () => {
          if (state.sortKey === col.key) state.sortDir *= -1;
          else { state.sortKey = col.key; state.sortDir = 1; }
          repaint();
        });
        if (state.sortKey === col.key) {
          th.append(el("span", { class: "sort-ind" }, state.sortDir === 1 ? "▲" : "▼"));
        }
      }
      trh.append(th);
    }
    thead.append(trh);
    table.append(thead);
    const tbody = el("tbody");
    table.append(tbody);
    wrap.append(table);
    card.append(wrap);

    const repaint = () => {
      const q = searchInput.value.trim();
      const filtered = filterRows(state.rows, q);
      const sorted = applySort(filtered, state.sortKey, state.sortDir);
      countPill.textContent = String(sorted.length);
      tbody.innerHTML = "";
      if (!sorted.length) {
        const tr = el("tr", { class: "empty-row" });
        tr.append(el("td", { colspan: cols.length }, t("members.empty_section")));
        tbody.append(tr);
      } else {
        sorted.forEach((p) => {
          const g = chanterGender(p);
          const tr = el("tr", { "data-person-id": p.id, "data-gender": g });
          tr.addEventListener("click", (ev) => {
            // Don't hijack clicks on the checkbox / drill button.
            if (ev.target.tagName === "INPUT" || ev.target.tagName === "A" || ev.target.tagName === "BUTTON") return;
            location.hash = `#/member/${encodeURIComponent(p.id)}`;
          });
          if (showCheckbox) {
            const cb = el("input", { type: "checkbox" });
            if (selected.has(p.id)) cb.setAttribute("checked", "");
            cb.addEventListener("change", () => {
              if (cb.checked) selected.add(p.id);
              else selected.delete(p.id);
              refreshBulkBar();
            });
            tr.append(el("td", { class: "col-check" }, cb));
          }
          tr.append(el("td", { class: "sl-cell" },
            (p.sl_no != null && p.sl_no !== "") ? String(p.sl_no) : "—"));
          tr.append(el("td", { class: "name-cell" }, p.name || "—"));
          if (showGenderCol) {
            tr.append(el("td", { class: "gender-cell" }, g));
          }
          const phoneCell = el("td", { class: "phone-cell" });
          if (p.phone) {
            phoneCell.append(document.createTextNode(p.phone));
            const waDigits = String(p.phone).replace(/[^\d]/g, "");
            if (waDigits) {
              const wa = el("a", {
                class: "wa-btn",
                href: `https://api.whatsapp.com/send/?phone=${waDigits}`,
                target: "_blank", rel: "noopener",
                title: `WhatsApp: ${p.phone}`,
                onclick: (e) => e.stopPropagation(),
              }, "💬");
              phoneCell.append(wa);
            }
          } else {
            phoneCell.append(document.createTextNode("—"));
          }
          tr.append(phoneCell);
          tr.append(el("td", { class: "pin-cell" }, p.pincode || "—"));
          if (showCoordCol) {
            tr.append(el("td", { class: "coord-cell" }, p.assigned_coord_name || "—"));
          }
          tr.append(el("td", { class: "actions-cell" },
            el("a", { class: "btn ghost", href: `#/member/${encodeURIComponent(p.id)}`,
              onclick: (e) => e.stopPropagation() }, t("btn.open"))));
          tbody.append(tr);
        });
      }
    };

    return { card, repaint };
  };

  // Role-scoped tables:
  //   njy_coordinator → only "My Members" (no Others, no Unassigned).
  //   njy_leader      → "My Team's Members" + Unassigned Pool (view-only,
  //                     with an info notice above pointing at HK Leader).
  //   hk_leader       → Other Coords' Members + Unassigned Pool (bulk-assign).
  const built = [];
  if (ME.role === "njy_coordinator") {
    built.push(buildSection("mine", "members.section_mine", /*coord*/ false, /*chk*/ false));
    for (const b of built) sectionsWrap.append(b.card);
  } else if (ME.role === "njy_leader") {
    // Leaders see ONLY their team's members. Unassigned Pool is Super
    // Admin's responsibility, not exposed here.
    const mine = buildSection("mine", "members.section_mine_team", /*coord*/ true, /*chk*/ false);
    built.push(mine);
    sectionsWrap.append(mine.card);
  } else {
    // hk_leader
    built.push(buildSection("others", "members.section_others", /*coord*/ true, /*chk*/ false));
    built.push(buildSection("unassigned", "members.section_unassigned", /*coord*/ false, /*chk*/ canBulkAssign));
    for (const b of built) sectionsWrap.append(b.card);
  }

  const renderAll = () => {
    for (const b of built) b.repaint();
    applyGenderHighlight();
  };
  renderAll();

  // Search (debounced) — filter across all sections at once.
  let debounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(renderAll, 120);
  });

  // People count = total across all sections rendered on this tab.
  setPill("people", people.length);
  // Warm the other tabs' counts too so pills don't sit at "…" forever.
  if (tabsAvail.includes("coords")) setPill("coords", null);
  if (tabsAvail.includes("leaders")) setPill("leaders", null);
}

// Coordinators sub-tab — a full table of every coord the caller can
// see (HK: all; leader: only their team). Reuses /api/leader/coordinators
// so we get per-coord stats (assigned = whole roll size) for free.
async function renderMembersCoordsTab(container, setCount) {
  container.innerHTML = "";
  const loading = el("p", { class: "hint" }, t("msg.loading"));
  container.append(loading);
  let coordinators = [], users = [];
  try {
    const [coordsRes, usersRes] = await Promise.all([
      api("/api/leader/coordinators").catch(() => ({ coordinators: [] })),
      ME.role === "hk_leader"
        ? api("/api/admin/users").catch(() => ({ users: [] }))
        : Promise.resolve({ users: [] }),
    ]);
    coordinators = coordsRes.coordinators || [];
    users = usersRes.users || [];
  } catch (err) {
    loading.remove();
    container.append(el("p", { class: "error" }, err.message));
    return;
  }
  loading.remove();
  // Map leader user_id → display name so the Assigned Leader column
  // renders a human name rather than an opaque id. For HK the users
  // list carries every leader; for a njy_leader caller, all rows are
  // under themselves so we can hand-fill with their own display name.
  const leaderNameById = new Map();
  for (const u of users) {
    if (u.role === "njy_leader") leaderNameById.set(u.id, u.display_name || u.username);
  }
  if (ME.role === "njy_leader") leaderNameById.set(ME.id, ME.display_name || ME.username);

  setCount(coordinators.length);
  if (!coordinators.length) {
    container.append(el("p", { class: "hint" }, t("msg.no_coords_leader")));
    return;
  }

  // Search box
  const searchInput = el("input", {
    type: "search",
    placeholder: t("members.search_ph"),
    autocomplete: "off", autocapitalize: "none",
    style: "width:100%;padding:.55rem;border:1px solid var(--line);border-radius:6px;margin:.2rem 0 .7rem",
  });
  container.append(searchInput);

  const card = el("div", { class: "card", style: "margin-bottom:.8rem;padding:0;overflow:hidden" });
  const wrap = el("div", { class: "members-table-wrap" });
  const table = el("table", { class: "members-table" });
  const thead = el("thead");
  thead.append(el("tr", {},
    el("th", { class: "name-cell" }, t("members.col.name")),
    el("th", {}, t("members.col.username")),
    el("th", { class: "phone-cell" }, t("members.col.phone")),
    el("th", { class: "pin-cell" }, t("members.col.pincode")),
    el("th", {}, t("members.col.assigned_leader")),
    el("th", {}, t("members.col.team_size")),
    el("th", { class: "actions-cell" }, ""),
  ));
  table.append(thead);
  const tbody = el("tbody");
  table.append(tbody);
  wrap.append(table);
  card.append(wrap);
  container.append(card);

  const filterRows = (q) => {
    if (!q) return coordinators;
    const lower = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    return coordinators.filter(c =>
      (c.name || "").toLowerCase().includes(lower)
      || (c.username || "").toLowerCase().includes(lower)
      || (digits && (c.phone || "").replace(/\D/g, "").includes(digits)),
    );
  };
  const repaint = () => {
    const q = searchInput.value.trim();
    const rows = filterRows(q);
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.append(el("tr", { class: "empty-row" },
        el("td", { colspan: 7 }, t("members.empty_section"))));
      return;
    }
    for (const c of rows) {
      const canManage = ME.role === "hk_leader"
        || (ME.role === "njy_leader" && (!c.manager_user_id || c.manager_user_id === ME.id));
      const tr = el("tr", {});
      const actions = el("div", { style: "display:flex;gap:.25rem;flex-wrap:wrap;justify-content:flex-end" });
      if (c.phone) {
        const waDigits = String(c.phone).replace(/[^\d]/g, "");
        if (waDigits) {
          actions.append(el("a", {
            class: "wa-btn",
            href: `https://api.whatsapp.com/send/?phone=${waDigits}`,
            target: "_blank", rel: "noopener",
            title: `WhatsApp: ${c.phone}`,
          }, "💬"));
        }
        actions.append(callBtn(c.phone));
      }
      actions.append(el("a", { class: "btn ghost", href: `#/user/${c.user_id}` }, t("btn.open")));
      if (canManage) {
        const editBtn = el("button", { class: "mini-btn", type: "button" }, t("team.edit_coord_btn"));
        editBtn.addEventListener("click", () => openEditCoordModal(c));
        actions.append(editBtn);
        const delBtn = el("button", { class: "danger", type: "button" }, t("team.delete_coord_btn"));
        delBtn.addEventListener("click", () => openDeleteCoordConfirm(c));
        actions.append(delBtn);
      }
      tr.append(
        el("td", { class: "name-cell" }, c.name || "—"),
        el("td", {}, c.username || "—"),
        el("td", { class: "phone-cell" }, c.phone || "—"),
        el("td", { class: "pin-cell" }, c.pincode || "—"),
        el("td", {}, (c.manager_user_id && leaderNameById.get(c.manager_user_id)) || "—"),
        el("td", {}, String(c.assigned || 0)),
        el("td", { class: "actions-cell" }, actions),
      );
      tbody.append(tr);
    }
  };
  let debounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(repaint, 120);
  });
  repaint();
}

// Leaders sub-tab — HK-only listing of every NJY Leader with their
// coord + people totals. Uses /api/hk/leaders (already aggregated).
async function renderMembersLeadersTab(container, setCount) {
  container.innerHTML = "";
  const loading = el("p", { class: "hint" }, t("msg.loading"));
  container.append(loading);
  let leaders = [];
  try {
    const res = await api("/api/hk/leaders");
    leaders = res.leaders || [];
  } catch (err) {
    loading.remove();
    container.append(el("p", { class: "error" }, err.message));
    return;
  }
  loading.remove();
  setCount(leaders.length);
  if (!leaders.length) {
    container.append(el("p", { class: "hint" }, t("msg.no_coords_hk")));
    return;
  }

  const searchInput = el("input", {
    type: "search",
    placeholder: t("members.search_ph"),
    autocomplete: "off", autocapitalize: "none",
    style: "width:100%;padding:.55rem;border:1px solid var(--line);border-radius:6px;margin:.2rem 0 .7rem",
  });
  container.append(searchInput);

  const card = el("div", { class: "card", style: "margin-bottom:.8rem;padding:0;overflow:hidden" });
  const wrap = el("div", { class: "members-table-wrap" });
  const table = el("table", { class: "members-table" });
  const thead = el("thead");
  thead.append(el("tr", {},
    el("th", { class: "name-cell" }, t("members.col.name")),
    el("th", {}, t("members.col.username")),
    el("th", { class: "phone-cell" }, t("members.col.phone")),
    el("th", {}, t("members.col.coord_count")),
    el("th", {}, t("members.col.total_people")),
    el("th", { class: "actions-cell" }, ""),
  ));
  table.append(thead);
  const tbody = el("tbody");
  table.append(tbody);
  wrap.append(table);
  card.append(wrap);
  container.append(card);

  const filterRows = (q) => {
    if (!q) return leaders;
    const lower = q.toLowerCase();
    const digits = q.replace(/\D/g, "");
    return leaders.filter(l =>
      (l.name || "").toLowerCase().includes(lower)
      || (l.username || "").toLowerCase().includes(lower)
      || (digits && (l.phone || "").replace(/\D/g, "").includes(digits)),
    );
  };
  const repaint = () => {
    const q = searchInput.value.trim();
    const rows = filterRows(q);
    tbody.innerHTML = "";
    if (!rows.length) {
      tbody.append(el("tr", { class: "empty-row" },
        el("td", { colspan: 6 }, t("members.empty_section"))));
      return;
    }
    for (const l of rows) {
      const actions = el("div", { style: "display:flex;gap:.25rem;flex-wrap:wrap;justify-content:flex-end" });
      if (l.phone) {
        const waDigits = String(l.phone).replace(/[^\d]/g, "");
        if (waDigits) {
          actions.append(el("a", {
            class: "wa-btn",
            href: `https://api.whatsapp.com/send/?phone=${waDigits}`,
            target: "_blank", rel: "noopener",
            title: `WhatsApp: ${l.phone}`,
          }, "💬"));
        }
        actions.append(callBtn(l.phone));
      }
      actions.append(el("a", { class: "btn ghost", href: `#/leader/${l.user_id}` }, t("btn.open")));
      const tr = el("tr", {});
      tr.append(
        el("td", { class: "name-cell" }, l.name || "—"),
        el("td", {}, l.username || "—"),
        el("td", { class: "phone-cell" }, l.phone || "—"),
        el("td", {}, String(l.coord_count || 0)),
        el("td", {}, String(l.assigned || 0)),
        el("td", { class: "actions-cell" }, actions),
      );
      tbody.append(tr);
    }
  };
  let debounce = null;
  searchInput.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(repaint, 120);
  });
  repaint();
}

// ------------------ Add Coordinator / Add Leader inline form -------
// Simple in-place expand from a compact "+ Add Coordinator" or
// "+ Add Leader" button. Wired inside renderMembers so the form
// re-renders every visit and picks up caller identity fresh. The form
// is deferred (built only on first click) so the Members tab renders
// instantly for the common case where the operator is just browsing.
//
// kind is "coord" (leader + HK can add) or "leader" (HK Leader only).
// A leader form has no manager dropdown and posts to /api/hk/add-leader;
// a coord form keeps the existing HK-only "pick a leader" select and
// posts to /api/leader/add-coord. Both share layout, live username
// check, and the credential-share modal handoff.
function buildAddPersonButton(slot, kind) {
  const btnKey = kind === "leader" ? "members.add_leader_btn" : "members.add_coord_btn";
  const btn = el("button", {
    class: kind === "leader" ? "ghost" : "primary", type: "button",
  }, t(btnKey));
  btn.addEventListener("click", () => {
    slot.innerHTML = "";
    slot.style.display = "block";
    slot.append(buildAddPersonCard(slot, kind));
  });
  return btn;
}

// Keep the old name as a thin alias so any external caller (bookmark,
// test) that still references buildAddCoordButton keeps working.
function buildAddCoordButton(slot) { return buildAddPersonButton(slot, "coord"); }

function buildAddPersonCard(slot, kind) {
  const isLeader = kind === "leader";
  const titleKey = isLeader ? "members.add_leader_title" : "members.add_coord_title";
  const endpoint = isLeader ? "/api/hk/add-leader" : "/api/leader/add-coord";

  const card = el("div", { class: "card", style: "margin-bottom:.7rem" });
  card.append(el("h3", { class: "section", style: "margin-top:0" }, t(titleKey)));
  const usernameI = el("input", { autocomplete: "off", autocapitalize: "none" });
  const usernameFlag = el("span", { class: "hint", style: "margin-left:.4rem" }, "");
  const displayI = el("input", { autocomplete: "off" });
  const passwordI = el("input", { type: "text", autocomplete: "new-password" });
  const phoneI = el("input", { inputmode: "tel", placeholder: "+91…" });
  const pincodeI = el("input", {
    inputmode: "numeric", maxlength: "6", autocomplete: "postal-code",
    placeholder: "560001",
  });
  const pincodeHint = el("p", {
    class: "hint",
    style: "margin:.15rem 0 .3rem;font-size:.78rem;color:var(--ink-2)",
  }, t("field.pincode_hint"));
  // Explicit gender radio so auto-assign can match reliably. Name-only
  // inference misses common Tamil first names without a devotional
  // suffix.
  const genderF = el("input", { type: "radio", name: "gender", value: "F" });
  const genderM = el("input", { type: "radio", name: "gender", value: "M" });
  const genderWrap = el("div", { style: "display:flex;gap:1rem;align-items:center" },
    el("label", { style: "display:flex;gap:.35rem;align-items:center" }, genderF, " Mataji"),
    el("label", { style: "display:flex;gap:.35rem;align-items:center" }, genderM, " Prabhu"),
  );
  const leaderSelect = el("select", {});
  const msg = el("span", { class: "hint", style: "margin-left:.5rem" }, "");
  const saveBtn = el("button", { class: "primary", type: "submit" }, t("btn.save"));
  const cancelBtn = el("button", { class: "ghost", type: "button" }, t("btn.cancel"));

  const usernameWrap = el("div", {}, el("label", {}, t("field.username")),
    el("div", { style: "display:flex;align-items:center" }, usernameI, usernameFlag));
  const form = el("form", { method: "post", action: "javascript:void(0)" });
  form.append(
    el("div", {}, el("label", {}, t("field.display_name")), displayI),
    usernameWrap,
    el("div", {}, el("label", {}, t("field.password")), passwordI),
    el("div", {}, el("label", {}, t("field.phone")), phoneI),
    el("div", {}, el("label", {}, t("field.pincode")), pincodeI, pincodeHint),
    el("div", {}, el("label", {}, t("field.gender")), genderWrap),
  );

  // Coord form + HK Leader caller: pick a leader to attach the coord
  // under. Leader form has NO manager — a leader sits at the top of
  // their own subtree, so we skip the dropdown entirely.
  if (!isLeader && ME.role === "hk_leader") {
    leaderSelect.append(el("option", { value: "" }, t("members.pick_leader")));
    // Populate leader list lazily.
    (async () => {
      try {
        const { users } = await api("/api/admin/users");
        for (const u of users) {
          if (u.role === "njy_leader" && u.active) {
            leaderSelect.append(el("option", { value: u.username }, u.display_name || u.username));
          }
        }
      } catch { /* fall back to empty select */ }
    })();
    form.append(el("div", {}, el("label", {}, t("members.leader_label")), leaderSelect));
    // HK hint: leader-touch onboarding points go to the assigned leader,
    // never HK. If HK creates a coord without picking a leader,
    // manager_user_id is NULL and no leader gets credited (by design).
    form.append(el("p", {
      class: "hint",
      style: "margin:.2rem 0 .3rem;font-size:.8rem;color:var(--ink-2)",
    }, t("members.hk_onboarding_points_hint")));
  }
  form.append(el("p", { style: "margin-top:.6rem" }, saveBtn, " ", cancelBtn, msg));
  card.append(form);

  // Live username availability check (debounced). Reuses the same
  // /api/leader/coord-username-check endpoint — it's gated to leader +
  // HK, and returns "is any user with this username" regardless of role.
  let checkTimer = null;
  usernameI.addEventListener("input", () => {
    const v = usernameI.value.trim();
    usernameFlag.textContent = "";
    usernameFlag.style.color = "";
    clearTimeout(checkTimer);
    if (v.length < 3) return;
    checkTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/leader/coord-username-check?u=${encodeURIComponent(v)}`);
        if (r.available) {
          usernameFlag.textContent = "✓ " + t("members.uname_ok");
          usernameFlag.style.color = "var(--mark-followed)";
        } else {
          usernameFlag.textContent = "✗ " + t("members.uname_taken");
          usernameFlag.style.color = "var(--mark-attention)";
        }
      } catch { /* silent */ }
    }, 250);
  });

  cancelBtn.addEventListener("click", () => {
    // Restore the full button row (both buttons for HK, just coord for leader).
    slot.innerHTML = "";
    slot.style.display = "flex";
    if (["njy_leader", "hk_leader"].includes(ME.role)) {
      slot.append(buildAddPersonButton(slot, "coord"));
    }
    if (ME.role === "hk_leader") {
      slot.append(buildAddPersonButton(slot, "leader"));
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    msg.textContent = "";
    const pincodeRaw = pincodeI.value.trim();
    if (pincodeRaw && !/^\d{6}$/.test(pincodeRaw)) {
      msg.textContent = t("field.pincode_invalid"); return;
    }
    const gender = genderF.checked ? "F" : (genderM.checked ? "M" : null);
    const body = {
      username: usernameI.value.trim(),
      password: passwordI.value,
      display_name: displayI.value.trim(),
      phone: phoneI.value.trim(),
      pincode: pincodeRaw || null,
      gender,
    };
    if (!isLeader && ME.role === "hk_leader") body.leader_username = leaderSelect.value;
    if (!body.username || !body.password || !body.display_name) {
      msg.textContent = t("members.add_coord_missing"); return;
    }
    if (!isLeader && ME.role === "hk_leader" && !body.leader_username) {
      msg.textContent = t("members.pick_leader"); return;
    }
    saveBtn.disabled = true;
    try {
      const r = await api(endpoint, {
        method: "POST", body: JSON.stringify(body),
      });
      msg.textContent = `${t("members.add_coord_ok_prefix")}${r.user.display_name || r.user.username}${t("members.add_coord_ok_suffix")}`;
      // Open the credential-share modal — WhatsApp handoff for the new
      // account's login. For a coord created by HK we also render the
      // "notify HK to assign members" nudge; for a leader (or any add
      // by HK themselves), that nudge is meaningless — HK IS creating
      // the account — so the modal suppresses it.
      openCredShareModal({
        user: r.user,
        plaintext_password: r.plaintext_password || body.password,
        kind,
      });
      // Reset for another add.
      usernameI.value = ""; displayI.value = ""; passwordI.value = ""; phoneI.value = "";
      pincodeI.value = "";
      usernameFlag.textContent = "";
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  };

  return card;
}

// ------------------ Credential-share modal --------------------------
// Opens right after a successful add-coord POST. Shows the new coord's
// username, plaintext password (echoed once from the server response —
// never fetched again), and the app URL. Two WhatsApp deep-link buttons
// let the operator hand the credentials to the coord and nudge HK to
// assign chanters. Backdrop-click and × both close.
function openCredShareModal({ user, plaintext_password, kind }) {
  const isLeader = kind === "leader";
  const origin = window.location.origin || "https://njy-thiruppalai.pages.dev";
  const username = user.username || "";
  const displayName = user.display_name || username;
  const coordPhoneDigits = String(user.phone || "").replace(/\D/g, "");
  const hkPhoneDigits = String(ME && ME.hk_phone || "").replace(/\D/g, "");
  const fullHonName = honorificAdjust(displayName);

  const backdrop = el("div", {
    id: "cred-share-backdrop",
    style: "position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:flex;align-items:flex-start;justify-content:center;padding:2rem 1rem;overflow-y:auto",
  });
  const box = el("div", {
    style: "background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);max-width:520px;width:100%;padding:1rem 1.2rem;box-shadow:var(--shadow)",
  });
  const closeBtn = el("button", { class: "ghost", type: "button", id: "cs-close" }, "✕");
  box.append(el("div", { class: "spread" },
    el("h3", { class: "section", style: "margin:0" },
      t(isLeader ? "cred_share.title_leader" : "cred_share.title")),
    closeBtn,
  ));
  box.append(el("p", { style: "margin:.3rem 0 .8rem" },
    t(isLeader ? "cred_share.created_prefix_leader" : "cred_share.created_prefix"),
    el("strong", {}, displayName),
  ));

  // Boxed credentials display.
  const credRow = (label, value) => el("div", {
    style: "display:flex;gap:.5rem;padding:.35rem 0;border-bottom:1px dashed var(--line);font-size:.92rem",
  },
    el("span", { style: "flex:0 0 5.5rem;color:var(--ink-2);font-weight:600" }, label),
    el("span", { style: "flex:1;word-break:break-all;font-family:ui-monospace,monospace" }, value),
  );
  const credsBox = el("div", {
    style: "background:var(--surface-sunk);border:1px solid var(--line);border-radius:6px;padding:.5rem .8rem;margin-bottom:.9rem",
  },
    credRow(t("cred_share.username"), username),
    credRow(t("cred_share.password"), plaintext_password || ""),
    credRow(t("cred_share.url"), origin),
  );
  box.append(credsBox);

  // WhatsApp buttons.
  const btnStyle = "display:block;width:100%;text-align:center;padding:.75rem;margin-bottom:.55rem;"
    + "background:#25d366;color:#fff;font-weight:600;border-radius:8px;text-decoration:none;font-size:.95rem";
  const btnDisabledStyle = btnStyle + ";background:var(--surface-sunk);color:var(--ink-2);cursor:not-allowed";

  // 1) Send login to the new coordinator / leader. Same message body
  // in both cases — just swap the role noun so the recipient sees the
  // right title. Uses honorificAdjust to render "Dasa → Prabhu" etc.
  const roleNoun = isLeader ? "NJY Leader" : "coordinator";
  const loginMsg = [
    `Hare Krsna ${fullHonName},`,
    ``,
    `You have been added as ${isLeader ? "an" : "a"} ${roleNoun} on the NJY app.`,
    ``,
    `URL: ${origin}`,
    `Username: ${username}`,
    `Password: ${plaintext_password || ""}`,
    ``,
    `Please log in and change your password after first sign-in.`,
    ``,
    `Hare Krsna.`,
  ].join("\n");
  const sendLabelKey = isLeader ? "cred_share.send_login_leader" : "cred_share.send_login";
  if (coordPhoneDigits) {
    box.append(el("a", {
      href: `https://api.whatsapp.com/send/?phone=${coordPhoneDigits}&text=${encodeURIComponent(loginMsg)}`,
      target: "_blank", rel: "noopener",
      style: btnStyle,
    }, "📤 " + t(sendLabelKey)));
  } else {
    box.append(el("div", { style: btnDisabledStyle }, "📤 " + t(sendLabelKey) + " (" + t("cred_share.no_phone") + ")"));
  }

  // 2) Notify HK to assign members — coord-only, and only when the HK
  // caller isn't the operator themselves (HK creating a coord already
  // knows to assign). For a new leader there's nothing to assign.
  //
  // If ME.hk_phone is set, deep-link straight to that chat. Otherwise
  // fall back to WhatsApp's contact picker (`send/?text=...` with no
  // `phone=`) so the leader can pick the Director from their own
  // contacts — the previous "hide the button" behaviour meant leaders
  // on rows without hk_phone had no visible nudge affordance at all.
  const showHkNudge = !isLeader && ME.role !== "hk_leader";
  if (showHkNudge) {
    const hkMsg = [
      `Hare Krsna Prabhu,`,
      ``,
      `I have added a new coordinator: ${displayName}.`,
      `Please assign chanters from the Unassigned Pool to their roll.`,
      ``,
      `Hare Krsna.`,
    ].join("\n");
    const waHref = hkPhoneDigits
      ? `https://api.whatsapp.com/send/?phone=${hkPhoneDigits}&text=${encodeURIComponent(hkMsg)}`
      : `https://api.whatsapp.com/send/?text=${encodeURIComponent(hkMsg)}`;
    box.append(el("a", {
      href: waHref,
      target: "_blank", rel: "noopener",
      style: btnStyle,
    }, "📤 " + t("cred_share.notify_hk")));
    if (!hkPhoneDigits) {
      box.append(el("p", {
        class: "hint",
        style: "margin:.15rem 0 .6rem;font-size:.8rem;text-align:center",
      }, t("cred_share.notify_hk_picker_hint")));
    }
  }

  box.append(el("p", { class: "hint", style: "margin-top:.7rem;font-size:.82rem" },
    t("cred_share.password_reminder")));

  closeBtn.addEventListener("click", () => backdrop.remove());
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  backdrop.append(box);
  document.body.append(backdrop);
}

async function renderMemberDetails(personId) {
  const myToken = routeToken;  // BUG 1+2
  const view = $("view");
  view.append(el("h2", { class: "section" }, t("hd.member_details")));
  if (!personId) return view.append(el("p", { class: "hint" }, t("msg.open_via_row")));
  try {
    const [{ person, assigned_coord }] = await Promise.all([
      api(`/api/member/${encodeURIComponent(personId)}`),
      refreshPendingDupCache(),
    ]);
    if (myToken !== routeToken) return;

    // Header banner: prominent "Assigned to: <coord name>" line plus a
    // Reassign button that fetches eligible-coords lazily and PATCHes
    // through the existing /api/person/:id/assign endpoint.
    const banner = el("div", {
      class: "card",
      style: "display:flex;gap:.6rem;align-items:center;flex-wrap:wrap;padding:.7rem .9rem;margin-bottom:.7rem",
    });
    const assignedLabel = el("span", { style: "font-weight:600" },
      t("members.assigned_to_label") + ": ");
    const assignedName = el("strong", { id: "m-coord-name", style: "color:var(--ink-2)" },
      assigned_coord ? assigned_coord.display_name : t("members.unassigned_label"));
    banner.append(assignedLabel, assignedName);
    // Reassign is a leader / Director action — coords cannot move
    // members off/onto other rolls. Only render the button for those roles.
    const canReassign = ME.role === "hk_leader" || ME.role === "njy_leader";
    let reassignBtn = null;
    let reassignArea = null;
    let notInterestedBtn = null;
    let notInterestedBadge = null;
    if (canReassign) {
      reassignBtn = el("button", { class: "btn", type: "button", style: "margin-left:auto" },
        t("members.reassign_btn"));
      reassignArea = el("div", {
        id: "m-reassign-area",
        style: "flex-basis:100%;display:none;margin-top:.5rem;align-items:center;gap:.5rem;flex-wrap:wrap",
      });
      // "Mark as Not Interested" — flags the person and clears any
      // assignment. Row stays in the DB (audit) but never appears in
      // Unassigned Pool, coord rolls, Auto-fill picker, or Bulk-assign.
      // If already marked, show a red badge + an Unmark button instead.
      if (person.not_interested) {
        notInterestedBadge = el("span", {
          style: "background:#fbeaea;color:#991B1B;border:1px solid #f0c4c4;border-radius:12px;padding:.2rem .6rem;font-size:.8rem;font-weight:600",
        }, t("members.not_interested_badge"));
        notInterestedBtn = el("button", { class: "btn", type: "button" },
          t("members.unmark_not_interested_btn"));
      } else {
        notInterestedBtn = el("button", { class: "btn", type: "button",
          style: "background:#fbeaea;color:#991B1B;border:1px solid #f0c4c4" },
          t("members.mark_not_interested_btn"));
      }
      banner.append(reassignBtn);
      if (notInterestedBadge) banner.append(notInterestedBadge);
      if (notInterestedBtn) banner.append(notInterestedBtn);
      banner.append(reassignArea);
    }
    view.append(banner);
    if (notInterestedBtn) notInterestedBtn.addEventListener("click", async () => {
      const isMarking = !person.not_interested;
      const confirmKey = isMarking ? "members.mark_not_interested_confirm" : "members.unmark_not_interested_confirm";
      if (!confirm(t(confirmKey))) return;
      notInterestedBtn.disabled = true;
      try {
        await api(`/api/person/${encodeURIComponent(personId)}/not-interested`, {
          method: "POST", body: JSON.stringify({ not_interested: isMarking ? 1 : 0 }),
        });
        person.not_interested = isMarking ? 1 : 0;
        if (isMarking) person.assigned_to_user_id = null;
        // Simplest UX: re-render the whole Member Details page so the
        // banner reflects the new state (badge/label/coord-name).
        renderMemberDetails(personId);
      } catch (err) {
        alert(err.message);
        notInterestedBtn.disabled = false;
      }
    });

    let eligibleLoaded = false;
    if (reassignBtn) reassignBtn.addEventListener("click", async () => {
      if (reassignArea.style.display !== "none") {
        reassignArea.style.display = "none"; return;
      }
      reassignArea.style.display = "flex";
      if (eligibleLoaded) return;
      eligibleLoaded = true;
      reassignArea.append(el("span", { class: "hint" }, t("msg.loading")));
      try {
        const { coords } = await api("/api/members/eligible-coords");
        reassignArea.innerHTML = "";
        const sel = el("select", { style: "flex:1;min-width:10rem;padding:.35rem" });
        sel.append(el("option", { value: "" }, t("members.bulk_pick_coord")));
        for (const c of coords) {
          const opt = el("option", { value: c.id }, c.display_name);
          if (person.assigned_to_user_id === c.id) opt.setAttribute("selected", "");
          sel.append(opt);
        }
        const goBtn = el("button", { class: "primary", type: "button" }, t("btn.save"));
        const msg = el("span", { class: "hint" }, "");
        reassignArea.append(sel, goBtn, msg);
        goBtn.addEventListener("click", async () => {
          const userId = sel.value;
          if (!userId) { msg.textContent = t("members.bulk_pick_coord"); return; }
          goBtn.disabled = true;
          msg.textContent = t("msg.loading");
          try {
            const r = await api(`/api/person/${encodeURIComponent(personId)}/assign`, {
              method: "POST", body: JSON.stringify({ assigned_to_user_id: userId }),
            });
            person.assigned_to_user_id = userId;
            const picked = coords.find(c => c.id === userId);
            $("m-coord-name").textContent = picked ? picked.display_name : t("members.unassigned_label");
            msg.textContent = t("msg.saved_short");
          } catch (err) {
            msg.textContent = err.message;
          } finally {
            goBtn.disabled = false;
          }
        });
      } catch (err) {
        reassignArea.innerHTML = "";
        reassignArea.append(el("span", { class: "error" }, err.message));
      }
    });

    // Editable SL number — small inline form so operators can fix a
    // wrongly-typed serial without touching the full editor below.
    const slCard = el("div", { class: "card",
      style: "display:flex;gap:.5rem;align-items:center;padding:.6rem .9rem;margin-bottom:.7rem" });
    slCard.append(el("span", { style: "font-weight:600" }, t("members.col.sl") + ": "));
    const slInput = el("input", {
      id: "m-sl", value: person.sl_no != null ? String(person.sl_no) : "",
      style: "flex:1;max-width:12rem;padding:.35rem;font-family:var(--font-mono)",
    });
    const slSaveBtn = el("button", { class: "primary", type: "button" }, t("members.sl_save"));
    const slMsg = el("span", { class: "hint" }, "");
    slCard.append(slInput, slSaveBtn, slMsg);
    view.append(slCard);
    slSaveBtn.addEventListener("click", async () => {
      const v = slInput.value.trim();
      if (v && !/^[A-Za-z0-9\-]{1,32}$/.test(v)) {
        slMsg.textContent = t("members.sl_invalid"); return;
      }
      slSaveBtn.disabled = true;
      slMsg.textContent = t("msg.loading");
      try {
        await api(`/api/member/${encodeURIComponent(personId)}`, {
          method: "POST", body: JSON.stringify({ sl_no: v === "" ? null : v }),
        });
        slMsg.textContent = t("members.sl_saved");
      } catch (err) {
        slMsg.textContent = err.message;
      } finally {
        slSaveBtn.disabled = false;
      }
    });

    // Duplicate-request control. Visible to coord who owns this member,
    // plus leader/HK (server enforces the ownership rule regardless).
    // Renders the pending pill if a flag is already open on this row.
    if (["njy_coordinator", "njy_leader", "hk_leader"].includes(ME.role)) {
      const dupCard = el("div", { class: "card",
        style: "display:flex;gap:.5rem;align-items:center;padding:.6rem .9rem;margin-bottom:.7rem;flex-wrap:wrap" });
      const paintDup = () => {
        dupCard.innerHTML = "";
        dupCard.append(el("span", { style: "font-weight:600" }, t("dup.form_title") + ": "));
        if (hasPendingDupFlag(personId)) {
          dupCard.append(pendingDupPill());
        } else {
          const p = { id: person.id, name: person.legal_name, sl_no: person.sl_no };
          dupCard.append(markDuplicateBtn(p, () => paintDup()));
        }
      };
      paintDup();
      view.append(dupCard);
    }

    // WhatsApp status toggle — coord/leader/HK can mark this member as
    // not-on-WhatsApp so future broadcasts skip them and their row uses
    // SMS instead. Small card mirrors the duplicate-request card style.
    if (["njy_coordinator", "njy_leader", "hk_leader"].includes(ME.role)) {
      const waCard = el("div", { class: "card",
        style: "display:flex;gap:.5rem;align-items:center;padding:.6rem .9rem;margin-bottom:.7rem;flex-wrap:wrap" });
      const paintWa = () => {
        waCard.innerHTML = "";
        const label = person.wa_status === 0
          ? t("btn.on_wa_toggle")
          : t("btn.mark_non_wa");
        waCard.append(el("span", { style: "font-weight:600" }, t("hd.wa_status") + ": "));
        waCard.append(el("span", { class: "hint" },
          person.wa_status === 0 ? t("msg.not_on_wa_state") : t("msg.on_wa_state")));
        const row = { id: person.id, wa_status: person.wa_status };
        const btn = markNonWaBtn(row, () => {
          person.wa_status = row.wa_status;
          paintWa();
        });
        btn.style.marginLeft = "auto";
        waCard.append(btn);
      };
      paintWa();
      view.append(waCard);
    }

    // Gender editor — the auto-assign strict gender match relies on this
    // being M or F. Members with unknown ('?') gender aren't picked up
    // by auto-fill. Small inline card so HK/leader can fix in one tap.
    if (["njy_coordinator", "njy_leader", "hk_leader"].includes(ME.role)) {
      const gCard = el("div", { class: "card",
        style: "display:flex;gap:.5rem;align-items:center;padding:.6rem .9rem;margin-bottom:.7rem;flex-wrap:wrap" });
      const paintG = () => {
        gCard.innerHTML = "";
        gCard.append(el("span", { style: "font-weight:600" }, t("field.gender") + ": "));
        const gVal = person.gender === "F" ? t("field.gender_f")
                  : person.gender === "M" ? t("field.gender_m")
                  : t("field.gender_unknown");
        gCard.append(el("span", { class: "hint" }, gVal));
        const setBtn = (val, label) => {
          const b = el("button", { type: "button", class: "mini-btn",
            style: "background:transparent;border:1px solid var(--line);color:var(--muted);padding:.2rem .55rem;border-radius:6px;font-size:.75rem;cursor:pointer" }, label);
          if (person.gender === val) {
            b.style.borderColor = "var(--peacock-deep, #0E4F52)";
            b.style.color = "var(--peacock-deep, #0E4F52)";
            b.style.fontWeight = "600";
          }
          b.addEventListener("click", async (e) => {
            e.preventDefault();
            b.disabled = true;
            try {
              await api(`/api/member/${encodeURIComponent(personId)}`, {
                method: "POST", body: JSON.stringify({ gender: val }),
              });
              person.gender = val;
              paintG();
            } catch (err) {
              alert(err.message);
              b.disabled = false;
            }
          });
          return b;
        };
        const btnWrap = el("div", { style: "margin-left:auto;display:flex;gap:.4rem" });
        btnWrap.append(setBtn("F", t("field.gender_f")));
        btnWrap.append(setBtn("M", t("field.gender_m")));
        gCard.append(btnWrap);
      };
      paintG();
      view.append(gCard);
    }

    const card = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
    const F = (id, label, val, extra = {}) =>
      formField(label, el("input", { id, value: val || "", ...extra }));
    card.append(
      el("h3", { class: "section" }, t("hd.personal")),
      F("m-name", t("md.field_legal_name"), person.legal_name),
      el("div", { class: "grid2" },
        F("m-gender", t("md.field_gender"), person.gender, { placeholder: t("md.ph_gender") }),
        F("m-dob", t("md.field_dob"), person.dob, { type: "date" }),
      ),
      el("div", { class: "grid2" },
        F("m-marital", t("md.field_marital"), person.marital_status),
        F("m-children", t("md.field_children"), person.num_children, { type: "number" }),
      ),
      F("m-spouse", t("md.field_spouse_name"), person.spouse_name),
      el("div", { class: "grid2" },
        F("m-spouse-dob", t("md.field_spouse_dob"), person.spouse_dob, { type: "date" }),
        F("m-anniv", t("md.field_anniv"), person.wedding_anniversary, { type: "date" }),
      ),
      F("m-addr", t("md.field_address"), person.address),
      el("div", { class: "grid2" },
        F("m-phone", t("md.field_phone"), person.phone),
        F("m-pincode", t("field.pincode"), person.pincode, { placeholder: t("md.ph_pincode") }),
      ),
      F("m-email", t("md.field_email"), person.email, { type: "email" }),
      el("h3", { class: "section" }, t("hd.work")),
      el("div", { class: "grid2" },
        F("m-edu", t("md.field_education"), person.education),
        F("m-occ", t("md.field_occupation"), person.occupation),
        F("m-org", t("md.field_organization"), person.organization),
        F("m-des", t("md.field_designation"), person.designation),
      ),
      F("m-lang", t("md.field_languages"), person.languages_known),
      el("h3", { class: "section" }, t("hd.notes")),
      formField(t("field.notes"), el("textarea", { id: "m-notes" }, person.notes || "")),
      el("p", {}, el("button", { class: "primary", type: "submit" }, t("btn.save")),
        " ", el("span", { class: "hint", id: "m-msg" })),
    );
    card.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        legal_name: $("m-name").value, gender: $("m-gender").value,
        dob: $("m-dob").value || null, marital_status: $("m-marital").value,
        num_children: $("m-children").value ? +$("m-children").value : null,
        spouse_name: $("m-spouse").value,
        spouse_dob: $("m-spouse-dob").value || null,
        wedding_anniversary: $("m-anniv").value || null,
        address: $("m-addr").value, phone: $("m-phone").value,
        pincode: $("m-pincode").value || null,
        email: $("m-email").value,
        education: $("m-edu").value, occupation: $("m-occ").value,
        organization: $("m-org").value, designation: $("m-des").value,
        languages_known: $("m-lang").value,
        notes: $("m-notes").value,
      };
      try {
        await api(`/api/member/${encodeURIComponent(personId)}`, { method: "POST", body: JSON.stringify(body) });
        $("m-msg").textContent = t("msg.saved_short");
      } catch (err) { $("m-msg").textContent = err.message; }
    };
    view.append(card);
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}

// -------------------------------------------- duplicate-request queue ---
// HK-only review page. Lists every pending duplicate_request with the
// two rows side-by-side, the flagging coord, the note, and Merge / Reject
// actions. Merge requires picking the winner via radio buttons.
async function renderDuplicateQueue(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(el("h2", { class: "section" }, t("dup.queue_title")));
  if (ME.role !== "hk_leader") {
    view.append(el("p", { class: "error" }, t("err.http_403")));
    return;
  }
  const loader = loadingLine(t("msg.loading"));
  view.append(loader);
  try {
    const { requests } = await api("/api/duplicate-requests?status=pending");
    if (myToken !== routeToken) return;
    loader.remove();
    if (!requests.length) {
      view.append(el("p", { class: "hint" }, t("dup.pending_none")));
      return;
    }
    const ul = el("ul", { class: "list", style: "gap:.6rem" });
    for (const rq of requests) {
      ul.append(el("li", {}, renderDupRequestCard(rq, () => renderRoute())));
    }
    view.append(ul);
  } catch (err) {
    loader.remove();
    view.append(el("p", { class: "error" }, err.message));
  }
}

function renderDupRequestCard(rq, onResolved) {
  const wrap = el("div", { style: "width:100%;display:flex;flex-direction:column;gap:.5rem" });
  // Header — who flagged, when, note
  const header = el("div", { class: "hint",
    style: "display:flex;gap:.5rem;flex-wrap:wrap;font-size:.8rem" });
  header.append(el("span", {}, t("dup.flagged_by") + ": "),
    el("strong", { style: "font-weight:600;color:var(--ink-2)" },
      rq.requested_by_name || rq.requested_by || "?"),
    el("span", {}, " · "),
    el("span", {}, (rq.created_at || "").slice(0, 10)),
  );
  wrap.append(header);
  if (rq.note) {
    wrap.append(el("p", { style: "margin:0;font-style:italic;color:var(--ink-2)" },
      "“" + rq.note + "”"));
  }

  // Side-by-side rows
  const pair = el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:.5rem" });
  const side = (label, name, sl, phone) => {
    const box = el("div", {
      style: "border:1px solid var(--line);border-radius:6px;padding:.5rem .7rem;background:var(--bg-elev)" });
    box.append(
      el("div", { class: "hint", style: "font-size:.75rem;text-transform:uppercase;letter-spacing:.05em" }, label),
      el("div", { style: "font-weight:600;color:var(--ink-2)" }, name || "(unknown)"),
      el("div", { class: "hint", style: "font-size:.8rem" },
        (sl ? "SL " + sl : "") + (sl && phone ? " · " : "") + (phone || "")),
    );
    return box;
  };
  pair.append(
    side(t("dup.flagged_side"), rq.flagged_name, rq.flagged_sl, rq.flagged_phone),
    side(t("dup.duplicate_of_side"), rq.dup_name, rq.dup_sl, rq.dup_phone),
  );
  wrap.append(pair);

  // Merge/reject controls
  const keepLabel = el("div", { style: "font-size:.85rem;font-weight:600;margin-top:.3rem" }, t("dup.keep_which"));
  const radios = el("div", { style: "display:flex;gap:.8rem;flex-wrap:wrap;font-size:.85rem" });
  const rName = "keep-" + rq.id;
  const rFlagged = el("input", { type: "radio", name: rName, value: rq.flagged_person_id });
  const rDup     = el("input", { type: "radio", name: rName, value: rq.duplicate_of_person_id || "" });
  rFlagged.checked = true;
  radios.append(
    el("label", { style: "display:inline-flex;gap:.3rem;align-items:center" }, rFlagged, t("dup.keep_flagged")),
    el("label", { style: "display:inline-flex;gap:.3rem;align-items:center" }, rDup,     t("dup.keep_duplicate_of")),
  );

  const note = el("input", {
    placeholder: t("dup.resolution_note_label"),
    style: "width:100%;padding:.4rem;border:1px solid var(--line);border-radius:6px;font-size:.85rem",
  });

  const actions = el("div", { style: "display:flex;gap:.4rem;flex-wrap:wrap;margin-top:.3rem" });
  const mergeBtn  = el("button", { class: "primary", type: "button" }, t("dup.merge_btn"));
  const rejectBtn = el("button", { class: "danger",  type: "button" }, t("dup.reject_btn"));
  const msg = el("span", { class: "hint", style: "margin-left:.4rem" });
  actions.append(mergeBtn, rejectBtn, msg);

  const resolve = async (action) => {
    const confirmKey = action === "merge" ? "dup.confirm_merge" : "dup.confirm_reject";
    if (!confirm(t(confirmKey))) return;
    const keepId = (radios.querySelector("input:checked") || {}).value || null;
    if (action === "merge" && !keepId) { msg.textContent = t("err.keep_person_id_required"); return; }
    mergeBtn.disabled = true; rejectBtn.disabled = true;
    msg.textContent = t("msg.loading");
    try {
      await api(`/api/duplicate-requests/${encodeURIComponent(rq.id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          action,
          keep_person_id: action === "merge" ? keepId : undefined,
          resolution_note: note.value.trim() || null,
        }),
      });
      msg.textContent = t(action === "merge" ? "dup.merged_toast" : "dup.rejected_toast");
      refreshDupPendingCount();
      setTimeout(() => { if (typeof onResolved === "function") onResolved(); }, 500);
    } catch (err) {
      msg.textContent = err.message;
      mergeBtn.disabled = false; rejectBtn.disabled = false;
    }
  };
  mergeBtn.addEventListener("click", () => resolve("merge"));
  rejectBtn.addEventListener("click", () => resolve("reject"));

  wrap.append(keepLabel, radios, note, actions);
  return wrap;
}

// -------------------------------------------------- group report ---
async function renderGroupReport(groupId) {
  const view = $("view");
  view.append(el("h2", { class: "section" }, t("hd.group_planning")));
  view.append(el("p", { class: "hint" }, t("help.group_planning")));
  if (!groupId) return view.append(el("p", { class: "hint" }, t("msg.open_group_id")));
  const num = (id, label) => formField(label, el("input", { id, type: "number", min: "0", value: "0" }));
  const card = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
  card.append(
    formField(t("gr.field_report_date"), el("input", { id: "gr-date", type: "date", value: new Date().toISOString().slice(0,10), required: true })),
    formField(t("gr.field_week_no"), el("input", { id: "gr-wk", type: "number" })),
    el("h3", { class: "section" }, t("hd.member_attendance")),
    el("div", { class: "grid3" },
      num("gr-avg", t("gr.field_avg_att")),
      num("gr-high", t("gr.field_highest")),
      num("gr-irr", t("gr.field_irregular")),
      num("gr-child", t("gr.field_children_avg")),
      num("gr-bvlc", t("gr.field_bvlc_avg")),
    ),
    el("h3", { class: "section" }, t("gr.section_b")),
    el("div", { class: "grid3" },
      num("gr-brah", t("gr.field_brah")),
      num("gr-hari", t("gr.field_hari")),
      num("gr-guru", t("gr.field_guru")),
      num("gr-sp", t("gr.field_sp")),
      num("gr-sadh", t("gr.field_sadh")),
      num("gr-sev", t("gr.field_sev")),
      num("gr-shr", t("gr.field_shr")),
      num("gr-pot", t("gr.field_pot")),
    ),
    el("h3", { class: "section" }, t("gr.section_c")),
    el("div", { class: "grid3" },
      num("gr-h2h", t("gr.field_h2h")),
      num("gr-nag", t("gr.field_nag")),
      num("gr-out", t("gr.field_out")),
    ),
    formField(t("gr.field_other_p"), el("input", { id: "gr-other-p" })),
    el("h3", { class: "section" }, t("gr.section_d")),
    el("div", { class: "grid3" },
      num("gr-eng", t("gr.field_eng")),
      num("gr-mon", t("gr.field_mon")),
      num("gr-amt", t("gr.field_amt")),
      num("gr-life", t("gr.field_life")),
    ),
    formField(t("gr.field_svc_d"), el("input", { id: "gr-svc-d" })),
    formField(t("gr.field_oth_c"), el("input", { id: "gr-oth-c" })),
    el("p", { style: "margin-top:1rem" },
      el("button", { class: "primary", type: "submit" }, t("btn.save_report")),
      " ", el("span", { class: "hint", id: "gr-msg" })),
  );
  card.onsubmit = async (e) => {
    e.preventDefault();
    const body = {
      group_id: groupId,
      report_date: $("gr-date").value,
      week_number: +($("gr-wk").value || 0) || null,
      avg_attendance: +$("gr-avg").value, highest_attendance: +$("gr-high").value,
      irregular_members: +$("gr-irr").value, children_program_avg: +$("gr-child").value,
      bvlc_avg: +$("gr-bvlc").value,
      brahmana_initiated: +$("gr-brah").value, harinama_initiated: +$("gr-hari").value,
      guru_ashraya: +$("gr-guru").value, prabhupada_ashraya: +$("gr-sp").value,
      krishna_sadhaka: +$("gr-sadh").value, krishna_sevaka: +$("gr-sev").value,
      shraddhavan: +$("gr-shr").value, potential_leaders: +$("gr-pot").value,
      h2h_programs: +$("gr-h2h").value, nagara_sankirtans: +$("gr-nag").value,
      outreach_programs: +$("gr-out").value, other_preaching: $("gr-other-p").value,
      temple_services_engaged: +$("gr-eng").value, monthly_contributors: +$("gr-mon").value,
      contribution_amount: +$("gr-amt").value, life_members: +$("gr-life").value,
      service_details: $("gr-svc-d").value, other_contribution: $("gr-oth-c").value,
    };
    try {
      await api("/api/group-reports", { method: "POST", body: JSON.stringify(body) });
      $("gr-msg").textContent = t("msg.saved_short");
    } catch (err) { $("gr-msg").textContent = err.message; }
  };
  view.append(card);
}

// ---------------------------------------------------- Leaderboard ---
// See "route token (BUG 1+2)" above — global guard against a stale
// in-flight fetch appending rows into a view that has since been
// re-rendered for a different tab. The sort toggle re-invokes this
// function directly (without going through renderRoute), so it does
// NOT bump routeToken — that's how intra-page re-renders still work.
async function renderLeaderboard(kind, rest) {
  const myToken = routeToken;
  const view = $("view");
  view.innerHTML = "";
  view.append(el("h2", { class: "section" }, t("hd.leaderboard")));

  // Route shape: #/leaderboard/<kind>[/leaders]
  //   kind = "daily" | "overall"
  //   suffix "/leaders" flips to the NJY-Leader board
  // Router passes `kind` as the entire arg after "leaderboard/", which
  // can be "daily/leaders" — split it here so both halves work.
  let [actualKind, ...suffixParts] = String(kind || "daily").split("/");
  let suffix = suffixParts.join("/") || (rest || "");
  // BUG 4: normalize bookmark URLs that put "leaders" in front (or on
  // its own). #/leaderboard/leaders → land on daily/leaders (the
  // natural leaders board). #/leaderboard/leaders/daily and
  // #/leaderboard/leaders/overall → the same kind + leaders board.
  // Unknown kind → fall through to "daily". Prevents the old shape
  // fetching /api/leaderboard/leaders/leaders and hanging on 404.
  if (actualKind === "leaders") {
    const next = suffixParts[0];
    actualKind = (next === "daily" || next === "overall") ? next : "daily";
    suffix = "leaders";
  } else if (!["daily", "overall"].includes(actualKind)) {
    actualKind = "daily";
  }
  const canSeeLeadersBoard = ["hk_leader", "njy_leader"].includes(ME.role);
  const isLeadersBoard = suffix === "leaders" && canSeeLeadersBoard;

  const tabs = el("div", { class: "nav", style: "border:none" });
  // Local tab-anchor builder — renamed from `t` to avoid shadowing the
  // global i18n `t()` helper (which also lives in this function scope).
  const mkTabLink = (k, label, extra) => el("a", { class: (actualKind === k && !!extra === isLeadersBoard) ? "active" : "",
    href: `#/leaderboard/${k}${extra ? "/leaders" : ""}` }, label);
  tabs.append(
    mkTabLink("daily", t("lb.tab_coords_today")),
    mkTabLink("overall", t("lb.tab_coords_overall")),
  );
  if (canSeeLeadersBoard) {
    tabs.append(
      mkTabLink("daily", t("lb.tab_leaders_today"), "leaders"),
      mkTabLink("overall", t("lb.tab_leaders_overall"), "leaders"),
    );
  }
  tabs.append(el("a", { href: "#/points-rules", style: "margin-left:auto" }, t("lb.how_points_link")));
  view.append(tabs);

  const hint = isLeadersBoard
    ? (actualKind === "daily" ? t("lb.hint_leaders_today") : t("lb.hint_leaders_overall"))
    : (actualKind === "daily" ? t("lb.hint_coords_today") : t("lb.hint_coords_overall"));
  view.append(el("p", { class: "hint" }, hint));

  // Sort toggle — only on Leaders board. Persist choice in localStorage
  // so HK Leader's preference sticks across reloads.
  let sortMode = "total";
  if (isLeadersBoard) {
    try { sortMode = localStorage.getItem("njy-leaders-sort") || "total"; } catch {}
    const sortRow = el("div", { class: "row", style: "gap:.4rem;margin:.4rem 0" });
    const mkSortBtn = (mode, label) => {
      const btn = el("button", {
        class: sortMode === mode ? "pill on" : "pill",
        type: "button",
        style: "cursor:pointer",
      }, label);
      btn.addEventListener("click", () => {
        sortMode = mode;
        try { localStorage.setItem("njy-leaders-sort", mode); } catch {}
        renderLeaderboard(kind, rest);   // re-render with new sort
      });
      return btn;
    };
    sortRow.append(
      el("span", { class: "hint", style: "align-self:center" }, t("lb.sort_by")),
      mkSortBtn("total", t("lb.sort_total")),
      mkSortBtn("avg", t("lb.sort_avg")),
    );
    view.append(sortRow);
  }

  const loader = el("p", { class: "hint" }, t("msg.loading"));
  view.append(loader);

  const url = isLeadersBoard
    ? `/api/leaderboard/leaders/${actualKind}`
    : `/api/leaderboard/${actualKind}`;

  try {
    const { rows: rawRows } = await api(url);
    if (myToken !== routeToken) return;
    loader.remove();

    // Re-sort leaders board client-side per user's chosen sort mode.
    let rows = rawRows;
    if (isLeadersBoard && sortMode === "avg") {
      rows = [...rawRows].sort((a, b) => (b.pts_per_coord || 0) - (a.pts_per_coord || 0));
    }

    // HK's own summary row on top of the LEADERS board — sum-of-all so
    // HK Leader sees the whole-org total in one line. Also shows the
    // whole-org per-coord average when prorated sort is active.
    if (isLeadersBoard && ME.role === "hk_leader" && rows.length) {
      const orgTotal = rows.reduce((s, r) => s + (r.pts || 0), 0);
      const orgCoords = rows.reduce((s, r) => {
        const c = (r.breakdown || []).find(b => b.k === "coords_in_team");
        return s + (c ? c.n : 0);
      }, 0);
      const orgAvg = orgCoords ? Math.round(orgTotal / orgCoords) : 0;
      const summary = el("div", { class: "card", style: "margin-bottom:.7rem;background:linear-gradient(180deg,var(--tint-responded),var(--tint-followed));border-color:var(--mark-responded)" },
        el("div", { class: "spread" },
          el("div", {}, el("strong", {}, t("hd.hk_whole_org")),
            el("div", { class: "hint" }, `${rows.length} ${t("lb.leaders_summary_prefix")} · ${orgCoords} ${t("lb.leaders_summary_coords")}`)),
          el("span", { class: "score" }, sortMode === "avg" ? `${orgAvg}${t("lb.suffix_avg")}` : `${orgTotal}${t("lb.suffix_pts")}`),
        ),
      );
      view.append(summary);
    }

    if (!rows.length) {
      return view.append(el("p", { class: "hint" }, isLeadersBoard ? t("msg.no_leaders_yet") : t("msg.no_coords_yet")));
    }
    const ul = el("ul", { class: "list" });
    const medals = ["🥇", "🥈", "🥉"];
    rows.forEach((r, i) => {
      const label = medals[i] || `#${i + 1}`;
      const breakdownText = (r.breakdown || [])
        .filter(b => b.pts !== 0 || b.n != null)
        .map(b => b.n != null && b.pts === 0 ? `${prettyPointKind(b.k)}: ${b.n}` : `${prettyPointKind(b.k)}: ${b.pts}`)
        .join(" · ");
      // Coord board keeps the "open profile" link. Leaders board goes to
      // that leader's drill-in page instead of profile (leaders don't
      // have a personal coord-style profile page).
      const openHref = isLeadersBoard
        ? `#/leader/${r.user_id}`
        : `#/profile/${r.user_id}`;
      // Leaders board: score column shows the composite 3-bucket score
      // used for ranking. Old "raw pts" available via `raw_team_pts`
      // when we want to expose it.
      const scoreText = (isLeadersBoard && sortMode === "avg")
        ? `${r.pts_per_coord || 0}${t("lb.score_avg_prefix")}${r.total_score || r.pts}${t("lb.score_suffix_score")}`
        : (isLeadersBoard ? `${r.total_score || r.pts}${t("lb.score_suffix_score")}` : `${r.pts}${t("lb.score_suffix_pts")}`);

      // Build the 3-bucket mini bars for the leaders board only. Each
      // bar is a .pbar with --pct set from the *_bar (0-100 normalised)
      // fields the server computed, and a short caption naming the
      // bucket + raw value so the leader can read the tradeoff at a
      // glance. Tap the row header to expand the breakdown.
      let bucketBlock = null;
      if (isLeadersBoard && (r.total_score != null || r.team_performance != null)) {
        const barRow = (label, raw, pctBar, suffix) => el("div", { class: "leader-bucket" },
          el("div", { class: "leader-bucket-hd" },
            el("span", { class: "hint" }, label),
            el("span", { class: "hint", style: "font-family:var(--font-mono)" }, `${raw}${suffix || ""}`)),
          el("div", { class: "pbar", style: `--pct:${Math.max(0, Math.min(100, pctBar || 0))}%` }),
        );
        bucketBlock = el("div", { class: "leader-buckets", style: "margin-top:.4rem" },
          barRow(t("lb.bucket_team_perf"), r.team_performance || 0, r.team_performance_bar || 0, t("lb.suffix_avg")),
          barRow(t("lb.bucket_team_cov"),   r.team_coverage    || 0, r.team_coverage_bar    || 0, t("lb.pct")),
          barRow(t("lb.bucket_leader_touch"), r.leader_touch   || 0, r.leader_touch_bar     || 0, t("lb.suffix_pts")),
        );
      }

      const li = el("li", {},
        el("div", { style: "flex:1;min-width:0" },
          el("strong", {}, `${label}  ${r.name}`),
          el("div", { class: "hint", style: "margin-top:.15rem" }, breakdownText || "-"),
          bucketBlock,
        ),
        el("span", { class: "score" }, scoreText),
        r.user_id === ME.id
          ? el("a", { class: "pill on", href: openHref, style: "text-decoration:none" }, t("lb.you_open"))
          : el("a", { class: "btn", href: openHref }, t("btn.open")),
      );
      ul.append(li);
    });
    view.append(ul);
  } catch (err) {
    if (myToken !== routeToken) return;
    loader.remove();
    if (err.status === 403) {
      view.append(el("p", { class: "hint" }, t("msg.leaders_lb_restricted")));
    } else {
      view.append(el("p", { class: "error" }, err.message));
    }
  }
}

// Turn the internal point-kind slugs into short human labels.
function prettyPointKind(k) {
  const key = "pk." + k;
  const translated = t(key);
  return translated !== key ? translated : k.replace(/_/g, " ");
}

// ---------------------------------------------------- Profile ---
// A coord's own "how am I doing" page. LeetCode-style transaction view
// showing every point-earning bucket with its count and total.
async function renderProfile(userId) {
  const myToken = routeToken;  // BUG 1+2
  const view = $("view");
  const target = userId || ME.id;
  view.append(el("h2", { class: "section" }, t("hd.profile")));
  const loader = el("p", { class: "hint" }, t("msg.loading"));
  view.append(loader);
  try {
    // BUG 6: use allSettled so a 403 on either leaderboard (e.g. member
    // role gated out) doesn't nuke the whole profile page. Treat any
    // rejected/malformed board as an empty { rows: [] } and show the
    // rest of the profile.
    const [dailySettled, overallSettled] = await Promise.allSettled([
      api("/api/leaderboard/daily"),
      api("/api/leaderboard/overall"),
    ]);
    if (myToken !== routeToken) return;
    const dailyRes = (dailySettled.status === "fulfilled" && dailySettled.value && Array.isArray(dailySettled.value.rows))
      ? dailySettled.value : { rows: [] };
    const overallRes = (overallSettled.status === "fulfilled" && overallSettled.value && Array.isArray(overallSettled.value.rows))
      ? overallSettled.value : { rows: [] };
    const boardsUnavailable = dailySettled.status !== "fulfilled" && overallSettled.status !== "fulfilled";
    loader.remove();
    const daily = dailyRes.rows.find(r => r.user_id === target);
    const overall = overallRes.rows.find(r => r.user_id === target);
    const name = daily?.name || overall?.name || ME.display_name || t("team.coordinator_fallback");
    const dailyRankIdx = dailyRes.rows.findIndex(r => r.user_id === target);
    const overallRankIdx = overallRes.rows.findIndex(r => r.user_id === target);
    const dailyRank = dailyRankIdx >= 0 ? dailyRankIdx + 1 : 0;
    const overallRank = overallRankIdx >= 0 ? overallRankIdx + 1 : 0;
    if (boardsUnavailable) {
      view.append(el("p", { class: "hint" }, t("lb.leaders_unavailable")));
    }

    view.append(el("div", { class: "spread" },
      el("h3", { class: "section", style: "margin:0" }, name),
      el("a", { class: "btn", href: "#/leaderboard/overall" }, t("lb.back_to_lb")),
    ));

    // Edit-profile card — only when viewing YOUR OWN profile and your
    // role is coord/leader/hk. Password stays in Settings; role /
    // manager / gender are HK-only concerns and not exposed here.
    if (!userId && ["njy_coordinator", "njy_leader", "hk_leader"].includes(ME.role)) {
      view.append(buildEditProfileCard());
    }

    // Show the coord's own NJY Leader so they know who to escalate to.
    // Only meaningful when viewing your OWN profile (userId undefined).
    if (!userId && ME.manager_display_name) {
      view.append(el("p", { class: "hint", style: "margin:.2rem 0 .8rem" },
        t("hd.your_leader_prefix") + " ", el("strong", {}, ME.manager_display_name),
      ));
    }

    // KPI strip
    const kpis = el("div", { class: "tally" });
    kpis.append(
      el("div", { class: "cell" },
        el("div", { class: "n" }, String(daily?.pts || 0)),
        el("div", { class: "k" }, t("lb.kpi_today_pts"))),
      el("div", { class: "cell" },
        el("div", { class: "n" }, String(overall?.pts || 0)),
        el("div", { class: "k" }, t("lb.kpi_overall_pts"))),
      el("div", { class: "cell" },
        el("div", { class: "n" }, dailyRank ? `#${dailyRank}` : "-"),
        el("div", { class: "k" }, t("lb.kpi_rank_today"))),
      el("div", { class: "cell" },
        el("div", { class: "n" }, overallRank ? `#${overallRank}` : "-"),
        el("div", { class: "k" }, t("lb.kpi_rank_overall"))),
    );
    view.append(kpis);

    // Two breakdown lists, side by side on desktop / stacked on phone.
    const grid = el("div", { class: "grid2", style: "margin-top:1rem" });
    grid.append(pointsBreakdownCard(t("lb.today_col"), daily?.breakdown));
    grid.append(pointsBreakdownCard(t("lb.overall_col"), overall?.breakdown));
    view.append(grid);

    view.append(el("p", { style: "margin-top:1rem" },
      el("a", { class: "btn", href: "#/points-rules" }, t("lb.see_full_rules")),
    ));
  } catch (err) {
    loader.remove();
    view.append(el("p", { class: "error" }, err.message));
  }
}

// ---------------- Self-profile edit ---------------------------------
// Rendered at the top of #/profile for coord + leader + hk (own view).
// Editable: display_name, username (live availability), phone, pincode
// (pincode hidden for HK to keep the field-set aligned with what's
// actually stored on that role). Password lives in Settings. Backend
// enforces uniqueness on username-change and returns username_changed
// so we can toast a reminder to sign back in with the new name.
function buildEditProfileCard() {
  const card = el("div", { class: "card", style: "margin:.4rem 0 .8rem" });
  card.append(el("h3", { class: "section", style: "margin-top:0" },
    t("profile.edit_hd")));

  const displayI = el("input", { autocomplete: "off", value: ME.display_name || "" });
  const usernameI = el("input", {
    autocomplete: "off", autocapitalize: "none", value: ME.username || "",
  });
  const usernameFlag = el("span", { class: "hint", style: "margin-left:.4rem" }, "");
  const phoneI = el("input", {
    inputmode: "tel", placeholder: "+91…", value: ME.phone || "",
  });
  const showPincode = ["njy_coordinator", "njy_leader"].includes(ME.role);
  const pincodeI = el("input", {
    inputmode: "numeric", maxlength: "6", autocomplete: "postal-code",
    placeholder: "560001", value: ME.pincode || "",
  });
  const msg = el("span", { class: "hint", style: "margin-left:.5rem" }, "");
  const saveBtn = el("button", { class: "primary", type: "submit" }, t("btn.save"));

  const form = el("form", { method: "post", action: "javascript:void(0)" });
  form.append(
    el("div", {}, el("label", {}, t("field.display_name")), displayI),
    el("div", {}, el("label", {}, t("field.username")),
      el("div", { style: "display:flex;align-items:center" }, usernameI, usernameFlag)),
    el("div", {}, el("label", {}, t("field.phone")), phoneI),
  );
  if (showPincode) {
    form.append(el("div", {}, el("label", {}, t("field.pincode")), pincodeI,
      el("p", { class: "hint",
        style: "margin:.15rem 0 .3rem;font-size:.78rem;color:var(--ink-2)",
      }, t("field.pincode_hint"))));
  }
  form.append(el("p", { style: "margin-top:.6rem" }, saveBtn, msg));
  card.append(form);

  // Live username-availability probe, only when the value has changed
  // from ME.username (unchanged never queries — reduces noise + spares
  // the endpoint). Shares the leader-scoped coord-username-check
  // endpoint, gated in the backend to leader/HK; for a coord the
  // request 403s and we silently skip the check (server still enforces
  // collision on POST, so this UX aid degrades safely).
  let checkTimer = null;
  usernameI.addEventListener("input", () => {
    const v = usernameI.value.trim();
    usernameFlag.textContent = "";
    usernameFlag.style.color = "";
    clearTimeout(checkTimer);
    if (v.length < 3 || v === (ME.username || "")) return;
    checkTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/leader/coord-username-check?u=${encodeURIComponent(v)}`);
        if (r.available) {
          usernameFlag.textContent = "✓ " + t("members.uname_ok");
          usernameFlag.style.color = "var(--mark-followed)";
        } else {
          usernameFlag.textContent = "✗ " + t("members.uname_taken");
          usernameFlag.style.color = "var(--mark-attention)";
        }
      } catch { /* silent — role may not have access to the probe */ }
    }, 250);
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    msg.textContent = "";
    const dn = displayI.value.trim();
    const un = usernameI.value.trim();
    const ph = phoneI.value.trim();
    const pc = pincodeI.value.trim();
    if (!dn) { msg.textContent = t("profile.edit_display_required"); return; }
    if (!un) { msg.textContent = t("profile.edit_username_required"); return; }
    if (pc && showPincode && !/^\d{6}$/.test(pc)) {
      msg.textContent = t("field.pincode_invalid"); return;
    }
    const body = { display_name: dn, username: un, phone: ph };
    if (showPincode) body.pincode = pc || null;
    saveBtn.disabled = true;
    try {
      const r = await api("/api/me", {
        method: "POST", body: JSON.stringify(body),
      });
      // Update local ME so the rest of the app reflects the change
      // without a full reload.
      if (r.user) {
        ME.display_name = r.user.display_name;
        ME.username = r.user.username;
        ME.phone = r.user.phone;
        if ("pincode" in r.user) ME.pincode = r.user.pincode;
      }
      showProfileSavedToast(!!r.username_changed);
      msg.textContent = t("profile.edit_saved");
    } catch (err) {
      msg.textContent = err.message;
    } finally {
      saveBtn.disabled = false;
    }
  };
  return card;
}

function showProfileSavedToast(usernameChanged) {
  if (_njyToastTimer) { clearTimeout(_njyToastTimer); _njyToastTimer = null; }
  if (_njyToastEl && _njyToastEl.isConnected) _njyToastEl.remove();
  const text = usernameChanged
    ? t("profile.edit_toast_username")
    : t("profile.edit_toast");
  const box = el("div", {
    role: "status",
    style: [
      "position:fixed", "left:50%", "bottom:24px",
      "transform:translateX(-50%)",
      "background:#1f2937", "color:#fff",
      "padding:.7rem 1rem", "border-radius:8px",
      "box-shadow:0 4px 14px rgba(0,0,0,.25)",
      "z-index:9999", "font-size:.9rem",
      "max-width:min(92vw,420px)", "text-align:center",
    ].join(";"),
  }, text);
  document.body.append(box);
  _njyToastEl = box;
  _njyToastTimer = setTimeout(() => {
    _njyToastTimer = null;
    if (_njyToastEl === box) _njyToastEl = null;
    box.remove();
  }, 6000);
}

function pointsBreakdownCard(title, breakdown) {
  const card = el("div", { class: "card", style: "margin:0" });
  card.append(el("h3", { class: "section", style: "margin-top:0" }, title));
  if (!breakdown || !breakdown.length) {
    card.append(el("p", { class: "hint" }, t("hd.no_points_scope")));
    return card;
  }
  const total = breakdown.reduce((s, b) => s + (b.pts || 0), 0);
  const ul = el("ul", { class: "list" });
  for (const b of breakdown) {
    ul.append(el("li", {},
      el("div", {}, el("strong", {}, prettyPointKind(b.k)),
        el("div", { class: "hint" }, b.n ? `${b.n} ${t("lb.action_suffix")}` : t("lb.milestone"))),
      el("span", { class: "score" }, `+${b.pts}`),
      el("span", {}),
    ));
  }
  card.append(ul);
  card.append(el("p", { style: "text-align:right;font-family:var(--font-mono);color:var(--peacock-deep);margin-top:.4rem" },
    t("lb.total") + " ", el("strong", {}, `${total} pts`)));
  return card;
}

// ---------------------------------------------------- Points rules ---
// A static reference — the full "how points are earned" table so
// coordinators know what to do to climb.
function renderPointsRules(view) {
  view.append(el("h2", { class: "section" }, t("hd.how_points")));
  view.append(el("p", { class: "hint" }, t("help.how_points")));

  const daily = el("div", { class: "card" });
  daily.append(
    el("h3", { class: "section", style: "margin-top:0" }, t("rules.daily_hd")),
    el("ul", { class: "list" },
      pointRow(t("rules.daily_row1"), "+5"),
      pointRow(t("rules.daily_row2"), "+10"),
      pointRow(t("rules.daily_row3"), "+20"),
      pointRow(t("rules.daily_row4"), "+50"),
      pointRow(t("rules.daily_row5"), "+50"),
      pointRow(t("rules.daily_row6"), "+50"),
      pointRow(t("rules.daily_row7"), "+100"),
    ),
  );
  view.append(daily);

  const overall = el("div", { class: "card" });
  overall.append(
    el("h3", { class: "section", style: "margin-top:0" }, t("rules.overall_hd")),
    el("p", { class: "hint" }, t("rules.overall_intro")),
    // Janmashtami-day-based point rules (Janmashtami Entries + Daily-Chanter
    // Commits) were removed after the 2026 campaign ended. Historical points
    // already earned remain in users' totals; new awards no longer fire (see
    // lib/leaderboard.js). Milestones below are ongoing and stay in effect.
    el("h3", { class: "section" }, t("rules.milestones_hd")),
    el("ul", { class: "list" },
      pointRow(t("rules.milestones_row1"), "+200"),
      pointRow(t("rules.milestones_row2"), "+300"),
      pointRow(t("rules.milestones_row3"), "+400"),
      pointRow(t("rules.milestones_row4"), "+500"),
    ),
  );
  view.append(overall);

  // NJY Leader leaderboard: 3-bucket prorated model. Per Plan 4, the
  // leader-side calculation is hidden from Coordinators; only NJY
  // Leaders and HK Leader see it here.
  const canSeeLeaderCalc = ME.role === "hk_leader" || ME.role === "njy_leader";
  if (canSeeLeaderCalc) {
    const leader = el("div", { class: "card" });
    leader.append(
      el("h3", { class: "section", style: "margin-top:0" }, t("rules.leader_hd")),
      el("p", { class: "hint" }, t("rules.leader_intro")),
      el("h3", { class: "section" }, t("rules.leader_perf_hd")),
      el("p", { class: "hint" }, t("rules.leader_perf_desc")),
      el("h3", { class: "section" }, t("rules.leader_cov_hd")),
      el("p", { class: "hint" }, t("rules.leader_cov_desc")),
      el("h3", { class: "section" }, t("rules.leader_touch_hd")),
      el("p", { class: "hint" }, t("rules.leader_touch_desc")),
      el("ul", { class: "list" },
        pointRow(t("rules.leader_row1"), "+5"),
        pointRow(t("rules.leader_row2"), "+5"),
        pointRow(t("rules.leader_row4"), "+10"),
        pointRow(t("rules.leader_row5"), "+5"),
      ),
    );
    view.append(leader);
  }

  view.append(el("p", { style: "margin-top:1rem" },
    el("a", { class: "btn", href: "#/leaderboard/overall" }, t("lb.back_to_lb")),
  ));
}

function pointRow(label, points) {
  return el("li", {},
    el("div", {}, el("strong", {}, label)),
    el("span", { class: "score" }, points),
    el("span", {}),
  );
}

// ---------------------------------------------------- Janmashtami ---
// Two rapid-entry paths on Janmashtami day:
//   A. Single-row quick-add form (name / mobile / pincode) — one save
//      picks the next sl_no from the caller's assigned range.
//   B. Paste-many textarea — one row per line, tab OR comma separated.
//      Excel copies as tab-separated by default, so paste-from-Excel
//      just works. Google Sheets / CSV also work.
async function renderJanmashtami(view) {
  const myToken = routeToken;  // BUG 1+2
  if (!can("janmashtami_view_page")) {
    view.append(el("h2", { class: "section" }, t("hd.janmashtami_rapid")));
    view.append(el("p", { class: "hint" }, t("msg.no_access_janmashtami")));
    return;
  }
  view.append(el("h2", { class: "section" }, t("hd.janmashtami_rapid")));

  const progressWrap = el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:1rem" });
  if (can("janmashtami_progress_counters")) view.append(progressWrap);

  async function refreshProgress() {
    if (!can("janmashtami_progress_counters")) return;
    try {
      const p = await api("/api/me/janmashtami-progress");
      if (myToken !== routeToken) return;
      progressWrap.innerHTML = "";
      const b1 = el("span", { class: "tier-badge" },
        el("span", { class: "num" }, String(p.entries_today)),
        p.next_entry_tier ? `${t("jm.entries_next_prefix")}${p.next_entry_tier}` : t("jm.entries_suffix"),
      );
      const b2 = el("span", { class: "tier-badge warm" },
        el("span", { class: "num" }, String(p.committed_today)),
        p.next_commit_tier ? `${t("jm.commits_next_prefix")}${p.next_commit_tier}` : t("jm.commits_suffix"),
      );
      progressWrap.append(b1, b2);
    } catch (err) { /* silent */ }
  }
  await refreshProgress();

  // --- Path A: single-row rapid form (gated: janmashtami_quick_add)
  const cardA = el("div", { class: "card" });
  cardA.append(el("h3", { class: "section" }, t("hd.quick_add")));
  cardA.append(el("p", { class: "hint" }, t("help.quick_add")));
  const form = el("form", { class: "rapid-form", method: "post", action: "javascript:void(0)" });
  const couponI = el("input", { placeholder: t("jm.ph_coupon"), required: true, inputmode: "numeric", autocomplete: "off" });
  const nameI = el("input", { placeholder: t("field.name"), required: true, autocapitalize: "words" });
  const mobI  = el("input", { placeholder: t("field.mobile"), required: true, inputmode: "tel" });
  const pinI  = el("input", { placeholder: t("field.pincode"), inputmode: "numeric" });
  const submitBtn = el("button", { class: "primary", type: "submit" }, t("btn.add"));
  form.append(
    el("div", {}, el("label", {}, t("field.coupon")), couponI),
    el("div", {}, el("label", {}, t("field.name")), nameI),
    el("div", {}, el("label", {}, t("field.mobile")), mobI),
    el("div", {}, el("label", {}, t("field.pincode")), pinI),
    el("div", {}, el("label", { style: "visibility:hidden" }, "."), submitBtn),
  );
  const feedback = el("p", { class: "hint", style: "margin-top:.6rem" }, "");
  // "Recent entries" moves to its own card at the bottom of the page;
  // the quick-add card just prepends new rows into that far-down list.
  const recentUl = el("ul", { class: "list", id: "jm-recent" });
  cardA.append(form, feedback);
  form.onsubmit = async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    feedback.textContent = t("jm.saving");
    try {
      const r = await api("/api/janmashtami/entry", { method: "POST", body: JSON.stringify({
        coupon_no: couponI.value, name: nameI.value, mobile: mobI.value, pincode: pinI.value,
      }) });
      const p = r.person;
      feedback.textContent = `${t("jm.saved_prefix")}${p.sl_no}${t("jm.saved_infix")}${p.legal_name}`;
      recentUl.prepend(el("li", {},
        el("div", {}, el("strong", {}, p.legal_name),
          el("div", { class: "hint" }, `coupon ${p.sl_no} · ${p.phone}${p.pincode ? " · " + p.pincode : ""}`)),
        el("span", {}), el("span", {}),
      ));
      couponI.value = ""; nameI.value = ""; mobI.value = ""; pinI.value = "";
      couponI.focus();
      refreshProgress();
    } catch (err) {
      feedback.textContent = t("jm.error_prefix") + (err.body?.hint || err.message);
    } finally {
      submitBtn.disabled = false;
    }
  };
  if (can("janmashtami_quick_add")) view.append(cardA);

  // --- Path B: Excel/CSV file upload with preview (gated: janmashtami_upload_csv)
  const cardB = el("div", { class: "card" });
  cardB.append(el("h3", { class: "section" }, t("hd.upload_excel")));
  cardB.append(excelUploadWidget({
    templateGateKey: "janmashtami_download_template",
    commitGateKey:   "janmashtami_commit_import",
    helperText: t("jm.upload_help"),
    mapRow: (row) => ({
      coupon_no: String(row.coupon_no || row.coupon || row.Coupon || row["Coupon #"] || row["Coupon No"] || "").trim(),
      name: String(row.name || row.Name || row.NAME || "").trim(),
      mobile: String(row.mobile || row.Mobile || row.MOBILE || row.phone || "").trim(),
      pincode: String(row.pincode || row.Pincode || row.PINCODE || row.pin || "").trim(),
      is_daily: String(row.is_daily || row["Daily?"] || row.daily || "").trim().toLowerCase(),
    }),
    onCommit: async (rows) => {
      const r = await api("/api/janmashtami/bulk", { method: "POST", body: JSON.stringify({ rows }) });
      refreshProgress();
      loadTodayEntries();
      return r;
    },
  }));
  if (can("janmashtami_upload_csv")) view.append(cardB);

  // --- Path C: paste-many (kept as a fallback) — gated: janmashtami_paste_rows
  const cardC = el("div", { class: "card" });
  cardC.append(
    el("h3", { class: "section" }, t("hd.paste_excel")),
    el("p", { class: "hint" }, t("help.paste_excel")),
    formField(t("hd.paste_excel"), el("textarea", { id: "jm-paste", rows: "6",
      placeholder: t("jm.ph_paste") })),
    el("p", {},
      el("button", { class: "primary", type: "button", id: "jm-paste-go" }, t("btn.import")),
      " ", el("span", { class: "hint", id: "jm-paste-msg" }),
    ),
  );
  if (can("janmashtami_paste_rows")) view.append(cardC);

  // --- Path D: today's entries (gated: janmashtami_today_entries)
  const cardD = el("div", { class: "card" });
  cardD.append(el("h3", { class: "section" }, t("hd.today_entries")));
  cardD.append(el("p", { class: "hint" }, t("help.today_entries")));
  cardD.append(recentUl);
  if (can("janmashtami_today_entries")) view.append(cardD);

  const jmPasteGoEl = $("jm-paste-go");
  if (jmPasteGoEl) jmPasteGoEl.addEventListener("click", async () => {
    const raw = $("jm-paste").value.trim();
    if (!raw) return;
    // Column order for paste: coupon_no, name, mobile, pincode, is_daily
    const rows = raw.split(/\r?\n/).map(line => {
      const parts = line.split(/\t|,/);
      return {
        coupon_no: (parts[0] || "").trim(),
        name:      (parts[1] || "").trim(),
        mobile:    (parts[2] || "").trim(),
        pincode:   (parts[3] || "").trim(),
        is_daily:  (parts[4] || "").trim().toLowerCase(),
      };
    }).filter(r => r.name && r.mobile);
    try {
      const r = await api("/api/janmashtami/bulk", { method: "POST", body: JSON.stringify({ rows }) });
      $("jm-paste-msg").textContent = `${t("jm.imported_prefix")}${r.created}${t("jm.imported_infix")}${r.errors.length}${t("jm.imported_suffix")}`;
      $("jm-paste").value = "";
      refreshProgress();
      loadTodayEntries();
    } catch (err) {
      $("jm-paste-msg").textContent = err.message;
    }
  });

  // Fetch today's Janmashtami entries in insertion order (newest first)
  // via the dedicated endpoint. Rendered in the bottom card so the
  // coord can double-check their most recent adds.
  async function loadTodayEntries() {
    try {
      const { entries } = await api("/api/me/janmashtami-entries");
      if (myToken !== routeToken) return;
      recentUl.innerHTML = "";
      if (!entries.length) {
        recentUl.append(el("li", {}, el("span", { class: "hint" }, t("msg.no_entries_today"))));
        return;
      }
      entries.forEach(r => {
        const meta = [
          r.sl_no ? `sl ${r.sl_no}` : null,
          r.phone,
          r.pincode || null,
        ].filter(Boolean).join(" · ");
        recentUl.append(el("li", {},
          el("div", {}, el("strong", {}, r.name),
            el("div", { class: "hint" }, meta)),
          el("span", {}), el("span", {}),
        ));
      });
    } catch (_) { /* silent */ }
  }
  loadTodayEntries();
}

// ------------------------------------------------------ settings ---
// A coordinator's own preferences. Right now: the two WhatsApp
// templates that fill the pre-populated message text on the roll's
// WhatsApp buttons. Anyone with a roll gets this screen.
async function renderSettings(view) {
  view.append(el("h2", { class: "section" }, t("hd.settings_title")));
  view.append(helpBanner(t("help.settings")));

  // --- Change my password (gated: settings_change_password)
  const pwCard = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
  pwCard.append(el("h3", { class: "section", style: "margin-top:0" }, t("hd.change_pw")));
  pwCard.append(el("p", { class: "hint" }, t("help.change_pw")));
  const pwCur = passwordFieldWithEye("cur-pw", t("field.current_pw"));
  const pwNew = passwordFieldWithEye("new-pw", t("field.new_pw"));
  pwCard.append(pwCur.wrap, pwNew.wrap);
  const pwSave = el("button", { class: "primary", type: "submit" }, t("btn.save"));
  const pwMsg = el("span", { class: "hint", id: "pw-msg", style: "margin-left:.5rem" });
  pwCard.append(el("p", { style: "margin-top:.6rem" }, pwSave, pwMsg));
  pwCard.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/api/me/password", { method: "POST", body: JSON.stringify({
        current_password: pwCur.input.value, new_password: pwNew.input.value,
      }) });
      pwMsg.textContent = t("msg.pw_updated");
      pwCur.input.value = ""; pwNew.input.value = "";
    } catch (err) {
      pwMsg.textContent = err.body?.error === "wrong_current_password"
        ? t("msg.pw_wrong_current")
        : (err.message || t("st.could_not_update"));
    }
  };
  if (can("settings_change_password")) view.append(pwCard);

  // --- Language picker (gated: header_language_toggle)
  const langCard = el("div", { class: "card" });
  langCard.append(el("h3", { class: "section", style: "margin-top:0" }, t("hd.language")));
  langCard.append(el("p", { class: "hint" }, t("msg.pick_lang")));
  const cur = getLang();
  const langBtns = el("div", { style: "display:flex;gap:.5rem;flex-wrap:wrap" });
  for (const l of window.LANGS) {
    const active = l.code === cur;
    const btn = el("button", { class: active ? "primary" : "ghost", type: "button" }, l.label);
    btn.addEventListener("click", () => { if (!active) setLang(l.code); });
    langBtns.append(btn);
  }
  langCard.append(langBtns);
  if (can("header_language_toggle")) view.append(langCard);

  // WhatsApp template editor moved to the My Sangha page (change 2/3 —
  // one message per coord, edited inline right next to the Broadcast
  // CTA). Leave a small notice so anyone still hunting for it here
  // knows where it went.
  if (can("settings_wa_templates")) {
    view.append(el("div", { class: "card" },
      el("h3", { class: "section", style: "margin-top:0" }, t("hd.wa_template_moved")),
      el("p", { class: "hint", style: "margin:.3rem 0 0" }, t("st.wa_template_moved_notice")),
    ));
  }
}

// ---------------------------------------------------------- admin ---
async function renderAdmin(tab) {
  const view = $("view");
  // Each sub-tab is individually gate-able. HK Leader always sees
  // everything (can() short-circuits). For any other role, only the
  // sub-tabs their gate allows show up here — and route access is
  // guarded below in case they hit the URL directly.
  const subGates = [
    { key: "gates",       gate: "admin_gates",           label: t("admin.tab_gates"),       render: renderAdminGates },
    { key: "users",       gate: "admin_users",           label: t("admin.tab_users"),       render: renderAdminUsers },
    { key: "users-bulk",  gate: "admin_users_bulk",      label: t("admin.tab_users_bulk"),  render: renderAdminUsersBulk },
    { key: "import",      gate: "admin_import_chanters", label: t("admin.tab_import"),      render: renderAdminImport },
    { key: "events",      gate: "admin_events",          label: t("admin.tab_events"),      render: renderAdminEvents },
  ];
  const visible = subGates.filter(s => can(s.gate));
  const target = subGates.find(s => s.key === tab) || subGates[0];
  // BUG 5: if the caller can't access ANY admin sub-tab (nor the target
  // sub-tab specifically), render ONLY the friendly access-denied
  // message. Do NOT paint the "Admin" h2 or the "HK Leader only" banner
  // first — that made non-HK users think they were allowed in and just
  // rendered "no access" as a footer.
  if (!visible.length || !can(target.gate)) {
    view.append(el("p", { class: "hint" }, t("msg.no_access_admin")));
    return;
  }
  view.append(el("h2", { class: "section" }, t("hd.admin")));
  view.append(helpBanner(t("admin.help_banner")));
  const tabs = el("div", { class: "nav", style: "border:none" });
  const mkTab = (key, label) => el("a", { class: tab === key ? "active" : "", href: `#/admin/${key}` }, label);
  for (const s of visible) tabs.append(mkTab(s.key, s.label));
  view.append(tabs);
  return target.render(view);
}

// Bulk-create coord/leader accounts from Excel or paste.
async function renderAdminUsersBulk(view) {
  view.append(el("h3", { class: "section" }, t("hd.admin_bulk_users")));
  view.append(helpBanner(t("help.admin_bulk_users")));

  // Path A — Excel upload
  const upload = el("div", { class: "card" });
  upload.append(el("h3", { class: "section", style: "margin-top:0" }, t("hd.upload_excel_csv")));
  upload.append(excelUploadWidget({
    helperText: t("admin.users_bulk_cols"),
    templateBuilder: downloadUsersTemplate,
    templateLabel: t("btn.download_users_template"),
    isValidRow: (r) => r.username && r.display_name,
    emptyMessage: t("xl.no_usable_users"),
    previewCols: [t("xl.col_username"), t("xl.col_display_name"), t("xl.col_role"), t("xl.col_phone"), t("xl.col_manager")],
    previewRow: (r) => [r.username, r.display_name, r.role, r.phone, r.manager_username],
    mapRow: (row) => ({
      username: String(row.username || row.Username || "").trim(),
      password: String(row.password || row.Password || "").trim(),
      display_name: String(row.display_name || row["Display name"] || row.name || row.Name || "").trim(),
      phone: String(row.phone || row.Phone || row.mobile || "").trim(),
      role: String(row.role || row.Role || "njy_coordinator").trim(),
      manager_username: String(row.manager_username || row["Manager username"] || row.manager || "").trim(),
    }),
    onCommit: async (rows) => {
      const r = await api("/api/admin/users/bulk", { method: "POST", body: JSON.stringify({ rows }) });
      return { created: r.created.length, errors: r.errors };
    },
  }));
  view.append(upload);

  // Path B — Paste
  const paste = el("div", { class: "card" });
  paste.append(
    el("h3", { class: "section", style: "margin-top:0" }, t("hd.paste_rows")),
    el("p", { class: "hint" }, t("help.admin_paste_users")),
    formField(t("hd.paste_rows"), el("textarea", { id: "ub-paste", rows: "8",
      placeholder: t("admin.users_bulk_paste_ph") })),
    el("p", {}, el("button", { class: "primary", type: "button", id: "ub-go" }, t("btn.import")),
      " ", el("span", { class: "hint", id: "ub-msg" })),
    el("pre", { id: "ub-out", style: "font-family:var(--font-mono);font-size:.75rem;color:var(--muted);white-space:pre-wrap" }),
  );
  view.append(paste);
  $("ub-go").addEventListener("click", async () => {
    const raw = $("ub-paste").value.trim();
    if (!raw) return;
    const rows = raw.split(/\r?\n/).map(line => {
      const parts = line.split(/\t|,/).map(s => s.trim());
      return {
        username: parts[0] || "",
        password: parts[1] || "",
        display_name: parts[2] || "",
        phone: parts[3] || "",
        role: parts[4] || "njy_coordinator",
        manager_username: parts[5] || "",
      };
    }).filter(r => r.username);
    try {
      const r = await api("/api/admin/users/bulk", { method: "POST", body: JSON.stringify({ rows }) });
      $("ub-msg").textContent = `${t("admin.record_created_prefix")}${r.created.length}${t("xl.errors_middle")}${r.errors.length}${t("xl.errors_suffix")}`;
      $("ub-out").textContent = JSON.stringify(r, null, 2);
    } catch (err) { $("ub-msg").textContent = err.message; }
  });
}

// Grouping map — every known gate_key -> tab section. Anything not
// listed here falls into "Other" so newly-added gates are still visible
// (and HK Leader can categorize later by editing this table).
const GATE_GROUPS = {
  "Header / Global": [
    "header_contact_leader_pill", "header_contact_hk_pill",
    "header_install_pwa", "header_language_toggle", "header_points_chip",
  ],
  "My Roll": [
    "coordinator_roll", "myroll_mark_chanted_today",
    "myroll_mark_chanted_past_date", "myroll_add_note",
    "myroll_change_status", "myroll_reassign_member",
    "myroll_manage_dropdown", "myroll_broadcast_button",
    "myroll_wa_group_button", "myroll_care_moments_panel",
    "myroll_history_strip",
  ],
  "Team (leader)": [
    "leader_dashboard", "team_view_coords_list", "team_drill_into_coord",
    "team_broadcast_to_coords", "team_wa_group_of_coords",
  ],
  "HK Dashboard": ["hk_dashboard", "hk_reassign_leader"],
  "Duties":  ["duties_view_list", "duties_mark_done", "duties_delete"],
  "Events":  ["event_attendance", "events_view_list", "events_edit", "events_delete"],
  "BV":      ["bv_structure_editor", "bv_add_group", "bv_delete_group", "bv_edit_group"],
  "Janmashtami": [
    "janmashtami_view_page", "janmashtami_quick_add",
    "janmashtami_upload_csv", "janmashtami_paste_rows",
    "janmashtami_download_template", "janmashtami_preview",
    "janmashtami_commit_import", "janmashtami_progress_counters",
    "janmashtami_today_entries",
  ],
  "Leaderboard": [
    "leaderboard_coord_daily", "leaderboard_coord_overall",
    "leaderboard_leaders_daily", "leaderboard_leaders_overall",
    "leaderboard_sort_toggle",
  ],
  "Settings": [
    "settings_change_password", "settings_wa_templates",
    "web_push", "settings_view_profile", "settings_wa_group_link",
  ],
  "Admin": [
    "feature_admin", "admin_gates", "admin_users", "admin_users_bulk",
    "admin_import_chanters", "admin_events", "admin_points_rules_edit",
    "admin_roles_manage", "bulk_import",
  ],
  "Sadhana": [
    "sadhana_chart", "sadhana_entry_submit",
    "sadhana_delete_entry", "sadhana_browse",
  ],
  "Cross-cutting": [
    "whatsapp_deeplink", "member_details_full", "group_planning_sheet",
    "action_timeline_duties",
  ],
};

async function renderAdminGates(view) {
  const myToken = routeToken;  // BUG 1+2
  const { gates } = await api("/api/me");
  if (myToken !== routeToken) return;

  const ROLES = [
    { key: "hk_leader",       label: t("admin.role_hk") },
    { key: "njy_leader",      label: t("admin.role_leader") },
    { key: "njy_coordinator", label: t("admin.role_coord") },
    { key: "servant_leader",  label: t("admin.role_sl") },
    { key: "circle_servant",  label: t("admin.role_cs") },
    { key: "sector_servant",  label: t("admin.role_ss") },
    { key: "manjari_servant_leader", label: t("admin.role_msl") },
    { key: "member",          label: t("admin.role_member") },
  ];

  // Working copy — user edits this, then hits Save on a section.
  const state = {};
  for (const [k, v] of Object.entries(gates)) state[k] = v.slice();
  const dirty = new Set();

  // Build reverse lookup: which section owns each key. Anything not in
  // GATE_GROUPS lands in "Other".
  const owner = {};
  for (const [section, keys] of Object.entries(GATE_GROUPS)) {
    for (const k of keys) owner[k] = section;
  }
  const sections = { ...Object.fromEntries(Object.keys(GATE_GROUPS).map(s => [s, []])), Other: [] };
  for (const k of Object.keys(gates)) {
    const s = owner[k] || "Other";
    sections[s].push(k);
  }

  view.append(el("h3", { class: "section" }, t("hd.feature_visibility")));
  view.append(el("p", { class: "hint" }, t("admin.gates_hint")));

  // Search box (filters section rows by key or description)
  const search = el("input", {
    placeholder: t("admin.gates_filter_ph"),
    style: "width:100%;padding:.5rem;border:1px solid var(--line);border-radius:6px;margin:.4rem 0 1rem",
    id: "gate-search",
  });
  view.append(search);

  // Global save-all button
  const globalSaveWrap = el("div", { style: "position:sticky;top:0;background:var(--bg);padding:.4rem 0;z-index:5;border-bottom:1px solid var(--line);margin-bottom:.6rem" });
  const globalSave = el("button", { class: "primary", type: "button" }, t("btn.save_all"));
  const globalMsg = el("span", { class: "hint", style: "margin-left:.6rem" });
  globalSaveWrap.append(globalSave, " ", globalMsg);
  view.append(globalSaveWrap);

  // Section titles are English keys in GATE_GROUPS (used as lookup
  // slugs); translate at render time via admin.gate_section.<key>.
  const sectionLabel = (title) => {
    const key = "admin.gate_section." + title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const v = t(key);
    return v !== key ? v : title;
  };
  const renderSection = (title, keys) => {
    if (!keys.length) return null;
    const card = el("div", { class: "card", "data-section": title });
    card.append(el("h3", { class: "section", style: "margin-top:0" }, sectionLabel(title),
      el("span", { class: "hint", style: "margin-left:.5rem;font-weight:400" }, `${keys.length}${keys.length === 1 ? t("admin.gate_count_suffix") : t("admin.gate_count_suffix_plural")}`)));

    for (const key of keys.sort()) {
      const rowEl = el("div", {
        class: "gate-row",
        "data-key": key,
        style: "display:grid;grid-template-columns:minmax(220px, 1fr) auto;gap:.5rem;align-items:center;padding:.45rem 0;border-bottom:1px solid var(--line)",
      });
      rowEl.append(el("div", {},
        el("strong", { style: "font-family:var(--font-mono);font-size:.85rem" }, key),
      ));
      const chips = el("div", { style: "display:flex;flex-wrap:wrap;gap:.3rem" });
      for (const r of ROLES) {
        const on = () => state[key].includes(r.key);
        const chip = el("label", {
          style: "display:inline-flex;align-items:center;gap:.25rem;padding:.2rem .5rem;border:1px solid var(--line);border-radius:6px;font-size:.78rem;cursor:pointer;user-select:none",
          title: r.key,
        });
        const cb = el("input", { type: "checkbox" });
        cb.checked = on();
        cb.addEventListener("change", () => {
          if (cb.checked) {
            if (!state[key].includes(r.key)) state[key].push(r.key);
          } else {
            state[key] = state[key].filter(x => x !== r.key);
          }
          dirty.add(key);
          rowEl.style.background = "var(--tint-followed, #fff8e1)";
          saveBtn.disabled = false;
          globalMsg.textContent = `${dirty.size}${dirty.size === 1 ? t("admin.unsaved_singular") : t("admin.unsaved_plural")}`;
        });
        chip.append(cb, el("span", {}, r.label));
        chips.append(chip);
      }
      rowEl.append(chips);
      card.append(rowEl);
    }

    const saveRow = el("div", { style: "margin-top:.6rem;display:flex;gap:.5rem;align-items:center" });
    const saveBtn = el("button", { class: "primary", type: "button", disabled: true }, t("btn.save_section"));
    const msg = el("span", { class: "hint" });
    saveBtn.addEventListener("click", async () => {
      const changes = keys
        .filter(k => dirty.has(k))
        .map(k => ({ feature_key: k, allowed_roles: state[k] }));
      if (!changes.length) return;
      saveBtn.disabled = true; msg.textContent = t("admin.saving");
      try {
        await api("/api/admin/feature-gates/bulk", {
          method: "POST", body: JSON.stringify({ changes }),
        });
        for (const c of changes) dirty.delete(c.feature_key);
        msg.textContent = `${t("admin.saved_prefix")}${changes.length}${t("admin.saved_suffix")}`;
        // clear highlight on saved rows
        card.querySelectorAll(".gate-row").forEach(el2 => el2.style.background = "");
        globalMsg.textContent = dirty.size ? `${dirty.size}${t("admin.unsaved_other_suffix")}` : "";
      } catch (err) {
        msg.textContent = t("admin.error_prefix") + err.message;
        saveBtn.disabled = false;
      }
    });
    saveRow.append(saveBtn, msg);
    card.append(saveRow);
    return card;
  };

  // Global save-all: fire one bulk request for every dirty key
  globalSave.addEventListener("click", async () => {
    if (!dirty.size) { globalMsg.textContent = t("admin.no_changes"); return; }
    globalSave.disabled = true; globalMsg.textContent = t("admin.saving_all");
    try {
      const changes = [...dirty].map(k => ({ feature_key: k, allowed_roles: state[k] }));
      await api("/api/admin/feature-gates/bulk", {
        method: "POST", body: JSON.stringify({ changes }),
      });
      dirty.clear();
      globalMsg.textContent = `${t("admin.saved_prefix")}${changes.length}${t("admin.saved_suffix")}`;
      view.querySelectorAll(".gate-row").forEach(el2 => el2.style.background = "");
      // Disable every "Save section" button by matching the translated label.
      const saveSectionLabel = t("btn.save_section");
      view.querySelectorAll('button[type="button"]').forEach(b => { if (b.textContent === saveSectionLabel) b.disabled = true; });
    } catch (err) {
      globalMsg.textContent = t("admin.error_prefix") + err.message;
    } finally {
      globalSave.disabled = false;
    }
  });

  // Render each section (order preserved from GATE_GROUPS)
  const sectionEls = [];
  const sectionOrder = [...Object.keys(GATE_GROUPS), "Other"];
  for (const s of sectionOrder) {
    const c = renderSection(s, sections[s]);
    if (c) { view.append(c); sectionEls.push(c); }
  }

  // Search filter
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    for (const card of sectionEls) {
      let anyVisible = false;
      card.querySelectorAll(".gate-row").forEach(row => {
        const key = row.getAttribute("data-key") || "";
        const match = !q || key.toLowerCase().includes(q);
        row.hidden = !match;
        if (match) anyVisible = true;
      });
      card.hidden = !anyVisible;
    }
  });
}

async function renderAdminUsers(view) {
  const myToken = routeToken;  // BUG 1+2
  ALL_USERS_CACHE = null;
  try {
    const { users } = await api("/api/admin/users");
    if (myToken !== routeToken) return;
    const ROLES = ["hk_leader","njy_leader","njy_coordinator","circle_servant","sector_servant","servant_leader","member"];
    const ul = el("ul", { class: "list" });
    for (const u of users) {
      const rangeText = (u.sl_range_start != null && u.sl_range_end != null)
        ? `${t("admin.sl_range_prefix")}${u.sl_range_start}-${u.sl_range_end}` : "";
      const mgr = users.find(x => x.id === u.manager_user_id);
      const mgrText = mgr ? `${t("admin.under_prefix")}${mgr.display_name || mgr.username}` : "";
      const li = el("li", {},
        el("div", {}, el("strong", {}, u.display_name || u.username),
          el("div", { class: "hint" }, `${u.username}${rangeText}${mgrText}${u.active ? "" : t("admin.inactive_suffix")}`)),
        el("span", { class: "pill" }, humanRole(u.role)),
        el("button", { class: "mini-btn" }, t("btn.edit_short")),
      );
      const editBtn = li.lastChild;
      editBtn.addEventListener("click", () => {
        const existing = li.querySelector(".manage");
        if (existing) { existing.remove(); return; }
        const p = el("div", { class: "manage" });
        const nm = el("input", { value: u.display_name || "" });
        const rl = el("select", {}, ...ROLES.map(r =>
          el("option", { value: r, selected: r === u.role ? true : undefined }, humanRole(r))));
        const pw = el("input", { type: "password", placeholder: t("admin.pw_ph_keep") });
        const act = el("select", {},
          el("option", { value: "1", selected: u.active ? true : undefined }, t("opt.active")),
          el("option", { value: "0", selected: !u.active ? true : undefined }, t("opt.inactive")),
        );
        const rs = el("input", { type: "number", value: u.sl_range_start ?? "", placeholder: t("admin.ph_sl_start") });
        const re = el("input", { type: "number", value: u.sl_range_end ?? "", placeholder: t("admin.ph_sl_end") });
        const autoBtn = el("button", { class: "mini-btn", type: "button" }, t("btn.autofill_range"));
        autoBtn.addEventListener("click", async () => {
          try {
            const r = await api("/api/admin/next-sl-range");
            rs.value = r.start; re.value = r.end;
          } catch (err) { alert(err.message); }
        });
        const save = el("button", { class: "primary" }, t("btn.save"));
        save.addEventListener("click", async () => {
          try {
            const body = {
              display_name: nm.value, role: rl.value, active: act.value === "1",
              sl_range_start: rs.value, sl_range_end: re.value,
              manager_user_id: mgrSel.value || null,
            };
            if (pw.value) body.password = pw.value;
            await api(`/api/admin/users/${u.id}`, { method: "POST", body: JSON.stringify(body) });
            renderRoute();
          } catch (err) { alert(err.message); }
        });
        // Manager dropdown — only NJY leaders show up; empty for HK/leader themselves.
        const leaders = users.filter(x => x.role === "njy_leader" && x.active);
        const mgrSel = el("select", {},
          el("option", { value: "" }, "- no manager -"),
          ...leaders.map(l => el("option", {
            value: l.id, selected: l.id === u.manager_user_id ? true : undefined,
          }, l.display_name || l.username)),
        );
        p.append(
          el("div", {}, el("label", {}, t("field.display_name")), nm),
          el("div", {}, el("label", {}, t("field.role")), rl),
          el("div", {}, el("label", {}, t("field.reset_password")), pw),
          el("div", {}, el("label", {}, t("field.status")), act),
          el("div", {}, el("label", {}, t("field.sl_range_start")), rs),
          el("div", {}, el("label", {}, t("field.sl_range_end")), re),
          el("div", { class: "full" }, el("label", {}, t("field.manager")), mgrSel),
          el("div", { class: "full" }, autoBtn, " ", save),
        );
        li.append(p);
      });
      ul.append(li);
    }
    view.append(ul);
    // Leaders list drives the Manager dropdown — only NJY Leaders are
    // valid managers (a coord's boss).
    const leaders = users.filter(u => u.role === "njy_leader" && u.active);
    const form = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
    const roleSel = el("select", { id: "u-role" },
      el("option", { value: "njy_coordinator" }, t("admin.opt_njy_coord")),
      el("option", { value: "njy_leader" }, t("admin.opt_njy_leader")),
      el("option", { value: "servant_leader" }, t("admin.opt_servant_leader")),
      el("option", { value: "sector_servant" }, t("admin.opt_sector_servant")),
      el("option", { value: "circle_servant" }, t("admin.opt_circle_servant")),
      el("option", { value: "hk_leader" }, t("admin.opt_hk_leader")),
    );
    const mgrSel = el("select", { id: "u-manager" },
      el("option", { value: "" }, "- no manager -"),
      ...leaders.map(l => el("option", { value: l.username }, l.display_name || l.username)),
    );
    const mgrRow = el("div", { id: "u-manager-row" },
      formField(t("admin.user_field_mgr"), mgrSel),
    );
    const updateMgrVisibility = () => {
      mgrRow.style.display = (roleSel.value === "njy_coordinator") ? "" : "none";
    };
    roleSel.addEventListener("change", updateMgrVisibility);
    form.append(
      el("h3", { class: "section" }, t("hd.new_user")),
      el("p", { class: "hint" }, t("help.new_user")),
      el("div", { class: "grid2" },
        formField(t("admin.user_field_username"), el("input", { id: "u-name", required: true, autocapitalize: "none", autocomplete: "off" })),
        formField(t("admin.user_field_display"), el("input", { id: "u-display", required: true })),
      ),
      el("div", { class: "grid2" },
        formField(t("admin.user_field_password"), el("input", { id: "u-pass", type: "password", required: true })),
        formField(t("admin.user_field_phone"), el("input", { id: "u-phone", inputmode: "numeric", placeholder: t("admin.user_ph_phone") })),
      ),
      el("div", { class: "grid2" },
        formField(t("admin.user_field_role"), roleSel),
        mgrRow,
      ),
      el("p", {}, el("button", { class: "primary", type: "submit" }, t("btn.create_user")),
        " ", el("span", { class: "hint", id: "u-msg" })),
    );
    updateMgrVisibility();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        username: $("u-name").value.trim(),
        password: $("u-pass").value,
        display_name: $("u-display").value.trim(),
        role: $("u-role").value,
        phone: $("u-phone").value.trim() || undefined,
        manager_username: (roleSel.value === "njy_coordinator" && mgrSel.value) ? mgrSel.value : undefined,
      };
      try {
        await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
        $("u-msg").textContent = t("admin.user_created"); renderRoute();
      } catch (err) {
        $("u-msg").textContent = err.body?.error === "username_taken" ? t("admin.user_err_username_taken")
          : err.body?.error === "manager_not_found" ? t("admin.user_err_manager")
          : (err.message || t("admin.user_err_generic"));
      }
    };
    view.append(form);
  } catch (err) {
    view.append(el("p", { class: "error" }, err.message));
  }
}

async function renderAdminImport(view) {
  const myToken = routeToken;  // BUG 1+2
  view.append(helpBanner(t("help.admin_bulk_chanters")));

  // Coord list for the dropdown (data-entry team picks which coord to
  // assign a batch to; per-row coord_username in the sheet also works
  // and OVERRIDES this batch default).
  let coordUsers = [];
  try {
    const { users } = await api("/api/admin/users");
    if (myToken !== routeToken) return;
    coordUsers = users.filter(u => u.role === "njy_coordinator" && u.active);
  } catch { /* ok — leave empty */ }

  // Path A — Excel/CSV file upload
  const uploadCard = el("div", { class: "card" });
  uploadCard.append(el("h3", { class: "section" }, t("hd.upload_excel_file")));

  // Coordinator picker for the whole batch (fallback when the sheet
  // doesn't specify coord_username per row).
  const coordSel = el("select", { id: "imp-assign-file" },
    el("option", { value: "" }, t("msg.pick_coord_batch")),
    ...coordUsers.map(c => el("option", { value: c.id }, `${c.display_name || c.username} (${c.username})`)),
  );
  uploadCard.append(el("div", { style: "margin:.4rem 0 .7rem" },
    el("label", { style: "display:block;font-size:.85rem;color:var(--muted);margin-bottom:.2rem" },
      t("admin.assign_batch_label")),
    coordSel,
  ));

  uploadCard.append(excelUploadWidget({
    helperText: t("admin.chanters_help"),
    templateBuilder: downloadChanterTemplate,
    templateLabel: t("btn.download_chanters_template"),
    isValidRow: (r) => r.legal_name && r.phone,
    emptyMessage: t("xl.no_usable_chanters"),
    previewCols: [t("xl.col_coupon"), t("xl.col_name"), t("xl.col_mobile"), t("xl.col_pincode"), t("xl.col_daily"), t("xl.col_coord")],
    previewRow: (r) => [r.coupon_no, r.legal_name, r.phone, r.pincode || "", r.is_daily || "", r.coord_username || ""],
    mapRow: (row) => ({
      legal_name: String(row.legal_name || row.name || row.Name || row.NAME || "").trim(),
      phone: String(row.phone || row.mobile || row.Mobile || "").trim(),
      pincode: String(row.pincode || row.Pincode || row.PINCODE || "").trim() || null,
      coupon_no: row.coupon_no || row["Coupon #"] || null,
      is_daily: String(row.is_daily || row["Daily?"] || "").trim().toLowerCase(),
      coord_username: String(row.coord_username || row["Coord username"] || "").trim(),
    }),
    onCommit: async (rows) => {
      // Resolve per-row coord_username → user id via the coord list we
      // already have. Rows without either wind up on the batch default.
      const byUsername = new Map(coordUsers.map(c => [c.username.toLowerCase(), c.id]));
      const enriched = rows.map(r => ({
        ...r,
        assigned_to_user_id: (r.coord_username && byUsername.get(r.coord_username.toLowerCase())) || coordSel.value || null,
      }));
      const r = await api("/api/import/commit", { method: "POST",
        body: JSON.stringify({ rows: enriched, assigned_to_user_id: coordSel.value || null }) });
      return { created: r.created, errors: r.errors };
    },
  }));
  view.append(uploadCard);

  // Path B — paste. Same coord picker as the file-upload path, so
  // the operator never has to type a raw user id.
  const card = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
  const pasteCoordSel = el("select", { id: "imp-assign" },
    el("option", { value: "" }, t("msg.pick_coord_paste")),
    ...coordUsers.map(c => el("option", { value: c.id }, `${c.display_name || c.username} (${c.username})`)),
  );
  card.append(
    el("h3", { class: "section" }, t("hd.paste_rows")),
    el("p", { class: "hint" }, t("help.admin_paste_chanters")),
    formField(t("hd.paste_excel"), el("textarea", { id: "imp-csv", rows: "12", placeholder: t("admin.chanters_paste_ph") })),
    el("div", { style: "margin:.4rem 0" },
      el("label", { style: "display:block;font-size:.85rem;color:var(--muted);margin-bottom:.2rem" },
        t("admin.assign_batch_label")),
      pasteCoordSel,
    ),
    el("p", {},
      el("button", { class: "ghost", type: "button", id: "imp-preview" }, t("btn.preview")),
      " ",
      el("button", { class: "primary", type: "submit" }, t("btn.commit")),
      " ", el("span", { class: "hint", id: "imp-msg" }),
    ),
    el("pre", { id: "imp-out", style: "font-family:var(--font-mono);font-size:.8rem;white-space:pre-wrap;color:var(--muted);margin-top:1rem" }),
  );
  // Split on TAB first (Excel copy format) then fall back to COMMA.
  // A row can use either separator, and the header row's separator
  // choice sets the mode for the whole paste.
  const parse = () => {
    const raw = $("imp-csv").value.trim();
    if (!raw) return [];
    const [head, ...lines] = raw.split(/\r?\n/);
    const sep = head.includes("\t") ? /\t/ : /,/;
    const cols = head.split(sep).map(s => s.trim());
    return lines.filter(Boolean).map(line => {
      const parts = line.split(sep).map(s => s.trim());
      const obj = {};
      cols.forEach((c, i) => obj[c] = parts[i] || "");
      return obj;
    });
  };
  $("imp-preview") || null; // keep tree
  card.querySelector("#imp-preview").addEventListener("click", async () => {
    try {
      const rows = parse();
      const r = await api("/api/import/preview", { method: "POST", body: JSON.stringify({ rows }) });
      $("imp-out").textContent = JSON.stringify(r, null, 2);
    } catch (err) { $("imp-msg").textContent = err.message; }
  });
  card.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const rawRows = parse();
      // Resolve per-row coord_username to user id, mirroring the file-upload path.
      const byUsername = new Map(coordUsers.map(c => [c.username.toLowerCase(), c.id]));
      const rows = rawRows.map(r => {
        const un = String(r.coord_username || "").trim().toLowerCase();
        return {
          ...r,
          legal_name: r.legal_name || r.name || "",
          phone: r.phone || r.mobile || "",
          assigned_to_user_id: (un && byUsername.get(un)) || pasteCoordSel.value || null,
        };
      });
      const r = await api("/api/import/commit", { method: "POST", body: JSON.stringify({
        rows, assigned_to_user_id: pasteCoordSel.value || null,
      }) });
      $("imp-out").textContent = JSON.stringify(r, null, 2);
      $("imp-msg").textContent = `${t("admin.record_created_prefix")}${r.created}${t("admin.record_created_suffix")}`;
    } catch (err) { $("imp-msg").textContent = err.message; }
  };
  view.append(card);
}

async function renderAdminEvents(view) {
  const myToken = routeToken;  // BUG 1+2
  try {
    const { events } = await api("/api/events");
    if (myToken !== routeToken) return;
    if (events.length) {
      const ul = el("ul", { class: "list" });
      for (const e of events) {
        const li = el("li", {},
          el("div", {}, el("strong", {}, e.name),
            el("div", { class: "hint" }, `${e.kind} · ${e.event_date}${e.venue ? " · " + esc(e.venue) : ""}${e.batch_number ? t("admin.batch_prefix") + e.batch_number : ""}`)),
          el("span", { class: "pill" }, e.capacity ? `${t("admin.cap_prefix")}${e.capacity}` : ""),
          el("div", {}),
        );
        const actions = li.lastChild;
        const attendance = el("a", { class: "mini-btn", href: `#/events/${e.id}` }, t("btn.attendance"));
        const del = el("button", { class: "danger", style: "margin-left:.4rem" }, t("btn.delete_short"));
        del.addEventListener("click", async () => {
          if (!confirm(`${t("confirm.delete_event_prefix")} "${e.name}"${t("confirm.delete_event_suffix")}`)) return;
          try {
            await api(`/api/events/${e.id}`, { method: "DELETE" });
            renderRoute();
          } catch (err) { alert(err.message); }
        });
        actions.append(attendance, del);
        ul.append(li);
      }
      view.append(ul);
    }
    const form = el("form", { class: "card", method: "post", action: "javascript:void(0)" });
    form.append(
      el("h3", { class: "section" }, t("hd.new_event")),
      formField(t("admin.ev_field_name"), el("input", { id: "ev-name", required: true })),
      el("div", { class: "grid2" },
        formField(t("admin.ev_field_kind"), el("select", { id: "ev-kind" },
          el("option", { value: "njy1" }, t("admin.ev_kind_njy1")),
          el("option", { value: "njy2" }, t("admin.ev_kind_njy2")),
          el("option", { value: "njy3" }, t("admin.ev_kind_njy3")),
          el("option", { value: "bg_session" }, t("admin.ev_kind_bg_session")),
          el("option", { value: "bvgm" }, t("admin.ev_kind_bvgm")),
          el("option", { value: "children_program" }, t("admin.ev_kind_children")),
          el("option", { value: "festival" }, t("admin.ev_kind_festival")),
        )),
        formField(t("admin.ev_field_date"), el("input", { id: "ev-date", type: "date", required: true })),
      ),
      el("div", { class: "grid2" },
        formField(t("admin.ev_field_time"), el("input", { id: "ev-time", placeholder: t("admin.ev_ph_time") })),
        formField(t("admin.ev_field_venue"), el("input", { id: "ev-venue" })),
      ),
      el("div", { class: "grid2" },
        formField(t("admin.ev_field_capacity"), el("input", { id: "ev-cap", type: "number" })),
        formField(t("admin.ev_field_batch"), el("input", { id: "ev-batch", type: "number" })),
      ),
      el("p", {}, el("button", { class: "primary", type: "submit" }, t("btn.save_event")),
        " ", el("span", { class: "hint", id: "ev-msg" })),
    );
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = {
        kind: $("ev-kind").value, name: $("ev-name").value,
        event_date: $("ev-date").value, event_time: $("ev-time").value,
        venue: $("ev-venue").value,
        capacity: $("ev-cap").value ? +$("ev-cap").value : null,
        batch_number: $("ev-batch").value ? +$("ev-batch").value : null,
      };
      try {
        await api("/api/events", { method: "POST", body: JSON.stringify(body) });
        $("ev-msg").textContent = t("msg.saved_short"); renderRoute();
      } catch (err) { $("ev-msg").textContent = err.message; }
    };
    view.append(form);
  } catch (err) { view.append(el("p", { class: "error" }, err.message)); }
}
