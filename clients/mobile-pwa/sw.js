const CACHE = 'norva-mobile-v2';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/cloudApi.js'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)))
);

self.addEventListener('fetch', e =>
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)))
);
