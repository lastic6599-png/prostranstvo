// Офлайн-кэш оболочки приложения. При изменении файлов увеличьте версию.
const CACHE = 'prostranstvo-v1';
const SHELL = [
  './', 'index.html', 'css/app.css',
  'js/config.js', 'js/data.js', 'js/bridge.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Сеть в приоритете, кэш — если офлайн. API не кэшируем.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
