const STATIC_CACHE = 'kiviomap-static-v5';
const DATA_CACHE = 'kiviomap-data-v5';
const TILES_CACHE = 'kiviomap-tiles-v5';

const STATIC_ASSETS = [
  '/',
  '/css/style.css?v=2',
  '/js/map.js?v=5',
  '/img/logo.png',
  '/manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.css',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// Transparent 1x1 PNG for missing tiles offline
const TRANSPARENT_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
]);

function transparentTileResponse() {
  return new Response(TRANSPARENT_PNG, {
    status: 200,
    headers: { 'Content-Type': 'image/png' }
  });
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(cache => {
      return Promise.all(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err => console.warn('[SW] Pré-cache échoué pour:', url, err))
        )
      );
    }).then(() => {
      return caches.open(DATA_CACHE).then(cache => {
        return cache.add('/api/wifi').catch(err => console.warn('[SW] Pré-cache /api/wifi:', err));
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  const allowedCaches = [STATIC_CACHE, DATA_CACHE, TILES_CACHE];
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.map(key => {
          if (!allowedCaches.includes(key)) {
            console.log('[SW] Suppression ancien cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  // Ignorer les requêtes non-GET
  if (request.method !== 'GET') return;

  // 1. Tuiles OpenStreetMap (Cache-first pour fluidité et mode hors-ligne)
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open(TILES_CACHE).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;

        // Si hors-ligne, ne pas tenter le réseau (évite net::ERR_INTERNET_DISCONNECTED en console)
        if (!self.navigator.onLine) {
          return transparentTileResponse();
        }

        try {
          const networkResponse = await fetch(request);
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          return transparentTileResponse();
        }
      })
    );
    return;
  }

  // 2. Endpoints API Wi-Fi (/api/wifi et /wifi/:id/json)
  if (url.pathname === '/api/wifi' || /^\/wifi\/[^\/]+\/json$/.test(url.pathname)) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async cache => {
        if (!self.navigator.onLine) {
          const cached = await cache.match(request);
          if (cached) return cached;
          return new Response(JSON.stringify({ offline: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        try {
          const networkResponse = await fetch(request);
          if (networkResponse && networkResponse.status === 200) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        } catch (err) {
          const cachedResponse = await cache.match(request);
          if (cachedResponse) return cachedResponse;
          return new Response(JSON.stringify({ offline: true }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      })
    );
    return;
  }

  // 3. Navigation HTML (pages) -> Réseau d'abord si en ligne, sinon cache de la page ou / (carte)
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      (async () => {
        if (!self.navigator.onLine) {
          const cached = await caches.match(request);
          if (cached) return cached;
          const fallback = await caches.match('/');
          if (fallback) return fallback;
          return new Response('Mode hors-ligne : vous êtes actuellement déconnecté.', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }

        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        } catch (err) {
          const cached = await caches.match(request);
          if (cached) return cached;
          const fallback = await caches.match('/');
          if (fallback) return fallback;
          return new Response('Mode hors-ligne : vous êtes actuellement déconnecté.', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }
      })()
    );
    return;
  }

  // 4. Polices distantes (Google Fonts / fonts.gstatic.com)
  if (url.hostname.includes('fonts.gstatic.com') || url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(
      caches.match(request).then(async cachedResponse => {
        if (cachedResponse) return cachedResponse;
        if (!self.navigator.onLine) {
          return new Response('', { status: 200, headers: { 'Content-Type': 'font/woff2' } });
        }
        try {
          const networkResponse = await fetch(request);
          if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
            caches.open(STATIC_CACHE).then(cache => cache.put(request, networkResponse.clone()));
          }
          return networkResponse;
        } catch (err) {
          return new Response('', { status: 200 });
        }
      })
    );
    return;
  }

  // 5. Assets statiques (CSS, JS, Images comme /img/logo.png) -> Cache-first
  event.respondWith(
    caches.match(request).then(async cachedResponse => {
      if (cachedResponse) return cachedResponse;

      if (!self.navigator.onLine) {
        return new Response('', { status: 408, statusText: 'Offline' });
      }

      try {
        const networkResponse = await fetch(request);
        if (networkResponse && (networkResponse.status === 200 || networkResponse.type === 'opaque')) {
          caches.open(STATIC_CACHE).then(cache => cache.put(request, networkResponse.clone()));
        }
        return networkResponse;
      } catch (err) {
        return cachedResponse || new Response('', { status: 408, statusText: 'Offline' });
      }
    })
  );
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
