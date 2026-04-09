/* eslint-disable no-undef */

// Minimal service worker – satisfies the PWA installability requirement
// without caching any assets. All requests fall through to the network,
// so there is no risk of serving stale chunks after a deployment.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Network-only fetch handler – no caching.
self.addEventListener("fetch", () => {});
