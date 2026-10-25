/*
 * Patchbay service worker - deliberately minimal.
 *
 * Live dashboards need the network, so this worker never caches data:
 * /api, /auth, /oauth, /mcp and live streams always go straight to the network.
 * It only makes the app installable, caches the hashed static assets (they
 * never change under the same name), and shows an offline page instead of the
 * browser's error when a page cannot be loaded.
 */
const VERSION = 'v1';
const SHELL = `patchbay-shell-${VERSION}`;
const ASSETS = `patchbay-assets-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const MAX_ASSETS = 80;
const NETWORK_ONLY = ['/api/', '/auth/', '/oauth/', '/mcp', '/.well-known/', '/healthz'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll([OFFLINE_URL, '/offline.js', '/icons/icon-192.png']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cacheName) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NETWORK_ONLY.some((prefix) => url.pathname.startsWith(prefix))) return;

  // Pages: always the network (so a new deploy is picked up at once), offline page as fallback.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match(OFFLINE_URL)));
    return;
  }

  // Hashed build assets are immutable: serve from cache, fill the cache on first use.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              event.waitUntil(
                caches
                  .open(ASSETS)
                  .then((cache) => cache.put(request, copy))
                  .then(() => trim(ASSETS)),
              );
            }
            return response;
          }),
      ),
    );
  }
});
