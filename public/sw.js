// Shell cache so the app opens without a connection. Dish photos are left to
// the normal HTTP cache; caching them here would hoard tens of MB.
const SHELL = "dadfood-shell-v2";
const SHELL_URLS = ["/", "/manifest.json", "/icon-192.png"];

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
  if (url.pathname.startsWith("/api/") || url.pathname === "/version.json") return; // always live

  if (request.mode === "navigate") {
    // no-store so a stale HTTP-cached copy cannot mask a new deploy
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/"))
    );
    return;
  }
  event.respondWith(caches.match(request).then(hit => hit || fetch(request)));
});
