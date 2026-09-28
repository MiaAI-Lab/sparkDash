// sparkDash service worker — offline app shell only.
//
// This is a LIVE telemetry dashboard. GPU/power/LLM numbers and WebSocket
// streams must never be served from cache: a stale reading presented as live is
// worse than an offline error. So the SW caches only the static app shell
// (index.html + hashed /assets + /icons + manifest) and passes every API call,
// WebSocket connection, and non-GET request straight to the network untouched.
//
// Cache key bumped on deploy-invalidating changes; activate purges old versions.
const VERSION = "sparkdash-v1";
const SHELL = "shell-" + VERSION;
const WORK = "work-" + VERSION;

const APP_SHELL = ["/", "/manifest.webmanifest", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(APP_SHELL))
      .catch(() => void 0) // precache is best-effort; runtime cache still covers
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== WORK).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

// Never let the SW intercept WebSockets or cross-origin probes; only same-origin GET.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Live data endpoints: always hit the network, never cache.
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws" || url.pathname.startsWith("/ws")) {
    return;
  }

  // Immutable hashed build assets: cache-first, then network, then store.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              if (res && res.ok) {
                const clone = res.clone();
                caches.open(WORK).then((c) => c.put(req, clone));
              }
              return res;
            })
            .catch(() => hit)
      )
    );
    return;
  }

  // Navigations + shell docs: network-first so a fresh deploy is seen
  // immediately; fall back to the cached shell only when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(SHELL).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then(
          (hit) => hit || caches.match("/index.html").then((shell) => shell || Response.error())
        )
      )
  );
});
