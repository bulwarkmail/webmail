// Browser-side Web Push setup. Mirrors the React Native flow in
// repos/react-native/src/lib/push-notifications.ts so the relay sees the same
// shape from both clients - the only differences are which native API
// produces the push token (PushManager.subscribe here, FCM there) and which
// register endpoint we hit on the relay.

import type { IJMAPClient } from '@/lib/jmap/client-interface';

const DEVICE_CLIENT_ID_KEY = 'bulwark.push.deviceClientId.v1';
const SUBSCRIPTION_ID_KEY = 'bulwark.push.subscriptionId.v1';

// Hosted relay so self-hosters don't need their own VAPID + Firebase setup.
// Override at build time via NEXT_PUBLIC_PUSH_RELAY_URL or at runtime by
// calling enableWebPush({ relayBaseUrl }) from the settings UI.
export const DEFAULT_RELAY_BASE_URL =
  process.env.NEXT_PUBLIC_PUSH_RELAY_URL || 'https://notifications.relay.bulwarkmail.org';

// Match the mobile app's lifetime hint. The JMAP server may clamp this down.
const SUBSCRIPTION_EXPIRES_DAYS = 90;
const SUBSCRIPTION_REFRESH_THRESHOLD_DAYS = 7;

// Only `EmailDelivery` state-changes when new mail is actually delivered.
// `Email` fires for any mutation (sending, drafting, moving, marking read,
// deleting) and `Mailbox` fires for mailbox edits — both produced spurious
// system notifications, so we keep them out of the push subscription.
// In-app sync uses a separate StateChange channel and is unaffected.
const PUSH_TYPES = ['EmailDelivery'] as const;

function sameTypes(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

export interface EnableWebPushParams {
  client: IJMAPClient;
  // Optional - falls back to DEFAULT_RELAY_BASE_URL.
  relayBaseUrl?: string;
  // Free-form label the relay shows in /metrics; never returned in pushes.
  accountLabel?: string;
}

export interface EnableWebPushResult {
  subscriptionId: string;
}

export class WebPushUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebPushUnsupportedError';
  }
}

export function isWebPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function buildRelayUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}

function expiresFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function randomDeviceClientId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getOrCreateDeviceClientId(): string {
  const existing = localStorage.getItem(DEVICE_CLIENT_ID_KEY);
  if (existing) return existing;
  const next = randomDeviceClientId();
  localStorage.setItem(DEVICE_CLIENT_ID_KEY, next);
  return next;
}

// PushManager.subscribe wants the VAPID public key as a BufferSource.
// Returning a Uint8Array<ArrayBuffer> (not the wider ArrayBufferLike that
// includes SharedArrayBuffer) keeps strict TS happy on lib.dom 2024+.
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function readPushKey(
  sub: PushSubscription,
  name: 'p256dh' | 'auth',
): string {
  const raw = sub.getKey(name);
  if (!raw) throw new Error(`PushSubscription is missing the ${name} key`);
  // Browsers want application/json over the wire so encode as base64url.
  let binary = '';
  const bytes = new Uint8Array(raw);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function fetchVapidPublicKey(relayBaseUrl: string): Promise<string> {
  const res = await fetch(buildRelayUrl(relayBaseUrl, '/api/push/vapid-public-key'));
  if (!res.ok) {
    if (res.status === 503) {
      throw new Error('The push relay does not have Web Push configured');
    }
    throw new Error(`Failed to fetch VAPID key: ${res.status}`);
  }
  const body = (await res.json()) as { publicKey?: string };
  if (!body.publicKey) throw new Error('Relay returned an empty VAPID key');
  return body.publicKey;
}

async function ensurePermission(): Promise<void> {
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') {
    throw new Error('Notifications are blocked - allow them in browser settings to continue');
  }
  const result = await Notification.requestPermission();
  if (result !== 'granted') {
    throw new Error('Notification permission was not granted');
  }
}

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  // The webmail's PWA already registers /sw.js for installability. If it
  // hasn't been picked up yet (e.g. first load), kick it ourselves so the
  // push handler is in place.
  let registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration) {
    registration = await navigator.serviceWorker.register('/sw.js');
  }
  await navigator.serviceWorker.ready;
  return registration;
}

async function registerWithRelay(params: {
  relayBaseUrl: string;
  subscriptionId: string;
  // Subset of PushSubscriptionJSON we actually serialise. Inlined so eslint's
  // no-undef rule (which doesn't know about DOM type-only globals) is happy.
  subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  accountLabel?: string;
}): Promise<void> {
  const { endpoint, keys } = params.subscription;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    throw new Error('Browser returned an incomplete PushSubscription');
  }
  const res = await fetch(buildRelayUrl(params.relayBaseUrl, '/api/push/register/web'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subscriptionId: params.subscriptionId,
      subscription: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
      accountLabel: params.accountLabel,
    }),
  });
  if (!res.ok) {
    throw new Error(`Relay register failed: ${res.status}`);
  }
}

async function pollVerificationCode(
  relayBaseUrl: string,
  subscriptionId: string,
): Promise<string> {
  // Stalwart per-account rate-limits PushVerification posts (default 60s).
  // If there are leftover unverified subscriptions on the account, our new
  // one queues up behind them - so we wait long enough to clear one verify
  // window even in the unlucky case.
  const timeoutAt = Date.now() + 75_000;
  let delay = 400;
  while (Date.now() < timeoutAt) {
    const res = await fetch(
      buildRelayUrl(relayBaseUrl, `/api/push/verify/${encodeURIComponent(subscriptionId)}`),
    );
    if (res.ok) {
      const body = (await res.json()) as { verificationCode?: string | null };
      if (body.verificationCode) return body.verificationCode;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2000);
  }
  throw new Error('Timed out waiting for PushVerification from the JMAP server');
}

async function refreshSubscriptionExpires(
  client: IJMAPClient,
  sub: { id: string; expires: string | null; types: string[] | null },
): Promise<boolean> {
  const typesNeedUpdate = !sameTypes(sub.types, PUSH_TYPES);
  if (!typesNeedUpdate && sub.expires) {
    const remainingMs = new Date(sub.expires).getTime() - Date.now();
    const thresholdMs = SUBSCRIPTION_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(remainingMs) && remainingMs > thresholdMs) return true;
  }
  try {
    const patch: { expires?: string; types?: string[] } = {
      expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
    };
    if (typesNeedUpdate) patch.types = [...PUSH_TYPES];
    return await client.updatePushSubscription(sub.id, patch);
  } catch {
    return false;
  }
}

export async function enableWebPush(
  params: EnableWebPushParams,
): Promise<EnableWebPushResult> {
  if (!isWebPushSupported()) {
    throw new WebPushUnsupportedError(
      'This browser does not support Web Push. On iOS the site needs to be installed to the home screen.',
    );
  }

  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  if (!relayBaseUrl) throw new Error('relayBaseUrl is required');

  await ensurePermission();
  const registration = await ensureServiceWorker();

  const vapidPublicKey = await fetchVapidPublicKey(relayBaseUrl);

  // Reuse an existing browser PushSubscription when possible - resubscribing
  // with the same VAPID key produces the same endpoint, but the call still
  // costs a network round-trip the user can feel.
  let pushSubscription = await registration.pushManager.getSubscription();
  if (pushSubscription) {
    const keyMatches = pushSubscription.options?.applicationServerKey;
    if (!keyMatches) {
      await pushSubscription.unsubscribe();
      pushSubscription = null;
    }
  }
  if (!pushSubscription) {
    pushSubscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const deviceClientId = getOrCreateDeviceClientId();

  await registerWithRelay({
    relayBaseUrl,
    subscriptionId: deviceClientId,
    subscription: {
      endpoint: pushSubscription.endpoint,
      keys: {
        p256dh: readPushKey(pushSubscription, 'p256dh'),
        auth: readPushKey(pushSubscription, 'auth'),
      },
    },
    accountLabel: params.accountLabel,
  });

  // Reuse the JMAP-side PushSubscription if the server still has it, just
  // refreshing the expiry so it doesn't time out between sessions.
  const existingSubs = await params.client.listPushSubscriptions().catch(() => []);
  const storedServerId = localStorage.getItem(SUBSCRIPTION_ID_KEY);
  if (storedServerId) {
    const match = existingSubs.find((s) => s.id === storedServerId);
    if (match) {
      const refreshed = await refreshSubscriptionExpires(params.client, match);
      if (refreshed) return { subscriptionId: storedServerId };
      await params.client.destroyPushSubscription(storedServerId).catch(() => undefined);
    }
    localStorage.removeItem(SUBSCRIPTION_ID_KEY);
  }

  // Reap any leftover subscriptions still bound to this device. These pile
  // up when a previous enable attempt failed mid-flow (verification timed
  // out, browser tab closed, etc). Stalwart per-account rate-limits
  // verification posts, so leaving stragglers around blocks the new one.
  const stragglers = existingSubs.filter(
    (s) => s.deviceClientId === deviceClientId && s.id !== storedServerId,
  );
  for (const s of stragglers) {
    await params.client.destroyPushSubscription(s.id).catch(() => undefined);
  }

  const serverAssignedId = await params.client.createPushSubscription({
    deviceClientId,
    url: buildRelayUrl(relayBaseUrl, `/api/push/jmap/${encodeURIComponent(deviceClientId)}`),
    types: [...PUSH_TYPES],
    expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
  });

  const verificationCode = await pollVerificationCode(relayBaseUrl, deviceClientId);
  await params.client.verifyPushSubscription(serverAssignedId, verificationCode);
  localStorage.setItem(SUBSCRIPTION_ID_KEY, serverAssignedId);

  return { subscriptionId: serverAssignedId };
}

export interface DisableWebPushParams {
  client: IJMAPClient;
  relayBaseUrl?: string;
}

// Best-effort teardown: clear the JMAP subscription, the relay mapping, and
// the browser PushSubscription. Any single failure is swallowed so the user
// always ends up in a "disabled" state locally.
export async function disableWebPush(params: DisableWebPushParams): Promise<void> {
  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');

  const storedServerId = localStorage.getItem(SUBSCRIPTION_ID_KEY);
  if (storedServerId) {
    await params.client.destroyPushSubscription(storedServerId).catch(() => undefined);
    localStorage.removeItem(SUBSCRIPTION_ID_KEY);
  }

  const deviceClientId = localStorage.getItem(DEVICE_CLIENT_ID_KEY);
  if (deviceClientId && relayBaseUrl) {
    await fetch(
      buildRelayUrl(relayBaseUrl, `/api/push/register/${encodeURIComponent(deviceClientId)}`),
      { method: 'DELETE' },
    ).catch(() => undefined);
  }

  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const registration = await navigator.serviceWorker.getRegistration('/');
    const sub = await registration?.pushManager.getSubscription();
    if (sub) await sub.unsubscribe().catch(() => undefined);
  }
}

export async function isWebPushEnabled(): Promise<boolean> {
  if (!isWebPushSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (!registration) return false;
  const sub = await registration.pushManager.getSubscription();
  return sub !== null && localStorage.getItem(SUBSCRIPTION_ID_KEY) !== null;
}
