const APP_CACHE = "image-editor-shell-v1";
const OFFLINE_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/pdf.worker.min.mjs",
  "/icons/app-icon.svg",
  "/icons/maskable-icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) => cache.addAll(OFFLINE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== APP_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Limit the usage only for offline: Network-First strategy
  // We prefer the live network to eliminate interceptor risks. We only use the cache if offline.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        const cloned = networkResponse.clone();
        caches.open(APP_CACHE).then((cache) => cache.put(event.request, cloned));
        return networkResponse;
      })
      .catch(() => {
        // Fallback to cache ONLY if the network fails (offline)
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          
          // Only fallback to the HTML shell for navigation requests
          if (event.request.mode === 'navigate' || event.request.headers.get('accept').includes('text/html')) {
            return caches.match("/index.html");
          }
          
          return new Response("Offline and asset missing from cache", { 
            status: 503, 
            statusText: "Service Unavailable" 
          });
        });
      })
  );
});
