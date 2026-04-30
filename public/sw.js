/* eslint-disable no-undef */

// Bulwark service worker.
//
// This SW does two jobs:
//   1. Satisfy the PWA installability requirement (network-only fetch handler,
//      no caching - so we never serve stale chunks after a deployment).
//   2. Receive Web Push wake-up pings from the relay and turn them into
//      enriched system notifications. Mirrors the React Native FCM headless
//      task: relay sends only a state-change ping, the client fetches the
//      newest unread email itself so the relay never sees mail content.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

async function handlePush(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch (_) {
    payload = null;
  }

  const accountLabel = (payload && typeof payload.accountLabel === "string")
    ? payload.accountLabel
    : "";

  // Best effort: ask the webmail to look up the latest unread email so we can
  // build a useful notification. If the request fails (offline, session
  // expired, server down) we fall back to a generic "New mail" so the user
  // still sees something.
  let preview = null;
  try {
    const res = await fetch("/api/push/preview", {
      credentials: "include",
      cache: "no-store",
    });
    if (res.ok) {
      preview = await res.json();
    }
  } catch (_) {
    preview = null;
  }

  const email = preview && preview.email ? preview.email : null;
  const unreadTotal = preview && typeof preview.unreadTotal === "number"
    ? preview.unreadTotal
    : 0;

  // The push subscription is scoped to EmailDelivery, but we still see the
  // occasional wake-up that does not correspond to a new unread message
  // (legacy subscription with broader types, races with marking-as-read,
  // verification pings). Without a concrete unread email to surface, stay
  // silent rather than firing a generic "New mail" toast for a non-event.
  if (!email && unreadTotal === 0) {
    return;
  }

  let title;
  let body;
  let tag = "bulwark-mail";
  let data = { kind: "mail-list" };

  if (email) {
    const sender = email.from && email.from[0];
    const senderName = (sender && sender.name) || (sender && sender.email) || "New mail";
    title = senderName + (accountLabel ? ` (${accountLabel})` : "");
    body = email.subject || email.preview || "(no subject)";
    tag = "bulwark-mail:" + email.id;
    data = {
      kind: "email",
      emailId: email.id,
      threadId: email.threadId,
    };
  } else {
    title = accountLabel ? `New mail (${accountLabel})` : "New mail";
    body = unreadTotal > 1 ? `${unreadTotal} unread messages` : "You have new mail";
  }

  await self.registration.showNotification(title, {
    body,
    tag,
    icon: "/icon-192x192.png",
    badge: "/icon-192x192.png",
    data,
    renotify: true,
  });
}

async function handleNotificationClick(event) {
  const data = event.notification.data || {};
  const targetUrl = buildClickUrl(data);

  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  for (const client of allClients) {
    // Reuse an existing tab whenever possible - users on desktop browsers
    // get annoyed when each notification opens a fresh window.
    if ("focus" in client) {
      try {
        if ("navigate" in client && targetUrl) {
          await client.navigate(targetUrl);
        }
        return client.focus();
      } catch (_) {
        // navigate() can reject for cross-origin or detached clients - fall
        // through and open a new window below.
      }
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(targetUrl || "/");
  }
}

function buildClickUrl(data) {
  if (!data) return "/";
  if (data.kind === "email" && data.emailId) {
    return `/?email=${encodeURIComponent(data.emailId)}`;
  }
  return "/";
}
