const CACHE_NAME = 'rrd-tickets-pwa-v4';
const STATIC_ASSETS = [
  '/manifest.json',
  '/favicon.svg',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Allow immediate activation when a new update is detected
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  // Never intercept non-GET, API calls, or the service worker itself
  if (event.request.method !== 'GET' || event.request.url.includes('/api/') || event.request.url.includes('/sw.js')) {
    return;
  }

  // Network-First for HTML navigation requests (ensures new build hashes are immediately loaded)
  if (event.request.mode === 'navigate' || event.request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      new Promise((resolve) => {
        let didFallback = false;
        // 3.5s timeout fallback to offline cache if network is slow/offline
        const timeoutId = setTimeout(() => {
          didFallback = true;
          caches.match(event.request).then((cached) => {
            resolve(cached || caches.match('/index.html') || caches.match('/'));
          });
        }, 3500);

        fetch(event.request)
          .then((networkResponse) => {
            clearTimeout(timeoutId);
            if (networkResponse && networkResponse.status === 200) {
              const clone = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            if (!didFallback) resolve(networkResponse);
          })
          .catch(() => {
            clearTimeout(timeoutId);
            caches.match(event.request).then((cached) => {
              resolve(cached || caches.match('/index.html') || caches.match('/'));
            });
          });
      })
    );
    return;
  }

  // Cache-First with background revalidation for static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }
      return fetch(event.request);
    })
  );
});
