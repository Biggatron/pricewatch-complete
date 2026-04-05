const STATIC_CACHE_NAME = 'pricewatcher-static-v1';
const CORE_ASSETS = [
  '/manifest.webmanifest',
  '/images/favicon.ico',
  '/images/orange-brown-app-icon.png',
  '/css/main.css?v=20260405-2',
  '/css/general.css?v=20260405-2',
  '/css/navbar.css?v=20260405-2',
  '/scripts/httpUtil.js',
  '/scripts/generalUtil.js',
  '/scripts/pwa.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== STATIC_CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  const assetKey = `${requestUrl.pathname}${requestUrl.search}`;
  if (!CORE_ASSETS.includes(assetKey)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        const responseToCache = networkResponse.clone();
        caches.open(STATIC_CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      });
    })
  );
});
