// Step 43, part C: push notifications of the chat on this device.
// A service worker registration of its own (public/xenaxio-chat-sw.js) holds
// the subscription; the platform turns it into a pusher of this browser
// session's chat device and sends Web Push itself (no outside relay).
import { apiFetch, withBasePath } from "@/lib/browser-navigation";

const SW_FILE = "/xenaxio-chat-sw.js";
const SW_SCOPE = "/__xenaxio-chat-push/";

export type ChatPushState = "unsupported" | "denied" | "off" | "on";

export interface ChatNotifySettings {
  /** Paused until this moment (ISO), or null. */
  dndUntil: string | null;
  /** Quiet hours, minutes after midnight; both null = no schedule. */
  dndFrom: number | null;
  dndTo: number | null;
  /** Days of the schedule, 1 = Monday … 7 = Sunday. */
  dndDays: number[];
  /** E-mail about mentions unread for 24 hours. */
  emailDigest: boolean;
}

const json = { Accept: "application/json", "Content-Type": "application/json", "x-xenaxio-csrf": "1" };

export function chatPushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function scope(): string {
  return new URL(withBasePath(SW_SCOPE), window.location.origin).href;
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration(scope());
}

async function serverInfo(): Promise<{ publicKey: string; endpoints: string[] }> {
  const res = await apiFetch("/api/chat/push", { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`push info ${res.status}`);
  return (await res.json()) as { publicKey: string; endpoints: string[] };
}

async function sendSubscription(sub: PushSubscription): Promise<void> {
  const data = sub.toJSON();
  const res = await apiFetch("/api/chat/push", {
    method: "POST",
    credentials: "same-origin",
    headers: json,
    body: JSON.stringify({ endpoint: data.endpoint, keys: { p256dh: data.keys?.p256dh, auth: data.keys?.auth } }),
  });
  if (!res.ok) throw new Error(`push subscribe ${res.status}`);
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.length) return false;
  const view = new Uint8Array(a);
  return view.every((x, i) => x === b[i]);
}

/** Registers (or updates) the chat's worker; the locale is for the link a click opens. */
async function ensureRegistration(locale: string): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register(`${withBasePath(SW_FILE)}?locale=${encodeURIComponent(locale)}`, { scope: withBasePath(SW_SCOPE) });
  if (reg.active) return reg;
  const worker = reg.installing ?? reg.waiting;
  if (worker)
    await new Promise<void>((resolve) => {
      const done = () => worker.state === "activated" && resolve();
      worker.addEventListener("statechange", done);
      done();
    });
  return reg;
}

/** What the switch "notifications on this device" shows. */
export async function chatPushState(): Promise<ChatPushState> {
  if (!chatPushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return "off";
  const { endpoints } = await serverInfo();
  return endpoints.includes(sub.endpoint) ? "on" : "off";
}

/** Asks for permission (must run from a click) and subscribes this device. */
export async function enableChatPush(locale: string): Promise<ChatPushState> {
  if (!chatPushSupported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "denied";
  if (permission !== "granted") return "off";
  const [{ publicKey }, reg] = await Promise.all([serverInfo(), ensureRegistration(locale)]);
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another key (a reinstalled server) is useless.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await sendSubscription(sub);
  return "on";
}

/** Turns push off on this device (the other devices keep theirs). */
export async function disableChatPush(): Promise<ChatPushState> {
  if (!chatPushSupported()) return "unsupported";
  const sub = await (await registration())?.pushManager.getSubscription();
  if (sub) {
    await apiFetch(`/api/chat/push?endpoint=${encodeURIComponent(sub.endpoint)}`, { method: "DELETE", credentials: "same-origin", headers: { "x-xenaxio-csrf": "1" } }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return Notification.permission === "denied" ? "denied" : "off";
}

/**
 * On opening the chat: a device that had push on keeps it after signing in
 * again (a new session is a new chat device), and the worker learns the
 * current language. Never asks for permission.
 */
export async function resumeChatPush(locale: string): Promise<void> {
  if (!chatPushSupported() || Notification.permission !== "granted") return;
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!reg || !sub) return;
  const scriptUrl = reg.active?.scriptURL ?? "";
  if (!scriptUrl.endsWith(`?locale=${encodeURIComponent(locale)}`)) await ensureRegistration(locale);
  const { publicKey, endpoints } = await serverInfo();
  if (endpoints.includes(sub.endpoint)) return;
  if (!sameKey(sub.options.applicationServerKey, keyBytes(publicKey))) {
    await enableChatPush(locale);
    return;
  }
  await sendSubscription(sub);
}

export async function loadChatSettings(): Promise<ChatNotifySettings> {
  const res = await apiFetch("/api/chat/settings", { credentials: "same-origin", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`settings ${res.status}`);
  return (await res.json()) as ChatNotifySettings;
}

export async function saveChatSettings(settings: ChatNotifySettings): Promise<ChatNotifySettings> {
  const res = await apiFetch("/api/chat/settings", { method: "PUT", credentials: "same-origin", headers: json, body: JSON.stringify(settings) });
  if (!res.ok) throw new Error(`settings ${res.status}`);
  return (await res.json()) as ChatNotifySettings;
}

/** "HH:MM" ↔ minutes after midnight. */
export function timeToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function minutesToTime(minutes: number | null): string {
  if (minutes === null) return "";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** End of a pause "for 30 minutes", "1 hour", … or "until tomorrow 8:00". */
export function pauseUntil(choice: "30m" | "1h" | "2h" | "tomorrow", now = new Date()): Date {
  if (choice === "tomorrow") {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
    return d;
  }
  const minutes = { "30m": 30, "1h": 60, "2h": 120 }[choice];
  return new Date(now.getTime() + minutes * 60_000);
}

/** Is the pause still on? */
export function isPaused(settings: ChatNotifySettings | null, now = Date.now()): boolean {
  return !!settings?.dndUntil && Date.parse(settings.dndUntil) > now;
}
