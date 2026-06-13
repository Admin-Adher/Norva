const CACHE = 'norva-mobile-v5';
const ASSETS = ['/', '/index.html', '/account.html', '/cloud.html', '/manifest.json', '/icon-192.png', '/cloudApi.js', '/authApi.js'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)))
);

self.addEventListener('fetch', e =>
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)))
);
