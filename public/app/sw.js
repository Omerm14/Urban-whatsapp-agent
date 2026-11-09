// Service worker for the Lia team app: offline shell + push notifications.
// API calls are never cached — the app must always show live conversations.
const CACHE = "lia-shell-v2";
const SHELL = ["/app/", "/app/index.html", "/app/app.css", "/app/app.js", "/app/icon.svg", "/app/lia.svg", "/app/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first for the shell (so deploys show up immediately), cache as fallback.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/app/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/app/")))
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: "ליה", body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "ליה", {
    body: data.body || "",
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    icon: "/app/icon-192.png",
    badge: "/app/icon-192.png",
    dir: "rtl",
    lang: "he",
    data: { url: data.url || "/app/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || "/app/", location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes("/app/")) {
        await c.focus();
        c.postMessage({ type: "open", url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
