/**
 * Norva service worker — installable PWA with a network-first app shell.
 *
 * Deliberately conservative for a Cloudflare Pages deployment whose build
 * pipeline rewrites the ?v= cache-busting params:
 *   - navigations + JS/CSS are NETWORK-FIRST (fresh deploys always win),
 *     falling back to the last cached copy only when offline;
 *   - images/fonts are cache-first with a bounded cache;
 *   - API/gateway/stream requests are never touched.
 * Bump CACHE_VERSION to drop every old cache on activate.
 */

const CACHE_VERSION = 'norva-sw-v1';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const ASSET_CACHE = `${CACHE_VERSION}-assets`;
const ASSET_CACHE_LIMIT = 220;

const PRECACHE = [
  '/app.html',
  '/manifest.json',
  '/img/norva-media-placeholder.png',
  '/img/icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .catch(() => { /* partial precache is fine — runtime caching fills in */ })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

// Anything that streams or talks to the backend must bypass the SW entirely.
function isBypassed(url) {
  if (!isSameOrigin(url)) {
    // Cross-origin: only TMDB images are worth caching; everything else
    // (Supabase, gateway, relay, CDN scripts) goes straight to the network.
    return url.hostname !== 'image.tmdb.org';
  }
  return url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/relay/')
    || url.pathname.startsWith('/raw/')
    || url.pathname.startsWith('/sessions/');
}

async function trimCache(cacheName, limit) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - limit; i++) {
      await cache.delete(keys[i]);
    }
  } catch (_) { /* trimming is best-effort */ }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => { });
    }
    return response;
  } catch (_) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match('/app.html');
      if (shell) return shell;
    }
    throw _;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone()).catch(() => { });
    trimCache(cacheName, ASSET_CACHE_LIMIT);
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try { url = new URL(request.url); } catch (_) { return; }
  if (isBypassed(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  const dest = request.destination;
  if (dest === 'script' || dest === 'style' || dest === 'manifest') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }
  if (dest === 'image' || dest === 'font') {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
  }
});
