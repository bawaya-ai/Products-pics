// Scraper Pro service worker — enables install + an offline shell.
// Static assets: cache-first (offline-capable). Pages: network-first (always fresh).
// API + cross-origin + non-GET: never touched (auth/scrape must never be cached).
const CACHE = 'scraper-pro-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // don't touch cross-origin
  if (url.pathname.startsWith('/api/')) return;         // never cache APIs

  const isStatic = url.pathname.startsWith('/_next/static') || /\.(png|jpe?g|webp|svg|ico|css|js|woff2?)$/.test(url.pathname);
  if (isStatic) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const clone = res.clone(); caches.open(CACHE).then((c) => c.put(req, clone)); return res;
    })));
  } else {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
  }
});
