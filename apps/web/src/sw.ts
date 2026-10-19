import { precacheAndRoute } from "workbox-precaching";
import { offlineFallback } from "workbox-recipes";

type PushPayload = { title?: string; body?: string; tag?: string; linkPath?: string | null };
type ClientLike = { focus?: () => Promise<unknown>; postMessage: (msg: unknown) => void };
type PushEventLike = { data?: { json: () => PushPayload }; waitUntil: (p: Promise<unknown>) => void };
type NotificationClickEventLike = { notification: { close: () => void; data?: { linkPath?: string } }; waitUntil: (p: Promise<unknown>) => void };

declare const self: {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
  registration: { showNotification: (title: string, options: { body?: string; icon?: string; badge?: string; tag?: string; data?: unknown }) => Promise<void> };
  clients: { matchAll: (opts: { type: string; includeUncontrolled: boolean }) => Promise<ClientLike[]>; openWindow: (url: string) => Promise<unknown> };
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: NotificationClickEventLike) => void): void;
};

precacheAndRoute(self.__WB_MANIFEST);

offlineFallback({ pageFallback: "/offline.html" });

self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* non-JSON or empty payload — fall back to generic text */ }
  const title = payload.title ?? "Household update";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body ?? "",
    icon: "/pwa-192x192.png",
    badge: "/pwa-192x192.png",
    tag: payload.tag ?? "reminder-notification",
    data: { linkPath: payload.linkPath ?? "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const linkPath = event.notification.data?.linkPath ?? "/";
  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const client = allClients.find((c) => typeof c.focus === "function");
    if (client?.focus) {
      await client.focus();
      client.postMessage({ type: "notification-click", linkPath });
    } else {
      await self.clients.openWindow(linkPath);
    }
  })());
});
