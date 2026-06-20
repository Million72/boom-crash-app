// Minimal service worker — required for PWA installability checks.
// This app is live-data driven (WebSocket), so we intentionally avoid
// caching pages/data: just pass requests straight through to the network.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
