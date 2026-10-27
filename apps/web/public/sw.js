// Two-Key service worker: shows approval pushes and opens the approval screen on tap.
// The payload is { title, body, url } from the gateway (apps/gateway/src/services/push.ts).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** Only same-origin paths are opened, whatever the payload says. */
function safePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return '/approvals';
  return url;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' ? data.title : 'A purchase is waiting for you';
  const body = typeof data.body === 'string' ? data.body : 'Open Two-Key to approve or deny it.';
  const url = safePath(data.url);
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: url,
      renotify: true,
      requireInteraction: true,
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url === target && 'focus' in client) return client.focus();
      }
      // Reuse an open Two-Key window if there is one; otherwise open a new one.
      const any = windows.find((c) => 'navigate' in c);
      if (any) {
        await any.navigate(target);
        return any.focus();
      }
      return self.clients.openWindow(target);
    })(),
  );
});
