// Consuls' service worker: shows the notifiers' pushes, opens the app (at the pane) when one is
// tapped, and keeps the app's shell cached so it still opens while no notifier serves it.
// Every push must show a notification: iOS drops subscriptions that receive silent ones.

const SHELL = "consuls-shell-v2";
// A push may only open this app, or Tailscale's SSH approval page: anyone holding the push key
// could otherwise send you a link to anywhere.
const ALLOWED_ELSEWHERE = ["https://login.tailscale.com/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(["/", "/manifest.webmanifest", "/icon-192.png"]))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

// The page: network first (a running notifier has the latest), the cached shell otherwise.
// Built assets (hashed names) never change: cache first. The API is never cached.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(async () => (await caches.match("/")) || Response.error()),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/") || url.pathname.endsWith(".png") || url.pathname.endsWith(".webmanifest")) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(event.request, copy));
            }
            return res;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Consuls", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Consuls";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
      icon: "/icon-192.png",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  let url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  if (url.origin !== self.location.origin && !ALLOWED_ELSEWHERE.some((p) => url.href.startsWith(p))) url = new URL("/", self.location.origin);
  event.waitUntil(
    (async () => {
      if (url.origin !== self.location.origin) return self.clients.openWindow(url.href);
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin === url.origin) {
          await w.focus();
          w.postMessage({ type: "open", url: url.href });
          return;
        }
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
