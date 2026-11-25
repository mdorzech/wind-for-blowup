// Wind Watch service worker: shows wind alerts pushed by the Worker, and keeps the
// last loaded dashboard available when the phone is offline.
const CACHE = "wind-watch-v1";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.svg", "/icon-192.png", "/apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, so the page and its data are always fresh when online; the cached
// copy is only a fallback. Actions (POST) and other sites are left alone.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/") : Response.error())),
      ),
  );
});

self.addEventListener("push", (event) => {
  let msg = {};
  try {
    msg = event.data ? event.data.json() : {};
  } catch {
    msg = { body: event.data ? event.data.text() : "" };
  }
  const title = msg.title || "Wind Watch";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: msg.body || "Open Wind Watch for the latest check.",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: msg.tag || "wind",
      renotify: true,
      requireInteraction: !!msg.urgent,
      data: { url: msg.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          if ("navigate" in w) w.navigate(target).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
