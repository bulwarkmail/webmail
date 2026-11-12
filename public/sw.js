/* eslint-disable no-undef */

// Bulwark service worker.
//
// This SW does two jobs:
//   1. Satisfy the PWA installability requirement (a fetch handler that
//      leaves every request to the network).
//   2. Receive Web Push wake-up pings from the relay and turn them into
//      enriched system notifications. Mirrors the React Native FCM headless
//      task: relay sends only a state-change ping, the client fetches the
//      newest unread email itself so the relay never sees mail content.
//
// Builds (#523): the page registers sw.js?v=<build id>, so every deploy
// installs a new worker that knows its build. Anything it caches goes into
// caches named after that build (bulwark-shell-<build id>), never into one
// cache that outlives a deploy, so a tab is never handed chunks of another
// build. A build's cache is deleted once no open tab runs that build.

// When the app is mounted at a subpath (Next.js basePath, e.g. /webmail), the
// SW is served at /webmail/sw.js and registered with scope /webmail/. Derive
// the prefix from the SW's own URL so push fetches and notification clicks
// land on the right path - service workers can't read process.env.
function getBasePath() {
  const path = new URL(self.location.href).pathname;
  // self.location is .../sw.js; strip the trailing filename to get the dir,
  // then strip the trailing slash so it concatenates cleanly with `/foo`.
  const dir = path.replace(/[^/]*$/, "");
  return dir.replace(/\/+$/, "");
}

const BASE_PATH = getBasePath();
const MAILTO_CLIENTS = new Map();

// The build this worker came with (the ?v= the page registered it with).
const BUILD_ID = new URL(self.location.href).searchParams.get("v") || "unversioned";
const SHELL_CACHE_PREFIX = "bulwark-shell-";
const SHELL_CACHE = SHELL_CACHE_PREFIX + BUILD_ID;
// What the worker has to remember across restarts and across builds: which
// build each open tab runs. In the Cache API like the push state, under its
// own name.
const SW_STATE_CACHE = "bulwark-sw-state-v1";
const CLIENT_BUILDS_KEY = "/__bulwark/client-builds";

const OFFLINE_SHELL_KEY = "/__bulwark/offline-shell";

self.addEventListener("install", (event) => {
  // With offline mode on, a tab may load a chunk of its build at any time,
  // from this worker's caches. A new build's worker waits until those tabs
  // are gone or a tab asks it to take over: its "Reload", or a tab that
  // runs the new build already (lib/app-update.ts adoptWaitingWorker). The
  // old build's tabs keep their files then too: its cache stays while they
  // are open, and chunks are answered from every build's cache. Without
  // offline mode nothing is cached and it takes over at once, as it always
  // did.
  event.waitUntil(readOfflineShell().then((on) => {
    if (!on) return self.skipWaiting();
    return self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((open) => {
      if (open.length === 0) return self.skipWaiting();
      return undefined;
    });
  }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([self.clients.claim(), deleteStaleShellCaches(), sweepHandoffsOnActivate()]));
});

// ---- Offline mode (#523): the app shell ----
//
// Only while a tab turned offline mode on (Settings > Offline). Then:
// - pages of the app: network first; the answer is kept in this build's
//   cache, and used when the network fails;
// - /_next/static/: content-hashed files, from any build's cache first
//   (an open tab of an older build still finds its chunks), else the
//   network, kept in this build's cache;
// - /api/config: network first, the last answer when offline.
// Everything else, and everything while offline mode is off, goes to the
// network untouched.

// null until read from the state cache; true or false after.
let offlineShellOn = null;

async function readOfflineShell() {
  if (offlineShellOn !== null) return offlineShellOn;
  try {
    const cache = await caches.open(SW_STATE_CACHE);
    const response = await cache.match(OFFLINE_SHELL_KEY);
    const data = response ? await response.json() : null;
    offlineShellOn = !!(data && data.on === true);
  } catch (_) {
    offlineShellOn = false;
  }
  return offlineShellOn;
}

async function writeOfflineShell(on) {
  offlineShellOn = on;
  try {
    const cache = await caches.open(SW_STATE_CACHE);
    await cache.put(OFFLINE_SHELL_KEY, new Response(JSON.stringify({ on }), { headers: { "Content-Type": "application/json" } }));
  } catch (_) {
    // No Cache API: nothing is cached either.
  }
}

// Read at start, so the fetch handler mostly knows synchronously.
if (typeof caches !== "undefined" && caches && typeof caches.open === "function") {
  readOfflineShell();
}

const APP_SECTIONS = new Set(["", "mail", "settings", "calendar", "contacts", "files", "pro", "apps", "protocol", "popout"]);

/** The page path inside the app ("/mail/inbox"), or null for anything that isn't a page of the app. */
function appPagePath(url) {
  if (url.origin !== self.location.origin) return null;
  let path = url.pathname;
  if (BASE_PATH) {
    if (path !== BASE_PATH && !path.startsWith(BASE_PATH + "/")) return null;
    path = path.slice(BASE_PATH.length) || "/";
  }
  const parts = path.split("/").filter(Boolean);
  // An optional locale segment (/de/mail, /zh-TW/settings).
  if (parts.length > 0 && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(parts[0]) && !APP_SECTIONS.has(parts[0])) parts.shift();
  return APP_SECTIONS.has(parts[0] || "") ? "/" + parts.join("/") : null;
}

function staticPath(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith(BASE_PATH + "/_next/static/")) return true;
  // The local store's engine: named by build (?v=) and by version, so it can be
  // kept like a hashed file, and an offline start needs it.
  return url.pathname === BASE_PATH + "/store-worker.js" || url.pathname.startsWith(BASE_PATH + "/sqlite3mc/");
}

/** Where a page of the app is kept: its address without the query. */
function documentKey(url) {
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** A page the cache has for this address: the page itself, its section, the app's start page. */
async function cachedDocument(url) {
  const path = appPagePath(url) || "/";
  const section = "/" + (path.split("/").filter(Boolean)[0] || "");
  const appRoot = self.location.origin + BASE_PATH;
  // A pop-out has no section page, and the start page would put the whole app
  // into its window. Its own kind of page reads the id from the address bar.
  const candidates = section === "/popout"
    ? [documentKey(url), appRoot + (path.startsWith("/popout/message/") ? "/popout/message/_" : "/popout/compose")]
    : [documentKey(url), appRoot + (section === "/" ? "" : section), appRoot];
  // Only looked into when it exists: opening it would create it again
  // after the next build's worker deleted it.
  if (await caches.has(SHELL_CACHE)) {
    const own = await caches.open(SHELL_CACHE);
    for (const key of candidates) {
      const hit = await own.match(key);
      if (hit) return hit;
    }
  }
  for (const key of candidates) {
    const hit = await caches.match(key);
    if (hit) return hit;
  }
  return null;
}

/**
 * The cache of the build that answered (the X-Bulwark-Build header): after a
 * deploy the old worker still fetches the new build's pages and chunks, which
 * belong in the new build's cache, not in its own.
 */
function shellCacheFor(response) {
  const build = response.headers.get("x-bulwark-build") || "";
  return /^[\w.-]{1,80}$/.test(build) ? SHELL_CACHE_PREFIX + build : SHELL_CACHE;
}

async function respondWithDocument(request) {
  const url = new URL(request.url);
  try {
    const response = await fetch(request);
    const type = response.headers.get("content-type") || "";
    if (response.ok && response.type === "basic" && !response.redirected && type.includes("text/html")) {
      const copy = response.clone();
      caches.open(shellCacheFor(response)).then((cache) => cache.put(documentKey(url), copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const hit = await cachedDocument(url);
    if (hit) return hit;
    throw error;
  }
}

async function respondWithStatic(request) {
  const hit = await caches.match(request.url);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const copy = response.clone();
    caches.open(shellCacheFor(response)).then((cache) => cache.put(request.url, copy)).catch(() => {});
  }
  return response;
}

async function respondWithConfig(request) {
  const key = self.location.origin + BASE_PATH + "/api/config";
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      // Like pages and chunks, under the build that answered: right after a
      // deploy this worker still fetches for the new build's tab.
      caches.open(shellCacheFor(response)).then((cache) => cache.put(key, copy)).catch(() => {});
    }
    return response;
  } catch (error) {
    const hit = await caches.match(key);
    if (hit) return hit;
    throw error;
  }
}

function offlineRoute(request) {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (request.mode === "navigate" && appPagePath(url) !== null) return respondWithDocument;
  // The app lock asks whether a reload would land anywhere, and has to hear what a reload would.
  if (request.headers.get("x-bulwark-reload-probe") && appPagePath(url) !== null) return respondWithDocument;
  if (staticPath(url)) return respondWithStatic;
  if (url.origin === self.location.origin && url.pathname === BASE_PATH + "/api/config") return respondWithConfig;
  return null;
}

/**
 * Keeps the files a tab names (its build's shell) in that build's cache. The
 * tab may run a newer build than this worker (right after a deploy).
 */
async function precacheShell(urls, buildId) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const name = typeof buildId === "string" && /^[\w.-]{1,80}$/.test(buildId) ? SHELL_CACHE_PREFIX + buildId : SHELL_CACHE;
  const cache = await caches.open(name);
  const wanted = urls.filter((u) => typeof u === "string");
  for (let i = 0; i < wanted.length; i += 8) {
    await Promise.all(wanted.slice(i, i + 8).map(async (u) => {
      try {
        const url = new URL(u, self.location.origin);
        if (url.origin !== self.location.origin) return;
        const key = appPagePath(url) !== null && !staticPath(url) ? documentKey(url) : url.href;
        if (await cache.match(key)) return;
        const response = await fetch(url.href, { credentials: "same-origin" });
        if (response.ok && response.type === "basic" && !response.redirected) await cache.put(key, response);
      } catch (_) {
        // Fetched again when the page asks next time.
      }
    }));
  }
}

async function setOfflineShell(on, urls, buildId) {
  await writeOfflineShell(on);
  if (on) {
    await precacheShell(urls, buildId);
    return;
  }
  // Off: nothing of the shell stays.
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX)).map((key) => caches.delete(key)));
}

async function readClientBuilds() {
  try {
    const cache = await caches.open(SW_STATE_CACHE);
    const response = await cache.match(CLIENT_BUILDS_KEY);
    const data = response ? await response.json() : null;
    return data && typeof data === "object" ? data : {};
  } catch (_) {
    return {};
  }
}

async function writeClientBuilds(map) {
  try {
    const cache = await caches.open(SW_STATE_CACHE);
    await cache.put(CLIENT_BUILDS_KEY, new Response(JSON.stringify(map), { headers: { "Content-Type": "application/json" } }));
  } catch (_) {
    // Without the Cache API nothing was cached either.
  }
}

/** Notes which build an open tab runs, and forgets tabs that are gone. */
async function recordClientBuild(clientId, buildId) {
  if (!clientId || typeof buildId !== "string" || !buildId) return;
  const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const openIds = new Set(open.map((c) => c.id));
  const map = await readClientBuilds();
  const next = {};
  for (const [id, build] of Object.entries(map)) if (openIds.has(id)) next[id] = build;
  next[clientId] = buildId;
  await writeClientBuilds(next);
}

/**
 * Deletes the shell caches of builds no open tab runs any more. This
 * worker's own build is kept, and so is every build a tab still runs: such a
 * tab may still load a chunk of its build after a deploy, and the new build
 * no longer has it.
 */
async function deleteStaleShellCaches() {
  if (typeof caches === "undefined" || typeof caches.keys !== "function") return;
  try {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const openIds = new Set(open.map((c) => c.id));
    const map = await readClientBuilds();
    const inUse = new Set([BUILD_ID]);
    for (const [id, build] of Object.entries(map)) if (openIds.has(id)) inUse.add(build);
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && !inUse.has(key.slice(SHELL_CACHE_PREFIX.length)))
      .map((key) => caches.delete(key)));
  } catch (_) {
    // Tried again at the next activation.
  }
}

// ---- Share target: what the OS shares goes into a new draft ----
//
// The manifest's share_target POSTs here. Files can't travel through a
// redirect, so they wait in the Cache API until the page takes them (same
// layout and limits as lib/launch-handoff.ts, which also removes them). Any
// site can POST here, signed in or not, and the worker can't tell who did: the
// page asks the user. So what is kept is limited, and sealed with a key that
// only the landing address's fragment knows. A browser without share_target
// gets the same question. Without a worker the POST reaches
// app/(main)/protocol/share/route.ts.
const HANDOFF_CACHE = "bulwark-launch-handoff-v1";
const HANDOFF_TTL_MS = 15 * 60 * 1000;
const HANDOFF_MAX_ENTRIES = 5;
const HANDOFF_MAX_BYTES = 100 * 1024 * 1024;

function isShareTarget(request) {
  // A document only: a hidden frame doesn't get to store anything.
  if (request.method !== "POST" || request.mode !== "navigate" || request.destination !== "document") return false;
  const url = new URL(request.url);
  return url.origin === self.location.origin && url.pathname.replace(/\/+$/, "") === BASE_PATH + "/protocol/share";
}

/** Drops what is too old and, when `incomingBytes` wants in, the oldest entries in the way. */
async function sweepHandoffs(cache, incomingBytes) {
  const keys = await cache.keys();
  const pathOf = (key) => new URL(key.url, self.location.origin).pathname;
  const entries = [];
  for (const key of keys) {
    const path = pathOf(key);
    if (!path.endsWith("/meta")) continue;
    const response = await cache.match(key);
    const meta = response ? await response.json().catch(() => null) : null;
    entries.push({ prefix: path.slice(0, -"meta".length), createdAt: (meta && meta.createdAt) || 0, bytes: (meta && meta.bytes) || 0 });
  }
  entries.sort((a, b) => a.createdAt - b.createdAt);
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  while (entries.length > 0) {
    const tooOld = Date.now() - entries[0].createdAt > HANDOFF_TTL_MS;
    const inTheWay = incomingBytes !== null && (entries.length >= HANDOFF_MAX_ENTRIES || total + incomingBytes > HANDOFF_MAX_BYTES);
    if (!tooOld && !inTheWay) break;
    const oldest = entries.shift();
    total -= oldest.bytes;
    const own = keys.filter((key) => pathOf(key).startsWith(oldest.prefix));
    // The list last: this sweep goes by it.
    await Promise.all(own.filter((key) => !pathOf(key).endsWith("/meta")).map((key) => cache.delete(key)));
    await cache.delete(oldest.prefix + "meta");
  }
}

async function sweepHandoffsOnActivate() {
  try {
    if (typeof caches === "undefined" || !(await caches.has(HANDOFF_CACHE))) return;
    await sweepHandoffs(await caches.open(HANDOFF_CACHE), null);
  } catch (_) {
    // Tried again at the next share.
  }
}

/** A 12-byte IV, then the AES-GCM ciphertext. */
async function sealHandoff(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const sealed = new Uint8Array(iv.length + body.length);
  sealed.set(iv);
  sealed.set(body, iv.length);
  return sealed;
}

/** As much of `value` as takes up to `budget` bytes once encoded, as in the server's fallback. */
function fitEncoded(value, budget, flags) {
  let used = 0;
  let out = "";
  for (const character of value) {
    try {
      used += encodeURIComponent(character).length;
    } catch (_) {
      continue;
    }
    if (used > budget) {
      flags.cut = true;
      return out;
    }
    out += character;
  }
  return out;
}

async function receiveShare(request) {
  // In the fragment: it stays out of access logs, and the key out of the server's sight.
  const land = (params) => Response.redirect(self.location.origin + BASE_PATH + "/#" + new URLSearchParams(params), 303);
  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return land({ share: "unavailable", share_files: "1" });
  }
  const field = (name) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  const shared = { title: field("title"), text: field("text"), url: field("url") };
  const files = form.getAll("files").filter((file) => typeof file !== "string" && file.size > 0);
  const id = crypto.randomUUID();
  const prefix = "/__bulwark/handoff/" + id + "/";
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  let cache = null;
  try {
    if (bytes > HANDOFF_MAX_BYTES) throw new Error("too large");
    cache = await caches.open(HANDOFF_CACHE);
    await sweepHandoffs(cache, bytes);
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
    const contents = JSON.stringify({ ...shared, files: files.map((file) => ({ name: file.name, type: file.type })) });
    // The list first: the sweep goes by it.
    await cache.put(prefix + "meta", new Response(JSON.stringify({ kind: "compose", createdAt: Date.now(), bytes })));
    await cache.put(prefix + "sealed", new Response(await sealHandoff(key, new TextEncoder().encode(contents))));
    for (let index = 0; index < files.length; index += 1) {
      await cache.put(prefix + index, new Response(await sealHandoff(key, await files[index].arrayBuffer())));
    }
    const encodedKey = btoa(String.fromCharCode(...rawKey)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return land({ share: id, key: encodedKey });
  } catch (_) {
    // No room for the files. The text can still come along in the address.
    if (cache) await Promise.all([...files.map((_file, index) => cache.delete(prefix + index)), cache.delete(prefix + "sealed"), cache.delete(prefix + "meta")]).catch(() => {});
    const flags = { cut: false };
    const title = fitEncoded(shared.title, 400, flags);
    const text = fitEncoded(shared.text, 1800, flags);
    const link = fitEncoded(shared.url, 1000, flags);
    return land({
      share: "unavailable",
      share_title: title,
      share_text: text,
      share_url: link,
      ...(files.length > 0 ? { share_files: "1" } : {}),
      ...(flags.cut ? { share_cut: "1" } : {}),
    });
  }
}

self.addEventListener("fetch", (event) => {
  if (isShareTarget(event.request)) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  // Offline mode off (known): the network, untouched, as without a worker.
  if (offlineShellOn === false) return;
  const route = offlineRoute(event.request);
  if (!route) return;
  if (offlineShellOn === true) {
    event.respondWith(route(event.request));
    return;
  }
  // Not read yet (the worker just started): decide once it is.
  event.respondWith(readOfflineShell().then((on) => (on ? route(event.request) : fetch(event.request))));
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(handleNotificationClick(event));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(handlePushSubscriptionChange(event));
});

// Background Sync, thin: this worker has no login and can't reach the outbox,
// so it tells the open tabs to flush theirs. With no tab open, the next one
// flushes when it starts.
self.addEventListener("sync", (event) => {
  if (event.tag !== OUTBOX_SYNC_TAG) return;
  event.waitUntil(tellClientsToFlushOutbox());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "client-build") {
    event.waitUntil(recordClientBuild(event.source && event.source.id, data.buildId).then(deleteStaleShellCaches));
    return;
  }
  if (data.type === "client-logins") {
    event.waitUntil(recordClientLogins(event.source && event.source.id, data.logins));
    return;
  }
  if (data.type === "app-lock") {
    const clientId = event.source && event.source.id;
    event.waitUntil(queueAppLockStep(() => writeAppLockState(data.state, clientId, data.at)));
    return;
  }
  if (data.type === "offline-shell") {
    // The switch is kept before the event ends. The shell's files are
    // fetched without holding the event open: a worker busy with an event
    // can't hand over to a new build's worker, and the fetch is tried again
    // whenever a tab asks.
    // A tab that passed a port hears when the shell is kept (lib/offline/shell.ts).
    const port = event.ports && event.ports[0];
    const reply = () => {
      try {
        if (port) port.postMessage({ type: "offline-shell-kept" });
      } catch (_) {
        // The tab went.
      }
    };
    if (data.on !== true) {
      event.waitUntil(setOfflineShell(false).then(reply, reply));
      return;
    }
    event.waitUntil(writeOfflineShell(true));
    setOfflineShell(true, data.urls, data.buildId).catch(() => {}).then(reply);
    return;
  }
  if (data.type === "skip-waiting") {
    // The tab's "Reload" for a new build: take over now instead of waiting
    // for every tab of the old build to close.
    self.skipWaiting();
    return;
  }
  if (data.type === "mailto-client-ready") {
    if (event.source && event.source.id) {
      MAILTO_CLIENTS.set(event.source.id, {
        path: typeof data.path === "string" ? data.path : "",
        standalone: data.standalone === true,
        clientId: typeof data.clientId === "string" ? data.clientId : "",
        focusNotificationTitle: typeof data.focusNotificationTitle === "string" ? data.focusNotificationTitle : "",
        focusNotificationBody: typeof data.focusNotificationBody === "string" ? data.focusNotificationBody : "",
      });
    }
    return;
  }

  if (data.type === "mailto-client-gone") {
    if (event.source && event.source.id) {
      const current = MAILTO_CLIENTS.get(event.source.id);
      if (!current
        || (typeof data.clientId === "string" && current.clientId === data.clientId)
        || (typeof data.clientId !== "string" && typeof data.path === "string" && current.path === data.path)) {
        MAILTO_CLIENTS.delete(event.source.id);
      }
    }
    return;
  }

  if (data.type === "open-mailto-in-client") {
    event.waitUntil(handleOpenMailtoInClient(event));
    return;
  }

  if (data.type === "focus-existing-mailto-client") {
    event.waitUntil(focusExistingWindowClient(event.source && event.source.id, true));
    return;
  }

  if (data.type !== "focus-existing-client") return;

  event.waitUntil(focusExistingWindowClient(event.source && event.source.id));
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

  // Two payload shapes reach us from the relay:
  //   - "jmap-email-push": the server evaluated our per-account delivery
  //     filter (draft-ietf-jmap-emailpush) and this is a list of the new
  //     message ids that passed it - spam filed into Junk never gets here.
  //   - "jmap-state-change" (older servers): a bare EmailDelivery ping wrapped
  //     as { changed: { [accountId]: {...} } }, fired for every ingested
  //     message including junk. Stalwart batches what changes between two
  //     pushes, so it can name the user's own account and a group's at once.
  const changed = payload && payload.changed && typeof payload.changed === "object"
    ? payload.changed
    : null;
  const named = (payload && typeof payload.accountId === "string" && payload.accountId)
    || (changed ? Object.keys(changed)[0] || "" : "");
  const emailIds = payload && Array.isArray(payload.emailIds)
    ? payload.emailIds.filter((id) => typeof id === "string" && id)
    : [];

  const withNewMail = emailIds.length > 0 || !changed
    ? []
    : Object.keys(changed).filter((id) => changed[id] && typeof changed[id] === "object" && "EmailDelivery" in changed[id]);
  // Previews still on their way after their notification was shown.
  const lingering = [];
  // Side by side: each has its own preview deadline, and Safari wants the
  // notifications within 30 s of the push.
  await Promise.all((withNewMail.length > 0 ? withNewMail : [named]).map(async (accountId) => {
    try {
      await notifyAccount(accountId, emailIds, accountLabel, lingering);
    } catch (_) {
      // Nothing above may cost the user the alert, or a browser its quota for
      // this site: see showWithoutAlert.
      await self.registration.showNotification(accountLabel ? `New mail (${accountLabel})` : "New mail", {
        body: "You have new mail",
        tag: "bulwark-mail:" + (accountId || "default"),
        icon: `${BASE_PATH}/api/pwa-icon/192`,
        badge: `${BASE_PATH}/api/pwa-icon/192`,
        data: { kind: "mail-list", accountId },
      });
    }
  }));
  // The push event lasts until they answer, so their cookies land.
  await Promise.allSettled(lingering);
}

async function notifyAccount(accountId, emailIds, accountLabel, lingering = []) {
  // Never notify twice for the same message. A push can be redelivered (relay
  // retry, browser replay after coming back online) and, on the older
  // state-change path, a junk delivery wakes us while an unread message we
  // already announced is still sitting in the Inbox - without this we would
  // re-buzz for that old message.
  const notified = await readNotifiedIds(accountId);
  const freshIds = emailIds.filter((id) => !notified.includes(id));
  const groupTag = "bulwark-mail:" + (accountId || "default");
  if (emailIds.length > 0 && freshIds.length === 0) {
    await showWithoutAlert(groupTag);
    return;
  }

  // Email notifications off, or do not disturb on: a browser still wants a
  // notification for the push, so one comes and goes with nothing on it.
  if (!(await showPreference(accountLabel))) {
    if (freshIds.length > 0) await writeNotifiedIds(accountId, notified.concat(freshIds));
    await showWithoutAlert(groupTag);
    return;
  }

  // Best effort: ask the webmail to look up the email so we can build a useful
  // notification. With ids from the server we ask for exactly the newest of
  // them; otherwise the API falls back to the newest unread Inbox message. If
  // the request fails (offline, session expired, server down) we fall back to
  // a generic "New mail" so the user still sees something.
  let preview = null;
  let previewOk = false;
  // No login in this browser could read the account, not even after the route
  // renewed its token: signed out, or the sign-in can't be renewed from here.
  let previewSignedOut = false;
  // Locked: not a word about the message, so it isn't even looked up.
  const lockHidesContent = await appLockHidesContent();
  if (!lockHidesContent) try {
    const query = new URLSearchParams();
    if (accountId) query.set("accountId", accountId);
    // The relay record's label is the login that registered. Account and message
    // ids repeat across logins, and this tells them apart.
    if (accountLabel) query.set("login", accountLabel);
    if (freshIds.length > 0) query.set("emailId", freshIds[freshIds.length - 1]);
    const qs = query.toString();
    const previewUrl = `${BASE_PATH}/api/push/preview${qs ? `?${qs}` : ""}`;
    // A notification shown more than 30 s after the push counts as a silent
    // push in Safari (#1322), so a slow preview gives way to the generic one.
    // The request goes on: an answer that renewed the login's token carries the
    // rotated refresh token in its cookies, and a browser that never sees them
    // keeps one the provider has spent (#1509). It is called off only at a
    // limit of its own.
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const abandon = controller ? setTimeout(() => controller.abort(), PREVIEW_ABANDON_MS) : null;
    let deadlineTimer = null;
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve(PREVIEW_LATE), PREVIEW_DEADLINE_MS);
    });
    const request = fetch(previewUrl, {
      credentials: "include",
      cache: "no-store",
      ...(controller ? { signal: controller.signal } : {}),
    });
    // Cookies are set with the headers, so the answer itself is all it waits for.
    const answered = request.then(() => {}, () => {}).then(() => {
      if (abandon) clearTimeout(abandon);
    });
    try {
      const res = await Promise.race([request, deadline]);
      if (res === PREVIEW_LATE) {
        lingering.push(answered);
      } else if (res.ok) {
        const body = await Promise.race([res.json(), deadline]);
        if (body !== PREVIEW_LATE) {
          preview = body;
          previewOk = true;
        }
      } else if (res.status === 401) {
        previewSignedOut = true;
      }
    } finally {
      clearTimeout(deadlineTimer);
    }
  } catch (_) {
    preview = null;
    previewOk = false;
  }

  const email = preview && preview.email ? preview.email : null;
  const unreadTotal = preview && typeof preview.unreadTotal === "number"
    ? preview.unreadTotal
    : 0;
  // The login (cookie slot) that owns this account, so the click opens the
  // message there and not in whichever account happens to be active.
  const slot = preview && Number.isInteger(preview.slot) ? preview.slot : undefined;
  // Which login that slot held when the message came: an action on this
  // notification must not land on whoever signed into the slot since.
  const login = preview && typeof preview.login === "string" ? preview.login : undefined;

  // Push subscription is scoped to EmailDelivery, but stragglers from the
  // older broader-types subscription, marking-as-read races and verification
  // pings can still wake us with no actual unread mail. When the preview API
  // succeeded and reports zero unread, stay silent. When the preview API
  // failed (network/auth/server down) we cannot tell, so fall through to the
  // generic "New mail" toast rather than miss a real delivery.
  if (previewOk && !email && unreadTotal === 0) {
    await showWithoutAlert(groupTag);
    return;
  }

  // State-change path only (no ids from the server): the newest unread Inbox
  // message is one we already announced, so whatever woke us was not new
  // Inbox mail - typically a delivery into Junk or a Sieve-filed folder.
  if (emailIds.length === 0 && previewOk && email && notified.includes(email.id)) {
    await showWithoutAlert(groupTag);
    return;
  }

  // Group per account under one shared tag so a burst of new mail collapses
  // into a single, self-updating notification instead of one toast per message
  // (Android renders one notification per unique tag, which is why 50 arrivals
  // used to stack 50 toasts). The newest message is the headline and a
  // Gmail-style "+N more" line carries the rest: the messages this notification
  // has announced and the user hasn't dismissed. Mail that was unread before
  // doesn't count, or one new message in a full inbox would say "+40 more" and
  // open the inbox instead of itself.
  const announced = freshIds.length > 0 ? freshIds : (email ? [email.id] : []);
  const ids = Array.from(new Set((await idsOnScreen(groupTag)).concat(announced))).slice(-NOTIFICATION_IDS_LIMIT);
  const more = Math.max(ids.length - 1, 0);
  const oneMessage = email ? { kind: "email", emailId: email.id, threadId: email.threadId, accountId, slot, login, ids } : null;
  let title;
  let body;
  let data = { kind: "mail-list", accountId, slot, ids };

  if (email && preview && preview.redacted) {
    // The organisation keeps sender and subject off notifications
    // (Organisation > Devices): the route sent neither.
    title = accountLabel ? `New mail (${accountLabel})` : "New mail";
    body = more > 0 ? `${ids.length} new messages` : "You have new mail";
    if (more === 0) data = oneMessage;
  } else if (email) {
    const sender = email.from && email.from[0];
    const senderName = (sender && sender.name) || (sender && sender.email) || "New mail";
    title = senderName + (accountLabel ? ` (${accountLabel})` : "");
    body = email.subject || email.preview || "(no subject)";
    if (more > 0) {
      // Several new: this is a group. Keep the newest as the headline, add the
      // "+N more" count, and open the inbox (not one message) on click.
      body += "\n" + (more === 1 ? "+1 more message" : `+${more} more messages`);
    } else {
      // One new message: deep-link straight to it on click.
      data = oneMessage;
    }
  } else {
    title = accountLabel ? `New mail (${accountLabel})` : "New mail";
    body = unreadTotal > 1 ? `${unreadTotal} unread messages` : "You have new mail";
  }

  // Signed out, a push the server sent without message ids may be about mail
  // that came or about some other change, and pushes come for other changes
  // too: ringing for each would ring for nothing, hour after hour (#1509). The
  // generic notification still shows, without a sound. Ids from the server
  // say mail came, and that still rings.
  const unsure = previewSignedOut && freshIds.length === 0;
  // With the sound setting off, nothing rings and no quiet window starts.
  const audible = !unsure && (await soundPreference()) && !(await withinQuietWindow(accountId));
  await showWithActions(title, {
    body,
    // Shared per-account tag: each new push replaces the account's single
    // notification rather than adding another.
    tag: groupTag,
    // Branded app icon via the PWA-icon endpoint (admin-configured, else the
    // built-in default). The static /icon-192x192.png ignored admin branding.
    icon: `${BASE_PATH}/api/pwa-icon/192`,
    badge: `${BASE_PATH}/api/pwa-icon/192`,
    data,
    // Inside the quiet window, or with the sound setting off, the
    // notification still appears or updates, without a sound.
    renotify: audible,
    silent: !audible,
  });

  if (announced.length > 0) {
    await writeNotifiedIds(accountId, notified.concat(announced));
  }
}

const NOTIFICATION_IDS_LIMIT = 100;

/** The messages the account's notification on screen stands for. */
async function idsOnScreen(groupTag) {
  try {
    const shown = (await self.registration.getNotifications({ tag: groupTag }))[0];
    const data = shown && shown.data;
    if (!data) return [];
    if (Array.isArray(data.ids)) return data.ids.filter((id) => typeof id === "string");
    return typeof data.emailId === "string" ? [data.emailId] : [];
  } catch (_) {
    return [];
  }
}

// How long the preview may take before the generic notification is shown.
const PREVIEW_DEADLINE_MS = 10_000;
// How long a preview that missed it may still run, for the cookies it sets.
const PREVIEW_ABANDON_MS = 60_000;
const PREVIEW_LATE = Symbol("preview late");

/**
 * Every push has to end in showNotification. Safari counts a push without one
 * as silent and drops the subscription after three (WebKit maxSilentPushCount);
 * Firefox and Chrome spend a quota or show a notice of their own. A push with
 * nothing new to say (a redelivery, mail already read or already announced)
 * re-shows the account's notification as it is, without a sound. With none on
 * screen, it shows one and takes it away again at once (#1322).
 */
async function showWithoutAlert(groupTag) {
  const options = {
    icon: `${BASE_PATH}/api/pwa-icon/192`,
    badge: `${BASE_PATH}/api/pwa-icon/192`,
    renotify: false,
    silent: true,
  };
  let existing = null;
  try {
    existing = (await self.registration.getNotifications({ tag: groupTag }))[0] || null;
  } catch (_) {
    // Can't tell: treated as none on screen.
  }
  try {
    if (existing) {
      // Shown before a lock the worker didn't hear: again, it says nothing about the message.
      const hidden = await appLockHidesContent();
      const data = existing.data || {};
      await showWithActions(hidden ? "New mail" : existing.title, {
        ...options,
        tag: groupTag,
        body: hidden ? "You have new mail" : existing.body,
        data: hidden ? { kind: "mail-list", accountId: data.accountId, slot: data.slot, ids: data.ids } : existing.data,
      });
      return;
    }
    // Under a tag of its own: a real notification for this account that comes in
    // at the same moment must neither be replaced by this nor closed with it.
    const emptyTag = `${groupTag}:nothing-new`;
    await self.registration.showNotification("New mail", { ...options, tag: emptyTag, data: { kind: "mail-list" } });
    const shown = await self.registration.getNotifications({ tag: emptyTag });
    for (const notification of shown) notification.close();
  } catch (_) {
    // Nothing more a worker can do.
  }
}

// One message often lands in several of the user's accounts at once - a list,
// a forward, the same newsletter on two logins - and each account has its own
// notification. Only the first alert of a burst makes a sound; other accounts'
// alerts within the window show up silently. A second alert for the same
// account still rings, as before. The window runs from the last audible alert
// and is not extended by the silent ones, so a steady trickle still rings
// every so often.
const QUIET_WINDOW_MS = 30_000;

// ---- App lock: while locked a notification says nothing about the message ----
//
// Message content and buttons only when the worker can tell the app is unlocked
// now. Whatever it can't tell counts as locked.

/** The Web Lock the tab with the lock key holds for as long as it lives (lib/app-lock/state.ts). */
const APP_LOCK_HOLDER = "bulwark-app-lock-holder";
/**
 * Set while the last word from a page was that the lock is on. Not in the push state, which
 * a sign-out deletes: with that state gone the lock counts as on until a page says "off".
 */
const APP_LOCK_ON_KEY = "/__bulwark/app-lock-on";

function appLockStateKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/app-lock`;
}

async function rememberAppLockOn(on) {
  try {
    const cache = await caches.open(SW_STATE_CACHE);
    if (on) await cache.put(APP_LOCK_ON_KEY, new Response(JSON.stringify({ on: true }), { headers: { "Content-Type": "application/json" } }));
    else await cache.delete(APP_LOCK_ON_KEY);
  } catch (_) {
    // The state itself is kept; only its loss would go unnoticed.
  }
}

async function appLockWasOn() {
  const cache = await caches.open(SW_STATE_CACHE);
  return !!(await cache.match(APP_LOCK_ON_KEY));
}

async function readAppLockState() {
  const cache = await caches.open(PUSH_STATE_CACHE);
  const res = await cache.match(appLockStateKey());
  return res ? await res.json() : null;
}

// The pages' words on the lock are applied one at a time, in the order they came: a
// write that reads the store first must not land after one that came behind it.
let appLockSteps = Promise.resolve();

function queueAppLockStep(step) {
  const run = appLockSteps.then(step);
  appLockSteps = run.catch(() => {});
  return run;
}

/**
 * Whether a page's word may replace what's stored. Pages stamp each word with the time
 * they sent it (`at`), and one sent before what's stored came too late. A lock always
 * applies: it only makes things more locked. A word without a stamp (from an older
 * page) can't be placed after a stamped one.
 */
function appLockWordApplies(state, at, before) {
  if (state === "locked" || !before) return true;
  const beforeAt = typeof before.at === "number" ? before.at : null;
  if (beforeAt === null) return true;
  if (at === null || at < beforeAt) return false;
  return at > beforeAt || before.state !== "locked";
}

/**
 * What a page said, kept across the worker's restarts. With "unlocked" go the tabs
 * that said so since the lock last came, those of them still open: one of them has
 * to be there for it to count.
 */
async function writeAppLockState(state, clientId, sentAt) {
  const at = typeof sentAt === "number" && Number.isFinite(sentAt) ? sentAt : null;
  const before = await readAppLockState().catch(() => null);
  if (!appLockWordApplies(state, at, before)) return;
  const record = { state };
  const beforeAt = before && typeof before.at === "number" ? before.at : null;
  if (at !== null || beforeAt !== null) record.at = Math.max(at === null ? -Infinity : at, beforeAt === null ? -Infinity : beforeAt);
  if (state === "unlocked") {
    const said = before && before.state === "unlocked" && Array.isArray(before.clients) ? before.clients : [];
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const openIds = new Set(open.map((client) => client.id));
    record.clients = said.filter((id) => openIds.has(id));
    if (typeof clientId === "string" && clientId && !record.clients.includes(clientId)) record.clients.push(clientId);
  }
  const cache = await caches.open(PUSH_STATE_CACHE);
  await cache.put(appLockStateKey(), new Response(JSON.stringify(record), { headers: { "Content-Type": "application/json" } }));
  await rememberAppLockOn(state !== "off");
  if (state === "locked") await closeMailNotifications();
}

/**
 * What's on screen from before the lock names senders and subjects, or an event's
 * title. Only the prompt to bring a mailto window forward says nothing of either.
 */
async function closeMailNotifications() {
  try {
    const shown = await self.registration.getNotifications();
    for (const notification of shown) {
      const tag = typeof notification.tag === "string" ? notification.tag : "";
      if (tag.startsWith("bulwark-mail:") || tag.startsWith("calendar-reminder:")) notification.close();
    }
  } catch (_) {
    // Nothing more a worker can do.
  }
}

/** Whether a tab holds the lock key now: what the page asks too (lib/app-lock/controller.ts holderAlive). */
async function appLockKeyHeld() {
  const locks = typeof navigator !== "undefined" && navigator ? navigator.locks : null;
  // A worker without Web Locks can't tell: locked.
  if (!locks || typeof locks.query !== "function") return false;
  const snapshot = await locks.query();
  const held = snapshot && Array.isArray(snapshot.held) ? snapshot.held : [];
  return held.some((lock) => lock && lock.name === APP_LOCK_HOLDER);
}

/**
 * The page says "locked" when it locks. It can't say so when its tab or the browser
 * closes, so a stored "unlocked" counts only while a tab holds the lock key and one
 * of the tabs that said "unlocked" is open. Any other window of the origin (a
 * picture, an attachment) runs no lock and counts for nothing. Pages say "off" too, so
 * nothing stored means no page has said anything since the state was deleted: locked if
 * the lock was on before.
 */
async function appLockHidesContent() {
  try {
    const stored = await readAppLockState();
    if (!stored) return await appLockWasOn();
    if (stored.state === "off") return false;
    if (stored.state !== "unlocked") return true;
    if (!(await appLockKeyHeld())) return true;
    const said = Array.isArray(stored.clients) ? stored.clients : [];
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return !windows.some((client) => said.includes(client.id));
  } catch (_) {
    // Can't tell: a generic notification loses little.
    return true;
  }
}

function lastAlertKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/last-alert`;
}

function pushPreferencesKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/prefs`;
}

/**
 * The webmail's "Notification sound" setting, mirrored into this store by
 * the page (lib/push-preferences.ts, #1289). Nothing stored: a sound, as
 * before.
 */
async function soundPreference() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(pushPreferencesKey());
    const prefs = res ? await res.json() : null;
    return !prefs || prefs.sound !== false;
  } catch (_) {
    return true;
  }
}

/**
 * The "Email notifications" switch and do not disturb. Each login has its own
 * settings, so the page leaves one answer per login (the push's label names it).
 * Nothing stored for it: show.
 */
async function showPreference(accountLabel) {
  if (!accountLabel) return true;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(`${self.location.origin}${BASE_PATH}/__push-state/quiet-logins`);
    const quiet = res ? await res.json() : null;
    return !quiet || quiet[accountLabel] !== true;
  } catch (_) {
    return true;
  }
}

/** True when another account alerted audibly less than QUIET_WINDOW_MS ago; otherwise records this one. */
async function withinQuietWindow(accountId) {
  const now = Date.now();
  const account = accountId || "default";
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(lastAlertKey());
    const lastAlert = res ? await res.json() : null;
    const last = lastAlert ? Number(lastAlert.at) : 0;
    if (last && lastAlert.accountId !== account && now - last >= 0 && now - last < QUIET_WINDOW_MS) return true;
    await cache.put(
      lastAlertKey(),
      new Response(JSON.stringify({ at: now, accountId: account }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (_) {
    // Without the store every notification alerts, as before.
  }
  return false;
}

// Per-account list of message ids we have already shown a notification for.
// Service workers have no localStorage; the Cache API is the cheapest durable
// store that survives the worker being killed between pushes. Failures are
// swallowed - dedupe is a nicety, delivering the notification is not.
const PUSH_STATE_CACHE = "bulwark-push-state-v1";
const NOTIFIED_IDS_LIMIT = 200;

function notifiedIdsKey(accountId) {
  return `${self.location.origin}${BASE_PATH}/__push-state/notified/${encodeURIComponent(accountId || "default")}`;
}

async function readNotifiedIds(accountId) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(notifiedIdsKey(accountId));
    if (!res) return [];
    const data = await res.json();
    return Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === "string") : [];
  } catch (_) {
    return [];
  }
}

async function writeNotifiedIds(accountId, ids) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const unique = Array.from(new Set(ids)).slice(-NOTIFIED_IDS_LIMIT);
    await cache.put(
      notifiedIdsKey(accountId),
      new Response(JSON.stringify({ ids: unique }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (_) {
    // Best effort only.
  }
}

/** What the page left here: lib/pwa-notify/worker-state.ts. */
async function readRelayRegistrations() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(`${self.location.origin}${BASE_PATH}/__push-state/relay-registrations`);
    const stored = res ? await res.json() : null;
    return stored && stored.entries && typeof stored.entries === "object" ? stored : null;
  } catch (_) {
    return null;
  }
}

/** No-third-party mode may have come on since the page left a relay here. Unknown counts as no. */
async function mayCallRelays() {
  try {
    const res = await fetch(`${BASE_PATH}/api/config`, { cache: "no-store" });
    if (!res.ok) return false;
    const config = await res.json();
    return config.noThirdPartyTraffic !== true;
  } catch (_) {
    return false;
  }
}

function applicationServerKeyOf(base64Url) {
  const padded = base64Url + "=".repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

// The push service dropped or replaced the browser's subscription (expiry,
// a key rotation, revoked permission). Re-subscribe with the same relay key
// unless the browser already did. The mail server's subscription points at the
// relay record, not at the endpoint, so telling the relay is all it takes, and
// that needs no login: push is back with no tab open. Open tabs hear of it too,
// for what only a page can do (resyncWebPush in lib/web-push.ts).
async function handlePushSubscriptionChange(event) {
  const old = event.oldSubscription;
  const registrations = await readRelayRegistrations();
  let subscription = event.newSubscription || null;
  if (!subscription) {
    const options = old && old.options
      ? old.options
      : registrations && registrations.applicationServerKey
        ? { userVisibleOnly: true, applicationServerKey: applicationServerKeyOf(registrations.applicationServerKey) }
        : null;
    if (options) {
      try {
        subscription = await self.registration.pushManager.subscribe(options);
      } catch (_) {
        // Permission revoked or push service unreachable: the page's re-sync
        // subscribes again itself when it can.
      }
    }
  }
  if (subscription && registrations && typeof subscription.toJSON === "function" && (await mayCallRelays())) {
    const json = subscription.toJSON();
    for (const entry of Object.values(registrations.entries)) {
      try {
        await fetch(`${entry.relay}/api/push/register/web`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscriptionId: entry.subscriptionId, subscription: json, accountLabel: entry.accountLabel }),
        });
      } catch (_) {
        // The page's re-sync registers it when it next runs.
      }
    }
  }
  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of allClients) {
    try {
      client.postMessage({ kind: "pushsubscriptionchange" });
    } catch (_) {
      // Closed or detached client - ignore.
    }
  }
}

async function handleNotificationClick(event) {
  const data = event.notification.data || {};
  const tag = event.notification.tag || "";

  if (data.kind === "protocol-mailto-focus") {
    return handleMailtoFocusNotificationClick();
  }

  let targetUrl = buildClickUrl(data);

  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  // Notify any in-app clients so plugins listening on toastHooks.onNotificationClick fire.
  for (const client of allClients) {
    try {
      client.postMessage({ kind: "notificationclick", tag, data });
    } catch (_) {
      // Closed or detached client - ignore.
    }
  }

  // A button on the notification. When it can't be done from here, the click
  // carries on below and opens the message, like a click on the body.
  const action = notificationActionOf(event, data);
  if (action) {
    if (await runNotificationAction(action, data, event.reply, allClients)) return;
    if (action === "reply") targetUrl = buildClickUrl(data, true);
  }

  for (const client of windowsForClick(allClients)) {
    // Reuse an existing tab whenever possible - users on desktop browsers
    // get annoyed when each notification opens a fresh window.
    if ("focus" in client) {
      try {
        // FOCUS FIRST, NAVIGATE SECOND, and the order is the entire fix.
        //
        // A notification click grants the service worker a TRANSIENT USER ACTIVATION, and
        // both focus() and openWindow() refuse to run without one. navigate() SPENDS that
        // activation, and it also replaces the client's document, which invalidates the
        // WindowClient handle we are about to use. Navigating first therefore breaks the
        // click two ways over. Instrumented on Android in a real deployment:
        //
        //   client 1: navigate ok -> focus() threw NotFoundError      (handle stale after nav)
        //   client 2: navigate ok -> focus() threw InvalidAccessError (activation spent)
        //   openWindow()          -> threw InvalidAccessError         (same)
        //
        // Every rejection was swallowed by the catch below, so the toast closed and nothing
        // came to the front. Focusing first uses the activation while it is still live;
        // navigate() does not need one of its own once the client is focused.
        const focused = await client.focus();
        if (focused && "navigate" in focused && targetUrl) {
          try {
            await focused.navigate(targetUrl);
          } catch (_) {
            // Focused but not navigated still beats nothing opening at all.
          }
        }
        return focused;
      } catch (_) {
        // navigate() can reject for cross-origin or detached clients - fall
        // through and open a new window below.
      }
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(targetUrl || `${BASE_PATH}/`);
  }
}

/**
 * The windows a click may take over, the one in front first. Not a frame inside
 * a page, and not a pop-out or a protocol page: navigating one of those would
 * lose what it shows and leave the message in a window without the app around it.
 */
function windowsForClick(allClients) {
  const score = (client) => (client.focused ? 0 : client.visibilityState === "visible" ? 1 : 2);
  return allClients
    .filter((client) => {
      if (client.frameType && client.frameType !== "top-level") return false;
      try {
        return !/\/(popout|protocol)(\/|$)/.test(new URL(client.url).pathname);
      } catch (_) {
        return true;
      }
    })
    .sort((a, b) => score(a) - score(b));
}

async function focusExistingWindowClient(sourceClientId, requireMailtoReady) {
  const entry = await findReusableWindowClientEntry(sourceClientId, requireMailtoReady);
  const client = entry && entry.client;
  if (client && "focus" in client) {
    return client.focus();
  }
}

async function handleMailtoFocusNotificationClick() {
  const entry = await findReusableWindowClientEntry(null, true);
  const client = entry && entry.client;
  if (client && "focus" in client) {
    try {
      return await client.focus();
    } catch (_) {
      // Fall through to opening a new app window if activation is still blocked.
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(`${BASE_PATH}/`);
  }
}

async function handleOpenMailtoInClient(event) {
  const data = event.data || {};
  const responsePort = event.ports && event.ports[0];
  const entry = await findReusableWindowClientEntry(event.source && event.source.id, true);
  const client = entry && entry.client;
  const state = entry && entry.state;

  if (!client || !state || !state.clientId) {
    responsePort && responsePort.postMessage({ delivered: false });
    return;
  }

  try {
    client.postMessage({ type: "mailto-request", id: data.id, clientId: state.clientId, value: data.value });
  } catch (_) {
    responsePort && responsePort.postMessage({ delivered: false });
    return;
  }

  if ("focus" in client) {
    try {
      await client.focus();
    } catch (_) {
      // Delivery succeeded; focusing can still be blocked by browser policy.
      await showMailtoFocusNotification(state);
    }
  }

  responsePort && responsePort.postMessage({ delivered: true });
}

async function showMailtoFocusNotification(state) {
  try {
    await self.registration.showNotification(state.focusNotificationTitle || "Bulwark", {
      body: state.focusNotificationBody || "The request was opened in Bulwark. Click to bring it to the front.",
      tag: "bulwark-mailto-focus",
      icon: `${BASE_PATH}/api/pwa-icon/192`,
      badge: `${BASE_PATH}/api/pwa-icon/192`,
      data: { kind: "protocol-mailto-focus" },
      renotify: true,
    });
  } catch (_) {
    // Notification permission may be missing; the mailto request was still delivered.
  }
}

async function findReusableWindowClientEntry(sourceClientId, requireMailtoReady) {
  const scopedPath = BASE_PATH ? `${BASE_PATH}/` : "/";
  const allClients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  const candidates = [];

  for (const client of allClients) {
    if (client.id === sourceClientId) continue;
    const state = MAILTO_CLIENTS.get(client.id);
    if (requireMailtoReady && !state) continue;

    try {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin) continue;
      if (!url.pathname.startsWith(scopedPath)) continue;
      if (url.pathname.includes("/protocol/")) continue;

      candidates.push({ client, state, score: getReusableClientScore(state) });
    } catch (_) {
      // Detached clients can disappear while iterating.
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates[0];
}

/**
 * Whether a client's path is the mail section. Since #733 the mail client
 * keeps a permalink in the address bar, so an open inbox reads as
 * `/mail/folder/inbox` (optionally behind a mount prefix and a locale
 * segment) rather than a bare "/".
 *
 * Deliberately duplicated from lib/deep-links.ts: this file is served raw, not
 * bundled, so it cannot import from the app. The locale segment is matched by
 * shape (two lowercase letters) because the worker has no locale list - and no
 * app route is a bare two-letter segment.
 */
function isMailSectionPath(path) {
  if (!path) return true;
  let rest = path;
  if (BASE_PATH && (rest === BASE_PATH || rest.startsWith(`${BASE_PATH}/`))) {
    rest = rest.slice(BASE_PATH.length);
  }
  const segments = rest.split("/").filter(Boolean);
  if (segments.length > 0 && /^[a-z]{2}$/.test(segments[0])) segments.shift();
  return segments.length === 0 || segments[0] === "mail";
}

function getReusableClientScore(state) {
  if (!state) return 4;

  const isMailSection = isMailSectionPath(state.path);
  if (state.standalone && isMailSection) return 0;
  if (isMailSection) return 1;
  if (state.standalone) return 2;
  return 3;
}

function buildClickUrl(data, reply) {
  if (!data) return `${BASE_PATH}/`;
  if (data.kind === "calendar-reminder") {
    // The page's address, with its language. Only ever a path on this origin: the address
    // is resolved as a browser would, and opened only when it stays here.
    const calendar = `${BASE_PATH}/calendar`;
    if (typeof data.url !== "string" || !data.url) return calendar;
    let target;
    try {
      target = new URL(data.url, self.location.origin);
    } catch (_) {
      return calendar;
    }
    // A path starting with two slashes would name another host once opened.
    if (target.origin !== self.location.origin || target.pathname.startsWith("//")) return calendar;
    return target.pathname + target.search + target.hash;
  }
  const params = new URLSearchParams();
  if (Number.isInteger(data.slot)) params.set("slot", String(data.slot));
  if (typeof data.accountId === "string" && data.accountId) params.set("owner", data.accountId);
  if (reply) params.set("reply", "1");
  // Not params.size: Safari before 17 (iOS 16.4+ web push) lacks it.
  const qs = params.toString();
  const targetQuery = qs ? `?${qs}` : "";
  if (data.kind === "email" && data.emailId) {
    // Permalink (#733). Under NEXT_PUBLIC_LOCALE_PREFIX=always the proxy
    // redirects this to the localised path; the worker has no locale to add.
    return `${BASE_PATH}/mail/message/${encodeURIComponent(data.emailId)}${targetQuery}`;
  }
  if (data.kind === "mail-list" && Number.isInteger(data.slot)) {
    return `${BASE_PATH}/mail/folder/inbox${targetQuery}`;
  }
  // Generic "New mail" toast (preview API failed or returned no email): land
  // the user on the latest unread message in their Inbox rather than just the
  // app shell, so the click still feels purposeful.
  return `${BASE_PATH}/?openLatestUnread=1`;
}

// ---- Notification actions: Archive, Mark read, Reply ----
//
// A worker has no login. An open tab has one, so it goes first. With none, a
// same-origin route acts with the login's context cookie (app/api/push/action).
// That cookie goes with the browser session and holds a token only a page
// refreshes, so the route can fail; the message then opens in the app.

const NOTIFICATION_ACTIONS = ["archive", "mark-read", "reply"];
// How long a tab has to take an action. A frozen tab doesn't answer. A tab that
// holds the notification's login gets longer, since a busy page may still run
// the action with its plugins; if it stays silent, the message opens and the
// route isn't tried, which would go round them.
const CLIENT_TAKE_MS = 1_000;
const LOGIN_HOLDER_TAKE_MS = 3_000;
const CLIENTS_TAKE_TOTAL_MS = 4_000;
// How long a tab that took it has before this worker stops waiting for the outcome.
const CLIENT_RESULT_MS = 5_000;
const ACTION_ROUTE_DEADLINE_MS = 4_500;
// All of the above stay inside the 10 s a browser allows openWindow and focus
// after a notification click, so the fallback can still open the message.

const OUTBOX_SYNC_TAG = "bulwark-outbox";

function notificationActionPrefsKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/actions`;
}

function pendingReplyKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/pending-reply`;
}

function clientLoginsKey() {
  return `${self.location.origin}${BASE_PATH}/__push-state/client-logins`;
}

async function readClientLogins() {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(clientLoginsKey());
    const map = res ? await res.json() : null;
    return map && typeof map === "object" ? map : {};
  } catch (_) {
    return {};
  }
}

/** Notes which logins an open tab holds, and forgets tabs that are gone. Kept across worker restarts. */
async function recordClientLogins(clientId, logins) {
  if (!clientId || !Array.isArray(logins)) return;
  try {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const openIds = new Set(open.map((c) => c.id));
    const known = await readClientLogins();
    const next = {};
    for (const [id, held] of Object.entries(known)) if (openIds.has(id)) next[id] = held;
    next[clientId] = logins.filter((login) => typeof login === "string");
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(clientLoginsKey(), new Response(JSON.stringify(next), { headers: { "Content-Type": "application/json" } }));
  } catch (_) {
    // Such a tab counts as not holding the login.
  }
}

/**
 * What the page mirrors into this store (lib/pwa-notify/worker-state.ts): the
 * labels in the user's language, Archive on or off, how Archive files mail,
 * and whether an enabled plugin may veto these actions. Nothing stored: no
 * Archive button, since the admin may have turned it off, and no route, since
 * a plugin may be there.
 */
async function readNotificationActionPrefs() {
  let stored = null;
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    const res = await cache.match(notificationActionPrefsKey());
    stored = res ? await res.json() : null;
  } catch (_) {
    stored = null;
  }
  const labels = (stored && stored.labels) || {};
  return {
    archiveEnabled: !!stored && stored.archiveEnabled === true,
    archiveMode: stored && typeof stored.archiveMode === "string" ? stored.archiveMode : "single",
    pluginsMayVeto: !stored || stored.pluginsMayVeto !== false,
    labels: {
      archive: labels.archive || "Archive",
      markRead: labels.markRead || "Mark as read",
      reply: labels.reply || "Reply",
      replyPlaceholder: labels.replyPlaceholder || "Write a reply",
    },
  };
}

function maxNotificationActions() {
  if (typeof Notification === "undefined") return 0;
  return Number.isInteger(Notification.maxActions) ? Notification.maxActions : 0;
}

function inlineReplySupported() {
  return typeof NotificationEvent !== "undefined" && "reply" in NotificationEvent.prototype;
}

/** The buttons for a notification. Only one message, with its login known, gets any, and none while locked. */
async function notificationActions(data) {
  if (!data || data.kind !== "email" || !data.emailId || !data.accountId || !data.login) return [];
  const max = maxNotificationActions();
  if (max < 1) return [];
  if (await appLockHidesContent()) return [];
  const prefs = await readNotificationActionPrefs();
  const offered = {
    "mark-read": { action: "mark-read", title: prefs.labels.markRead },
    reply: inlineReplySupported()
      ? { action: "reply", title: prefs.labels.reply, type: "text", placeholder: prefs.labels.replyPlaceholder }
      : { action: "reply", title: prefs.labels.reply },
  };
  if (prefs.archiveEnabled) offered.archive = { action: "archive", title: prefs.labels.archive };
  // Chromium allows two. Mark read goes first then: opening the message does
  // that too, and nothing else on the toast archives or starts a reply.
  const kept = ["archive", "reply", "mark-read"].filter((name) => offered[name]).slice(0, max);
  return NOTIFICATION_ACTIONS.filter((name) => kept.includes(name)).map((name) => offered[name]);
}

/** A notification must show, whatever a browser thinks of its buttons. */
async function showWithActions(title, options) {
  const actions = await notificationActions(options.data);
  if (actions.length > 0) {
    try {
      await self.registration.showNotification(title, { ...options, actions });
      return;
    } catch (_) {
      // Shown without buttons below.
    }
  }
  await self.registration.showNotification(title, options);
}

function notificationActionOf(event, data) {
  if (!NOTIFICATION_ACTIONS.includes(event.action)) return null;
  return data.kind === "email" && data.emailId && data.accountId ? event.action : null;
}

/** Asks one tab. Resolves "done", "failed" (it tried), "declined" (it didn't take it) or "silent" (no answer). */
function askClient(client, message, takeMs) {
  return new Promise((resolve) => {
    if (typeof MessageChannel !== "function") {
      resolve("declined");
      return;
    }
    const channel = new MessageChannel();
    let timer = null;
    const finish = (result) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      resolve(result);
    };
    timer = setTimeout(() => finish("silent"), takeMs);
    channel.port1.onmessage = (answer) => {
      const status = answer.data && answer.data.status;
      if (status === "accepted") {
        // It's on it. A slow server shouldn't send the action round twice.
        clearTimeout(timer);
        timer = setTimeout(() => finish("done"), CLIENT_RESULT_MS);
        return;
      }
      finish(status === "done" || status === "failed" ? status : "declined");
    };
    try {
      client.postMessage(message, [channel.port2]);
    } catch (_) {
      finish("declined");
    }
  });
}

/** The first open tab that takes the action, the one in front first. */
async function askOpenClients(message, allClients) {
  const score = (client) => (client.focused ? 0 : client.visibilityState === "visible" ? 1 : 2);
  const ordered = allClients
    .filter((client) => !client.frameType || client.frameType === "top-level")
    .sort((a, b) => score(a) - score(b));
  const held = await readClientLogins();
  const holdsLogin = (client) => Array.isArray(held[client.id]) && held[client.id].includes(message.login);
  const giveUpAt = Date.now() + CLIENTS_TAKE_TOTAL_MS;
  let silentHolder = false;
  for (const client of ordered) {
    if (Date.now() >= giveUpAt) {
      silentHolder = silentHolder || holdsLogin(client);
      continue;
    }
    const holder = holdsLogin(client);
    const result = await askClient(client, message, holder ? LOGIN_HOLDER_TAKE_MS : CLIENT_TAKE_MS);
    if (result === "silent") silentHolder = silentHolder || holder;
    else if (result !== "declined") return { result, client };
  }
  // A silent tab with this login may have plugins that would stop the action.
  return { result: silentHolder ? "failed" : "declined", client: null };
}

/** Keeps a typed reply for the page the click is about to open; it's not for a URL. */
async function keepPendingReply(emailId, text) {
  try {
    const cache = await caches.open(PUSH_STATE_CACHE);
    await cache.put(
      pendingReplyKey(),
      new Response(JSON.stringify({ emailId, text, at: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  } catch (_) {
    // The composer opens empty.
  }
}

async function postNotificationAction(action, data) {
  const prefs = await readNotificationActionPrefs();
  if (action === "archive" && !prefs.archiveEnabled) return false;
  // Plugins run in pages. One that may stop or watch this action can't from
  // the route, so the app opens instead.
  if (prefs.pluginsMayVeto) return false;
  const body = { action, accountId: data.accountId, emailId: data.emailId, login: data.login };
  if (action === "archive") {
    body.archiveMode = prefs.archiveMode;
    // Year and month folders go by the date the user sees.
    if (typeof Intl !== "undefined") body.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ACTION_ROUTE_DEADLINE_MS) : null;
  try {
    const res = await fetch(`${BASE_PATH}/api/push/action`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    return res.ok;
  } catch (_) {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** True when the action is done and nothing has to open. */
async function runNotificationAction(action, data, reply, allClients) {
  // An old notification's button doesn't act on mail while the app is locked.
  if (await appLockHidesContent()) return false;
  const text = action === "reply" && typeof reply === "string" ? reply.trim() : "";
  const { result, client } = await askOpenClients({
    kind: "notification-action",
    action,
    emailId: data.emailId,
    threadId: data.threadId,
    accountId: data.accountId,
    slot: data.slot,
    login: data.login,
    // A frozen tab that thaws later must not act on a click long since handled.
    at: Date.now(),
    ...(text ? { text } : {}),
  }, allClients);
  if (result === "done") {
    if (action === "reply" && "focus" in client) {
      try {
        await client.focus();
      } catch (_) {
        // The composer is open in that tab; focusing can be blocked by the browser.
      }
    }
    return true;
  }
  if (action === "reply") {
    if (text) await keepPendingReply(data.emailId, text);
    return false;
  }
  // A tab with this login tried and failed, or stayed silent: the route won't
  // do better and would go round its plugins.
  if (result === "failed") return false;
  return postNotificationAction(action, data);
}

async function tellClientsToFlushOutbox() {
  const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of allClients) {
    try {
      client.postMessage({ kind: "outbox-flush" });
    } catch (_) {
      // Closed or detached client - ignore.
    }
  }
}
