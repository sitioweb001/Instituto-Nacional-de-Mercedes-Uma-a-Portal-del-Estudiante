const CACHE_NAME = 'inmu-permanencia-alumnos-v3';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './logo3.jpg',
  './logo2.svg',
  './Escudo_de_El_Salvador.svg',
  './marca de agua.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS).catch(() => null))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // El Apps Script siempre debe intentar ir a red para traer estado real.
  if (url.hostname.includes('script.google.com') || url.hostname.includes('googleusercontent.com')) {
    event.respondWith(fetch(req).catch(() => new Response(JSON.stringify({ offline:true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // Navegación: red primero, caché como respaldo.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  // Assets: caché primero, red después.
  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => null);
      return resp;
    }).catch(() => cached))
  );
});
