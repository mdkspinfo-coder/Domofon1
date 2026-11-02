// Кэширует только файлы самого приложения (оболочку). Тайлы карты и библиотека с CDN не кэшируются.
const CACHE = 'domofon-shell-v3';
const SHELL = [
  './', './index.html', './app.js', './geo.js', './store.js', './config.js', './manifest.webmanifest',
  './moderation.html', './moderation.js', './privacy.html', './terms.html', './consent.html', './legal.js', './legal.css',
  './icon-180.png', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Сначала сеть (чтобы обновления приходили сразу), без сети - из кэша.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
