// Consuls' service worker: shows the push daemon's notifications, and opens the app (at the
// pane) when one is tapped. Every push must show a notification: iOS drops subscriptions that
// receive silent ones.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      // Somewhere else (e.g. Tailscale's SSH approval page): just open it.
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
