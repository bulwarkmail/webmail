// Browser-side Web Push setup. Mirrors the React Native flow in
// repos/react-native/src/lib/push-notifications.ts so the relay sees the same
// shape from both clients - the only differences are which native API
// produces the push token (PushManager.subscribe here, FCM there) and which
// register endpoint we hit on the relay.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { DEFAULT_RELAY_BASE_URL } from '@/lib/push-relays';

// Per-account keys: a single browser may be signed in to multiple accounts,
// each with its own JMAP PushSubscription and its own relay record. Scoping
// the deviceClientId per account is what makes per-account notifications work
// at all - the relay keys subscriptions on subscriptionId (= deviceClientId),
// so a globally-shared key meant re-registering account B overwrote A.
const DEVICE_CLIENT_ID_PREFIX = 'bulwark.push.deviceClientId.v1.';
const SUBSCRIPTION_ID_PREFIX = 'bulwark.push.subscriptionId.v1.';

function deviceClientIdKey(accountId: string): string {
  return DEVICE_CLIENT_ID_PREFIX + accountId;
}

function subscriptionIdKey(accountId: string): string {
  return SUBSCRIPTION_ID_PREFIX + accountId;
}

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
const SW_SCOPE = `${BASE_PATH}/`;
const SW_URL = `${BASE_PATH}/sw.js`;

// Re-exported for callers that already import the relay default from here.
// The relay list itself lives in lib/push-relays.ts.
export { DEFAULT_RELAY_BASE_URL };

// Match the mobile app's lifetime hint. The JMAP server may clamp this down.
const SUBSCRIPTION_EXPIRES_DAYS = 90;
const SUBSCRIPTION_REFRESH_THRESHOLD_DAYS = 7;

// Only `EmailDelivery` state-changes when new mail is actually delivered.
// `Email` fires for any mutation (sending, drafting, moving, marking read,
// deleting) and `Mailbox` fires for mailbox edits - both produced spurious
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
  // Destroy the recorded server-side subscription and create a brand-new one
  // instead of refreshing the existing record's expiry. Stalwart binds the set
  // of accounts a subscription fans out to at creation time, so a subscription
  // that outlives a permission change keeps pushing for mailboxes the user can
  // no longer read - recreating is the only client-side remedy (#841).
  forceRecreate?: boolean;
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

function getOrCreateDeviceClientId(accountId: string): string {
  const key = deviceClientIdKey(accountId);
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const next = randomDeviceClientId();
  localStorage.setItem(key, next);
  return next;
}

function anyOtherAccountHasSubscription(accountId: string): boolean {
  const skip = subscriptionIdKey(accountId);
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k !== skip && k.startsWith(SUBSCRIPTION_ID_PREFIX)) return true;
  }
  return false;
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
  let registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  if (!registration) {
    registration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
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

/** The relay's view of a subscription - see relayStatusFor. */
export type PushRelayStatus = 'active' | 'inactive' | 'unknown';

/**
 * Ask the relay what it knows about a subscription. `inactive` means the relay
 * recognises the record and it is provably dead - it has never forwarded a push
 * and isn't freshly registered. `unknown` covers everything we cannot vouch for:
 * the relay doesn't recognise the id, an older relay without this endpoint, or a
 * network blip. Callers must treat `unknown` as "leave it alone", never as dead.
 */
async function relayStatusFor(
  relayBaseUrl: string,
  subscriptionId: string,
): Promise<PushRelayStatus> {
  if (!relayBaseUrl || !subscriptionId) return 'unknown';
  try {
    const res = await fetch(
      buildRelayUrl(relayBaseUrl, `/api/push/active/${encodeURIComponent(subscriptionId)}`),
    );
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { active?: unknown };
    if (body.active === true) return 'active';
    if (body.active === false) return 'inactive';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Returns true ONLY when the relay positively reports a subscription inactive,
 * so we never reap anything we can't confirm is dead. This lets enableWebPush
 * clear its own abandoned attempts - and dead siblings left by cleared site data
 * that regenerated the deviceClientId - without disturbing another live device
 * or the mobile app that shares the account.
 */
async function relayReportsDead(
  relayBaseUrl: string,
  subscriptionId: string,
): Promise<boolean> {
  return (await relayStatusFor(relayBaseUrl, subscriptionId)) === 'inactive';
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

  const accountId = params.client.getAccountId();
  const deviceClientId = getOrCreateDeviceClientId(accountId);

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
  // refreshing the expiry so it doesn't time out between sessions. With
  // forceRecreate we skip the reuse and destroy it instead: the account set a
  // Stalwart subscription fans out to is fixed at creation time, so refreshing
  // `expires` carries stale permissions forward and only a new record picks up
  // revoked shared-mailbox access (#841).
  const existingSubs = await params.client.listPushSubscriptions().catch(() => []);
  const subIdKey = subscriptionIdKey(accountId);
  const storedServerId = localStorage.getItem(subIdKey);
  if (storedServerId) {
    const match = existingSubs.find((s) => s.id === storedServerId);
    if (match) {
      if (!params.forceRecreate) {
        const refreshed = await refreshSubscriptionExpires(params.client, match);
        if (refreshed) return { subscriptionId: storedServerId };
      }
      await params.client.destroyPushSubscription(storedServerId).catch(() => undefined);
    }
    localStorage.removeItem(subIdKey);
  }

  // Reap leftover subscriptions that would otherwise starve the new one's
  // verification. Stalwart emits only one PushVerification per account per ~60s
  // and picks the oldest unverified subscription, so a single stale straggler
  // blocks every fresh attempt - the symptom is the confusing "Timed out
  // waiting for PushVerification" error. We can't read a subscription's
  // verified state or URL over JMAP (Stalwart hides both), only its
  // deviceClientId, so we decide what's safe to remove like this:
  //   - same deviceClientId as ours: a previous attempt from THIS browser,
  //     always safe to reap.
  //   - a different deviceClientId: could be another live device or the mobile
  //     app on this account. Ask the relay whether it's still alive and only
  //     reap the ones it confirms are dead. Anything live - or anything the
  //     relay can't vouch for (a different relay, a non-Bulwark client, a
  //     network blip) - is left untouched.
  for (const s of existingSubs) {
    if (s.id === storedServerId) continue;
    if (s.deviceClientId === deviceClientId) {
      await params.client.destroyPushSubscription(s.id).catch(() => undefined);
      continue;
    }
    if (await relayReportsDead(relayBaseUrl, s.deviceClientId)) {
      await params.client.destroyPushSubscription(s.id).catch(() => undefined);
    }
  }

  const serverAssignedId = await params.client.createPushSubscription({
    deviceClientId,
    url: buildRelayUrl(relayBaseUrl, `/api/push/jmap/${encodeURIComponent(deviceClientId)}`),
    types: [...PUSH_TYPES],
    expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
  });

  const verificationCode = await pollVerificationCode(relayBaseUrl, deviceClientId);
  await params.client.verifyPushSubscription(serverAssignedId, verificationCode);
  localStorage.setItem(subIdKey, serverAssignedId);

  return { subscriptionId: serverAssignedId };
}

export interface DisableWebPushParams {
  client: IJMAPClient;
  relayBaseUrl?: string;
}

// Best-effort teardown: clear the JMAP subscription, the relay mapping, and
// (only when no other accounts still need it) the browser-wide
// PushSubscription. Any single failure is swallowed so the user always ends
// up in a "disabled" state locally.
export async function disableWebPush(params: DisableWebPushParams): Promise<void> {
  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  const accountId = params.client.getAccountId();

  const subIdKey = subscriptionIdKey(accountId);
  const devIdKey = deviceClientIdKey(accountId);

  const storedServerId = localStorage.getItem(subIdKey);
  const deviceClientId = localStorage.getItem(devIdKey);

  // Destroy every subscription the server holds for this device, not just the
  // id we happen to have recorded. A destroy that lost its round-trip, a failed
  // enable, or site data cleared between sessions can leave a registration this
  // client no longer tracks - and Stalwart keeps fanning StateChanges out to it
  // until it expires, so "disable" has to mean gone (#841).
  const idsToDestroy = new Set<string>();
  if (storedServerId) idsToDestroy.add(storedServerId);
  if (deviceClientId) {
    const existingSubs = await params.client.listPushSubscriptions().catch(() => []);
    for (const s of existingSubs) {
      if (s.deviceClientId === deviceClientId) idsToDestroy.add(s.id);
    }
  }
  for (const id of idsToDestroy) {
    await params.client.destroyPushSubscription(id).catch(() => undefined);
  }
  localStorage.removeItem(subIdKey);

  if (deviceClientId && relayBaseUrl) {
    await fetch(
      buildRelayUrl(relayBaseUrl, `/api/push/register/${encodeURIComponent(deviceClientId)}`),
      { method: 'DELETE' },
    ).catch(() => undefined);
  }
  // Keep the deviceClientId around so a later re-enable for this account
  // reuses the same relay subscriptionId rather than scattering orphans.

  // The browser-wide PushSubscription is shared by every account on this
  // origin, so only tear it down if no other account is still using it.
  if (
    !anyOtherAccountHasSubscription(accountId)
    && typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
  ) {
    const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    const sub = await registration?.pushManager.getSubscription();
    if (sub) await sub.unsubscribe().catch(() => undefined);
  }
}

export interface PushDevice {
  // The JMAP PushSubscription id - what you destroy to revoke it.
  id: string;
  // Client-chosen id the relay keys its endpoint mapping on.
  deviceClientId: string;
  expires: string | null;
  types: string[] | null;
  // True when this registration belongs to the browser you're looking at.
  isThisDevice: boolean;
  relayStatus: PushRelayStatus;
}

/**
 * Every push registration the JMAP server holds for this account, annotated
 * with whether it is this browser and what the relay makes of it.
 *
 * Stalwart hides a subscription's url and verified state from clients, so
 * deviceClientId is the only handle we get. That's enough to spot our own
 * registration and to ask the relay about the rest - but registrations made
 * against a different relay, or by a non-Bulwark client, come back `unknown`
 * rather than dead, and the UI must present them as revocable-but-unclassified.
 */
export async function listPushDevices(params: {
  client: IJMAPClient;
  relayBaseUrl?: string;
}): Promise<PushDevice[]> {
  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  const accountId = params.client.getAccountId();
  const thisDeviceClientId = typeof localStorage === 'undefined'
    ? null
    : localStorage.getItem(deviceClientIdKey(accountId));

  const subs = await params.client.listPushSubscriptions();
  return Promise.all(
    subs.map(async (s) => ({
      id: s.id,
      deviceClientId: s.deviceClientId,
      expires: s.expires ?? null,
      types: s.types ?? null,
      isThisDevice: thisDeviceClientId !== null && s.deviceClientId === thisDeviceClientId,
      relayStatus: await relayStatusFor(relayBaseUrl, s.deviceClientId),
    })),
  );
}

/**
 * Revoke one registration. Destroying the JMAP subscription stops the server
 * fanning StateChanges to it; dropping the relay mapping stops the relay
 * forwarding anything already in flight and frees the deviceClientId. Revoking
 * this device runs the full local teardown so the UI doesn't keep claiming push
 * is on.
 */
export async function revokePushDevice(params: {
  client: IJMAPClient;
  device: Pick<PushDevice, 'id' | 'deviceClientId' | 'isThisDevice'>;
  relayBaseUrl?: string;
}): Promise<void> {
  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');

  if (params.device.isThisDevice) {
    await disableWebPush({ client: params.client, relayBaseUrl });
    return;
  }

  await params.client.destroyPushSubscription(params.device.id);
  if (relayBaseUrl && params.device.deviceClientId) {
    await fetch(
      buildRelayUrl(
        relayBaseUrl,
        `/api/push/register/${encodeURIComponent(params.device.deviceClientId)}`,
      ),
      { method: 'DELETE' },
    ).catch(() => undefined);
  }
}

export async function isWebPushEnabled(accountId: string): Promise<boolean> {
  if (!isWebPushSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  if (!registration) return false;
  const sub = await registration.pushManager.getSubscription();
  return sub !== null && localStorage.getItem(subscriptionIdKey(accountId)) !== null;
}
