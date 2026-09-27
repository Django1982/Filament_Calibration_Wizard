/* PerfectFit service worker — offline cache of the app shell (web/PWA only;
   the Tauri desktop app never registers this and unregisters old copies).
   No network calls are ever made for user data; this only caches the app's
   own static files after the first visit.

   Strategy: network-first for navigations/HTML (so updates are picked up
   immediately; cache is only an offline fallback), cache-first for hashed
   immutable assets. A cache-first HTML shell must never come back: it keeps
   serving an old index.html whose hashed bundle no longer exists after an
   update, leaving the app stuck on the loading screen. */
const CACHE = 'perfectfit-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch third-party requests
  // The opt-in self-hosted backend's API is live data, never static/immutable —
  // let it hit the network untouched. Caching it would make backend-detection
  // and data reads silently go stale after the first successful response.
  if (url.pathname.includes('/api/v1/')) return;

  const fetchAndCache = () => fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  });

  const isShell = req.mode === 'navigate'
    || url.pathname === '/' || url.pathname.endsWith('/index.html')
    || url.pathname.endsWith('/manifest.webmanifest') || url.pathname.endsWith('/sw.js');

  if (isShell) {
    // Network-first: only fall back to cache when actually offline.
    event.respondWith(fetchAndCache().catch(() => caches.match(req).then((hit) => hit || Response.error())));
  } else {
    // Hashed assets are immutable — cache-first is safe for them.
    event.respondWith(
      caches.match(req).then((hit) => hit || fetchAndCache().catch(() => hit || Response.error()))
    );
  }
});
