// Notification adapter. Handlers call notify(kind, target, payload) and
// this module dispatches to whichever backends are registered.
//
// Day-1 backends registered from functions/api/[[path]].js:
//   'wa-deeplink' -> returns { url } for the UI to open. No network.
//   'web-push'    -> pushes to a subscription via VAPID (Workers-native
//                    web-push over crypto.subtle).
//
// Later backends slot in without touching call sites:
//   'wa-cloud'    -> Meta WhatsApp Cloud API (free ≤1000 conv/mo)
//   'twilio-wa'   -> Twilio WhatsApp
//   'msg91'       -> MSG91 SMS/WhatsApp
//
// A backend is just:  async (target, payload, ctx) => { ok, ... }

const backends = new Map();

export function registerBackend(kind, impl) {
  backends.set(kind, impl);
}

export function hasBackend(kind) {
  return backends.has(kind);
}

export function registeredKinds() {
  return [...backends.keys()];
}

export async function notify(kind, target, payload, ctx) {
  const impl = backends.get(kind);
  if (!impl) {
    const err = new Error(`no backend for ${kind}`);
    err.status = 501;
    throw err;
  }
  return impl(target, payload, ctx);
}

// -- built-in: wa.me deep-link --------------------------------------
// Pure function; no network. Returns the URL for the UI to open.
export function waDeepLink(phone, text) {
  // api.whatsapp.com/send/ preserves 4-byte UTF-8 (emoji) in ?text=
  // faithfully. wa.me issues a 302 to api.whatsapp.com that ASCII-fies
  // the text param — every emoji codepoint arrives as U+FFFD (renders as
  // "?") in WhatsApp Web. Confirm with:
  //   curl -sI 'https://wa.me/9999?text=%F0%9F%8C%B8' | grep Location
  // → Location has text=%EF%BF%BD instead of %F0%9F%8C%B8.
  const num = String(phone || "").replace(/[^\d]/g, "");
  const enc = encodeURIComponent(text || "");
  return num
    ? `https://api.whatsapp.com/send/?phone=${num}&text=${enc}`
    : `https://api.whatsapp.com/send/?text=${enc}`;
}

export function waDeeplinkBackend() {
  return async (target, payload /* {text}, ctx */) => {
    return { ok: true, kind: "wa-deeplink", url: waDeepLink(target, payload?.text) };
  };
}

// -- built-in: web-push (VAPID) --------------------------------------
// Real send is added in task 9 when we ship the service worker; for
// now this backend just records to the notifications outbox via ctx.
// Signature is stable so real impl slots in later.
export function webPushBackend() {
  return async (target /* {endpoint,p256dh,auth} */, payload, ctx) => {
    if (ctx?.store) {
      await ctx.store.recordNotification({
        kind: "web-push",
        target_user_id: ctx.userId || null,
        payload,
        status: "pending",
      });
    }
    return { ok: true, kind: "web-push", queued: true };
  };
}

// Register the always-on backends. Callers may register more (e.g.
// wa-cloud when Meta credentials are present in env).
export function registerBuiltins() {
  registerBackend("wa-deeplink", waDeeplinkBackend());
  registerBackend("web-push", webPushBackend());
}

// Clean bilingual defaults — Tamil block first, then English block,
// clearly separated by blank lines so it doesn't feel jumbled. Each
// coordinator can override with their own copy on My Sangha.
export const WA_TEMPLATES = Object.freeze({
  // Single template used for every roll member (no-emoji, respectful
  // reminder tone). Coord overrides on My Sangha; falls back here.
  reminder: (name) =>
    `Hare Krsna ${name || ""},\n\n` +
    `This is a gentle reminder to chant your daily rounds. Every round counts.\n\n` +
    `Hare Krsna.`,

  janmashtami_invite: (name) =>
    `ஹரே கிருஷ்ண ${name || ""}! 🙏\n\n` +
    `ISKCON Thiruppalai-ல் ஸ்ரீ கிருஷ்ண ஜென்மாஷ்டமிக்கு உங்களை அன்புடன் அழைக்கிறோம். ` +
    `விவரங்களுக்கு பதிலளிக்கவும்.\n\n` +
    `---\n\n` +
    `Hare Krsna ${name || ""}!\n\n` +
    `You are warmly invited to Sri Krsna-Janmastami at ISKCON Thiruppalai. ` +
    `Reply to know more.`,

  daily_reminder: (name) =>
    `ஹரே கிருஷ்ண ${name || ""}! 🌸\n\n` +
    `இன்று உங்கள் ஜபம் முடிந்ததா? ஒரு மாலை ஜபம் கூட நாளை புனிதப்படுத்தும்.\n\n` +
    `---\n\n` +
    `Hare Krsna ${name || ""}!\n\n` +
    `Did you complete your japa today? Even one round makes the day meaningful.`,

  yajna_invite: (name, date, venue) =>
    `ஹரே கிருஷ்ண ${name || ""}! 🕉\n\n` +
    `நாம ஜப யக்ஞத்திற்கு${date ? " (" + date + ")" : ""}${venue ? " – " + venue : ""} உங்களை அழைக்கிறோம். ` +
    `உங்கள் வருகையை உறுதிப்படுத்தவும்.\n\n` +
    `---\n\n` +
    `Hare Krsna ${name || ""}!\n\n` +
    `You are invited to the Nama-Japa-Yajna${date ? " on " + date : ""}${venue ? " at " + venue : ""}. ` +
    `Kindly confirm your attendance.`,

  followup: (name) =>
    `ஹரே கிருஷ்ண ${name || ""}! 🙏\n\n` +
    `எப்படி இருக்கிறீர்கள்? ஜபம் தொடர்ந்து செய்கிறீர்களா? நான் எப்படி உதவ முடியும் என்று தெரிவிக்கவும்.\n\n` +
    `---\n\n` +
    `Hare Krsna ${name || ""}!\n\n` +
    `How are you? Hope your daily chanting is going well. Let me know how I can help.`,
});
