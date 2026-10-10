// sparkDash service worker — minimal offline shell + passthrough for live data.
// The dashboard is real-time (API + WebSocket), so we NEVER cache /api or /ws
// responses. We only cache the app shell so the installed PWA opens instantly
// and still renders (with a "offline" state from the app itself) when the
// network to the server blips.
const CACHE = "sparkdash-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs; everything else (WS upgrades, POSTs) passes through.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // Live data: always network, never cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws")) return;

  // Hashed build assets: cache-first (they're content-hashed, immutable).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  // App shell / index: network-first, fall back to cache when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html")))
  );
});
