// Minimal service worker whose only job is PWA installability. It is
// deliberately network-only: no caching, so assets can never go stale --
// the server's ETag/304 handling already makes revalidation cheap.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
    event.respondWith(fetch(event.request));
});
