// Minimal shell cache: lets the app open when the phone is offline or slow.
// Dish photos are left to the normal HTTP cache (they already carry
// cache-control: max-age=86400) so the app never hoards tens of MB.
const SHELL = "dadfood-shell-v1";
const SHELL_URLS = ["/", "/index.html", "/manifest.json", "/icon-192.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // always live data

  // Navigations: network first, fall back to the cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then(r => r || caches.match("/index.html")))
    );
    return;
  }
  event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
});
