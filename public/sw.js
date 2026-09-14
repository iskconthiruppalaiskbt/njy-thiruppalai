// Service worker for the NJY PWA.
//
// Strategy:
//   /assets/*, /, /index.html, manifest, sw.js  →  cache-first, refresh in background
//   /api/*                                      →  network-first, fall back to cached GETs only
//
// Bump SHELL_VERSION when any static asset changes so old clients pick up
// the new bundle within one reload.

// Bump this whenever any static asset changes so live users pick up
// the new bundle within one reload of the app shell.
const SHELL_VERSION = "njy-shell-v69";
// On localhost / 127.x we NEVER cache — otherwise every dev change gets
// served from stale cache and looks like the change didn't ship. In
// production this SW behaves normally.
const IS_DEV = (self.location.hostname === "localhost" || self.location.hostname.startsWith("127."));
const SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/assets/app.css",
  "/assets/app.js",
  "/assets/icon.svg",
  "/assets/icon-maskable.svg",
];

self.addEventListener("install", (event) => {
  if (IS_DEV) { self.skipWaiting(); return; }
  event.waitUntil(caches.open(SHELL_VERSION).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== SHELL_VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                     // never cache writes
  if (IS_DEV) return;                                    // dev: always network
  const url = new URL(req.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(SHELL_VERSION);
  const cached = await cache.match(req);
  if (cached) {
    // Refresh in the background so the next load has the latest.
    fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); }).catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return caches.match("/");
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline" }), {
      status: 503, headers: { "content-type": "application/json" },
    });
  }
}

// -------------------------- push notifications --------------------------
// Web push handler. Payload from the server (task 10 web-push backend)
// is a JSON blob like { title, body, url, tag }. Tap opens the URL.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const title = data.title || "NJY";
  const body = data.body || "";
  const url  = data.url  || "/";
  event.waitUntil(self.registration.showNotification(title, {
    body, tag: data.tag || "njy",
    icon: "/assets/icon.svg",
    badge: "/assets/icon.svg",
    data: { url },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (existing) { existing.focus(); existing.navigate(url); return; }
    self.clients.openWindow(url);
  })());
});
