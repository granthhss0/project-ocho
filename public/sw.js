const CACHE_NAME = 'ocho-proxy-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  return self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only intercept requests to our proxy endpoint
  if (url.pathname.startsWith('/proxy/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone the response before returning
          const responseClone = response.clone();
          
          // Optionally cache successful responses
          if (response.ok) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          
          return response;
        })
        .catch(() => {
          // Try to return cached version if network fails
          return caches.match(event.request);
        })
    );
  }
});
