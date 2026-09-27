// WORLDSPIRE service worker.
//
// CACHE_VERSION is injected by the server from package.json at serve time
// (see server.js), so every release ships a new cache name: a version bump
// guarantees fresh game code and the old cache is deleted on activate.
// Bump package.json whenever game code changes.
//
// Strategy:
// - versioned static assets (JS/CSS with ?v=, icons, manifest): cache-first
// - "/" HTML: network-first (a new release is picked up immediately,
//   cached copy is the offline fallback)
// - everything else: network-first, never cached
// - NEVER intercepts: API routes (/api/*) and the WebSocket (/ws)
const CACHE_VERSION = 'worldspire-__APP_VERSION__';

const STATIC_RE = /\.(?:js|css|png|webmanifest|woff2?)$/i;
const PRECACHE = [
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  // skipWaiting runs even if precaching fails: a failed precache must never
  // wedge the new worker in "waiting" and keep serving stale game code.
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE))
      .catch((e) => console.warn('[sw] precache failed:', e))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // NEVER cache API traffic or the game WebSocket.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    // App shell: network-first so releases apply immediately.
    event.respondWith(
      fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
        }
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }

  if (STATIC_RE.test(url.pathname)) {
    // Versioned assets (query string is part of the cache key): cache-first.
    event.respondWith(
      caches.match(request).then((hit) => {
        if (hit) return hit;
        return fetch(request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(request, copy));
          }
          return res;
        });
      })
    );
    return;
  }

  // Everything else: straight to network, never cached.
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
