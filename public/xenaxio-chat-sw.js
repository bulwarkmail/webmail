/* eslint-disable no-undef */

// xenaxio, step 43 part C: push for the team chat.
//
// A registration of its own (scope <base>/__xenaxio-chat-push/), separate from
// Bulwark's sw.js: a registration holds one push subscription, and Bulwark's
// belongs to its mail relay. No page lives under that scope, so this worker
// only receives pushes and notification clicks.
//
// The platform's push gateway sends an encrypted, short payload:
//   { kind: "xenaxio-chat", roomId, eventId, title, body, unread, important }
// The page registers this file as xenaxio-chat-sw.js?locale=de so a click
// opens the chat in the user's language.

const SCRIPT_URL = new URL(self.location.href);
const BASE_PATH = SCRIPT_URL.pathname.replace(/[^/]*$/, "").replace(/\/+$/, "");
const LOCALE = /^[a-z]{2}$/.test(SCRIPT_URL.searchParams.get("locale") || "") ? SCRIPT_URL.searchParams.get("locale") : "de";
const CHAT_PATH = `${BASE_PATH}/${LOCALE}/chat/`;
// Step 67: on XenRooms (xenrooms.app) its own icon; a notification says whose
// it is (several companies in one browser), and a click opens that company.
const ROOMS = SCRIPT_URL.searchParams.get("app") === "rooms";
const ICON = ROOMS ? `${BASE_PATH}/xenrooms/icon-192.png` : `${BASE_PATH}/api/pwa-icon/192`;
const ACCOUNT = /^[0-9a-f-]{36}$/i;
// The account open in the chat window (the page tells us). Unknown after the
// worker restarts: then every company's notification shows.
let openAccount = "";

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.kind === "xenaxio-chat-account" && typeof data.account === "string" && ACCOUNT.test(data.account)) openAccount = data.account;
});

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleClick(event.notification.data || {}));
});

/** Is this window the chat section (not the admin page under /workspace/chat)? */
function isChatWindow(client) {
  try {
    const path = new URL(client.url).pathname.slice(BASE_PATH.length);
    return /^\/[a-z]{2}\/chat(\/|$)/.test(path);
  } catch (_) {
    return false;
  }
}

async function windows() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

async function handlePush(event) {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch (_) {
    data = null;
  }
  // Step 49: the result of a scheduled task of the assistant.
  if (data && data.kind === "xenaxio-assistant") return showAssistant(data);
  // Step 124 C: a notice of Xenaxio (a task assigned, a mention, a due date).
  if (data && data.kind === "xenaxio-notice") return showNotice(data);
  if (!data || data.kind !== "xenaxio-chat") return;

  const open = await windows();
  // With no page open, the app icon shows the chat's count; an open page
  // keeps the badge itself (mail and chat together).
  if (open.length === 0 && typeof data.unread === "number" && self.navigator.setAppBadge) {
    try {
      if (data.unread > 0) await self.navigator.setAppBadge(data.unread);
      else await self.navigator.clearAppBadge();
    } catch (_) {
      // Badging is optional.
    }
  }

  // Someone reading the chat right now on this device needs no ping (like Slack);
  // on XenRooms only for the company that is open there.
  const sameAccount = !ROOMS || !data.account || data.account === openAccount;
  if (sameAccount && open.some((c) => c.focused && c.visibilityState === "visible" && isChatWindow(c))) return;

  const title = typeof data.title === "string" && data.title ? data.title : "Rooms";
  // Step 99: the person may hide the text (only who wrote where) and turn the sound off.
  const body = data.hidden === true ? (LOCALE === "de" ? "Neue Nachricht" : "New message") : typeof data.body === "string" ? data.body : "";
  await self.registration.showNotification(title, {
    body,
    silent: data.silent === true,
    // One notification per channel: a new message replaces the older one.
    tag: `xenaxio-chat:${data.roomId || ""}`,
    renotify: true,
    icon: ICON,
    badge: ICON,
    data: { roomId: data.roomId || "", eventId: data.eventId || "", account: typeof data.account === "string" && ACCOUNT.test(data.account) ? data.account : "" },
  });
}

/** Step 49: one notification per scheduled task; a click opens its chat in the assistant. */
async function showAssistant(data) {
  // Step 85: a connected AI chat waits for the user's confirmation; a click opens the waiting calls.
  const id = data.waiting === true ? "waiting" : typeof data.conversationId === "string" ? data.conversationId : "";
  if (id !== "waiting" && !/^[0-9a-f-]{36}$/i.test(id)) return;
  await self.registration.showNotification(typeof data.title === "string" && data.title ? data.title : "Assistent", {
    body: typeof data.body === "string" ? data.body : "",
    tag: `xenaxio-assistant:${id}`,
    renotify: true,
    icon: ICON,
    badge: ICON,
    data: { assistant: id },
  });
}

/** Step 124 C: a click opens the notice's page (a path inside the app, e.g. a task). */
async function showNotice(data) {
  const link = typeof data.link === "string" && /^\/[a-z][a-z0-9/_-]*\/?(\?[A-Za-z0-9=&%._~-]*)?$/.test(data.link) ? data.link : "";
  if (!link) return;
  await self.registration.showNotification(typeof data.title === "string" && data.title ? data.title : "Xenaxio", {
    body: typeof data.body === "string" ? data.body : "",
    tag: `xenaxio-notice:${link}`,
    renotify: true,
    icon: ICON,
    badge: ICON,
    data: { notice: link },
  });
}

async function openNotice(link) {
  const target = `${BASE_PATH}/${LOCALE}${link}`;
  for (const client of await windows()) {
    try {
      const focused = await client.focus();
      focused.postMessage({ kind: "xenaxio-chat-navigate", url: target });
      return;
    } catch (_) {
      // Next window, or a new one below.
    }
  }
  if (self.clients.openWindow) await self.clients.openWindow(target);
}

async function handleClick(data) {
  if (data.assistant) return openAssistant(data.assistant);
  if (data.notice) return openNotice(data.notice);
  const query = new URLSearchParams();
  if (data.roomId) query.set("room", data.roomId);
  if (data.eventId) query.set("event", data.eventId);
  if (data.account) query.set("as", data.account);
  const target = `${CHAT_PATH}${query.toString() ? `?${query}` : ""}`;
  const open = await windows();

  // A chat window: bring it forward and let the page switch the channel, no reload.
  const chat = open.find(isChatWindow);
  if (chat) {
    try {
      // Focus first: navigating spends the click's user activation (see sw.js).
      const focused = await chat.focus();
      focused.postMessage({ kind: "xenaxio-chat-open", roomId: data.roomId || "", eventId: data.eventId || "", account: data.account || "" });
      return;
    } catch (_) {
      // Fall through.
    }
  }

  // Another window of the app (mail, files): bring it forward and let the page
  // go to the chat. navigate() would not work: those windows belong to sw.js.
  for (const client of open) {
    try {
      const focused = await client.focus();
      focused.postMessage({ kind: "xenaxio-chat-navigate", url: target });
      return;
    } catch (_) {
      // Next window, or a new one below.
    }
  }

  if (self.clients.openWindow) await self.clients.openWindow(target);
}

/** Step 49: brings a window of the app forward and opens the chat there, else a new window. */
async function openAssistant(id) {
  const target = `${BASE_PATH}/${LOCALE}/mail/?assistant=${encodeURIComponent(id)}`;
  for (const client of await windows()) {
    try {
      const focused = await client.focus();
      focused.postMessage({ kind: "xenaxio-chat-navigate", url: target });
      return;
    } catch (_) {
      // Next window, or a new one below.
    }
  }
  if (self.clients.openWindow) await self.clients.openWindow(target);
}
