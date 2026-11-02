// Browser-side Web Push setup. Mirrors the React Native flow in
// repos/react-native/src/lib/push-notifications.ts so the relay sees the same
// shape from both clients - the only differences are which native API
// produces the push token (PushManager.subscribe here, FCM there) and which
// register endpoint we hit on the relay.

import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { AccountInfo, EmailPushConfig, Mailbox } from '@/lib/jmap/types';
import { isJmapSetError, jmapErrorType } from '@/lib/jmap/jmap-error';
import { DEFAULT_RELAY_BASE_URL } from '@/lib/push-relays';
import { isBuiltInHost, relayAllowed } from '@/lib/outgoing-hosts';
import { noThirdPartyTraffic } from '@/lib/third-party-mode';
import { IS_LITE } from '@/lib/lite';
import { serviceWorkerUrl, SW_SCOPE } from '@/lib/app-update';
import {
  EMPTY_NOTIFICATION_MUTES,
  isAccountMuted,
  isMailboxMuted,
  mailboxOverridesForAccount,
  type NotificationMutes,
} from '@/lib/notification-mutes';

// Per-account keys: a single browser may be signed in to multiple accounts,
// each with its own JMAP PushSubscription and its own relay record. Scoping
// the deviceClientId per account is what makes per-account notifications work
// at all - the relay keys subscriptions on subscriptionId (= deviceClientId),
// so a globally-shared key meant re-registering account B overwrote A.
const DEVICE_CLIENT_ID_PREFIX = 'bulwark.push.deviceClientId.v1.';
const SUBSCRIPTION_ID_PREFIX = 'bulwark.push.subscriptionId.v1.';
// JMAP account ids the server refused in this account's emailPush map (see
// emailPushFallbacks). Left out of the map from then on, so a refusal isn't
// provoked again on every page load. Re-register and disable clear it.
const EMAIL_PUSH_REFUSED_PREFIX = 'bulwark.push.emailPushRefused.v1.';

function deviceClientIdKey(accountId: string): string {
  return DEVICE_CLIENT_ID_PREFIX + accountId;
}

function subscriptionIdKey(accountId: string): string {
  return SUBSCRIPTION_ID_PREFIX + accountId;
}

/**
 * The relay base a registration was made with. The server's PushSubscription
 * points at it, so a later change of relay (the admin's list, or the built-in
 * one going away with no third-party traffic, #903) needs a new record.
 */
const RELAY_BASE_PREFIX = 'bulwark.push.relayBase.v1.';
function relayBaseKey(accountId: string): string {
  return RELAY_BASE_PREFIX + accountId;
}

function emailPushRefusedKey(accountId: string): string {
  return EMAIL_PUSH_REFUSED_PREFIX + accountId;
}


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

// draft-ietf-jmap-emailpush (Stalwart >= 0.16.16). `EmailDelivery` alone
// still fires for every ingested message - including spam the server files
// straight into Junk - because the server can't know which folders a client
// cares about. With `emailPush` the server evaluates a per-account filter
// against each new message before pushing and stays silent on a miss, so
// junk-filed mail never wakes the device. Older servers don't advertise the
// capability and get the plain EmailDelivery subscription as before.
export const EMAIL_PUSH_CAPABILITY = 'urn:ietf:params:jmap:emailpush';

// Only ids: the relay stays content-blind and the SW dedupes on them. Never
// add from, subject or preview: they would reach the push service around
// the device policy "Push without sender and subject" (its text is held
// back in app/api/push/preview). A test keeps this list as it is.
export const EMAIL_PUSH_PROPERTIES: readonly string[] = ['id', 'threadId'];

function sameTypes(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

export function serverSupportsEmailPush(client: IJMAPClient): boolean {
  try {
    return EMAIL_PUSH_CAPABILITY in (client.getCapabilities() ?? {});
  } catch {
    return false;
  }
}

/**
 * The delivery filter we want on every account the subscription fans out to.
 *
 * Default mode: skip anything the spam filter tagged `$junk` and anything
 * that lives only in a Junk-role mailbox (Sieve `fileinto` doesn't set the
 * keyword). The two are ANDed so a stale mailbox id - the user deleted and
 * recreated Junk - degrades to keyword-only filtering rather than letting
 * everything through.
 *
 * Inbox-only mode: same `$junk` keyword guard, but the mailbox condition
 * requires the message to be IN the account's Inbox rather than merely NOT
 * in Junk - mail a Sieve rule files into any other folder stays silent. A
 * group account with no Inbox we can see gets a filter that never matches:
 * leaving it out of the map would make the server fall back to unfiltered
 * pushes for that account.
 *
 * Only the primary account and the accounts that list emailpush in their
 * accountCapabilities go in the map. Stalwart fans a subscription out to the
 * user's own account and their groups only, and refuses the whole map as
 * `forbidden` when it names a mailbox shared by ACL. 1.0 lists emailpush on
 * exactly those accounts; 0.16.16 to 0.16.23 list it on every account, and
 * enableWebPush narrows the map when the server refuses it.
 *
 * Muted accounts and folders (#1169) are cut out of the same filter. In the
 * default mode a muted folder joins Junk in the "not only in" list; a muted
 * account only lets through mail in the folders the user unmuted again, or
 * nothing at all. In inbox-only mode a muted Inbox silences the account.
 */
export async function buildEmailPushConfig(
  client: IJMAPClient,
  inboxOnly: boolean,
  mutes: NotificationMutes = EMPTY_NOTIFICATION_MUTES,
): Promise<Record<string, EmailPushConfig>> {
  const primary = client.getAccountId();
  // Every such account that has any mailbox gets a filter entry - a group
  // account without a Junk-role mailbox still needs one so its subscription
  // isn't left unfiltered.
  const accountIds = new Set<string>([primary]);
  const junkByAccount = new Map<string, string[]>();
  const inboxByAccount = new Map<string, string>();
  const mailboxIdsByAccount = new Map<string, Set<string>>();
  // In inbox-only mode a swallowed fetch failure would masquerade as "no Inbox
  // mailbox" below, and with mutes it would drop them all and unmute
  // everything, so let the real error surface; otherwise the default mode can
  // still degrade to keyword-only filtering on a transient miss.
  const hasMutes = mutes.accounts.length > 0 || Object.keys(mutes.mailboxes).length > 0;
  const mailboxes = inboxOnly || hasMutes
    ? await client.getAllMailboxes()
    : await client.getAllMailboxes().catch(() => [] as Mailbox[]);
  for (const m of mailboxes) {
    const accountId = m.accountId || primary;
    if (accountId !== primary && !client.hasAccountCapability(EMAIL_PUSH_CAPABILITY, accountId)) continue;
    accountIds.add(accountId);
    // Shared-account mailboxes carry a client-side "<account>:<id>" id;
    // the server only knows the original.
    const serverId = m.originalId ?? m.id;
    const ids = mailboxIdsByAccount.get(accountId) ?? new Set<string>();
    ids.add(serverId);
    mailboxIdsByAccount.set(accountId, ids);
    if (m.role === 'junk') {
      const junk = junkByAccount.get(accountId) ?? [];
      junk.push(serverId);
      junkByAccount.set(accountId, junk);
    }
    if (m.role === 'inbox') inboxByAccount.set(accountId, serverId);
  }

  const config: Record<string, EmailPushConfig> = {};
  for (const accountId of accountIds) {
    const junkIds = junkByAccount.get(accountId) ?? [];
    // Settings for folders that no longer exist are left out.
    const existing = mailboxIdsByAccount.get(accountId) ?? new Set<string>();
    const overrides = mailboxOverridesForAccount(mutes, accountId);
    const conditions: Record<string, unknown>[] = [{ notKeyword: '$junk' }];
    if (inboxOnly) {
      const inboxId = inboxByAccount.get(accountId);
      // The primary account always has an Inbox; missing it means its
      // Mailbox/get failed, and muting it would be worse than failing loudly.
      if (!inboxId && accountId === primary) {
        throw new Error(`No Inbox mailbox found for account ${accountId}; cannot build an inbox-only push filter`);
      }
      conditions.push(inboxId && !isMailboxMuted(mutes, accountId, inboxId)
        ? { inMailbox: inboxId }
        : NEVER_MATCH);
    } else if (isAccountMuted(mutes, accountId)) {
      const allowed = overrides.unmuted
        .filter((id) => existing.has(id) && !junkIds.includes(id))
        .sort();
      if (allowed.length === 0) conditions.push(NEVER_MATCH);
      else if (allowed.length === 1) conditions.push({ inMailbox: allowed[0] });
      else conditions.push({ operator: 'OR', conditions: allowed.map((id) => ({ inMailbox: id })) });
    } else {
      const excluded = new Set([...junkIds, ...overrides.muted.filter((id) => existing.has(id))]);
      if (excluded.size > 0) conditions.push({ inMailboxOtherThan: [...excluded].sort() });
    }
    config[accountId] = {
      // Always the operator form: that's how the server echoes it back, so a
      // stored config compares equal to a freshly built one.
      filter: { operator: 'AND', conditions },
      properties: [...EMAIL_PUSH_PROPERTIES],
      urgency: 'high',
    };
  }
  return config;
}

// Contradicts the `notKeyword: '$junk'` every filter starts with, so the AND
// never matches: the account stays in the map but never pushes.
const NEVER_MATCH = { hasKeyword: '$junk' } as const;

function normalizeEmailPush(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sortKeys(value ?? null));
}

function sameEmailPush(
  a: Record<string, EmailPushConfig> | null | undefined,
  b: Record<string, EmailPushConfig>,
): boolean {
  if (!a) return false;
  return normalizeEmailPush(a) === normalizeEmailPush(b);
}

// RFC 9670. Stalwart 1.0 lists it in every account's accountCapabilities,
// 0.16 in none.
const PRINCIPALS_OWNER_CAPABILITY = 'urn:ietf:params:jmap:principals:owner';

/**
 * Whether the account capabilities name the accounts a subscription reaches:
 * Stalwart 1.0 lists emailpush on the user's own account and their groups
 * only. 0.16.16 to 0.16.23 list it on every account, ACL shares included, and
 * 0.16.6 to 0.16.15 on none, so there the client has to work it out.
 */
function emailPushCapabilityIsExact(client: IJMAPClient): boolean {
  return client.hasAccountCapability(PRINCIPALS_OWNER_CAPABILITY, client.getAccountId());
}

// Stalwart marks the accounts a user owns - their own and the groups they
// belong to - through the create flags of its per-account collection
// capabilities: true there, false on accounts shared with them by ACL. A user
// without calendars, contacts or files has none of the flags, so their groups
// don't look owned either; ownGroupAccounts finds those on 0.16.
const OWNERSHIP_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['urn:ietf:params:jmap:calendars', 'mayCreateCalendar'],
  ['urn:ietf:params:jmap:contacts', 'mayCreateAddressBook'],
  ['urn:ietf:params:jmap:filenode', 'mayCreateTopLevelFileNode'],
];

function looksOwned(info: AccountInfo | null): boolean {
  if (!info) return false;
  if (info.isPersonal) return true;
  if (info.isReadOnly) return false;
  return OWNERSHIP_FLAGS.some(([urn, flag]) => {
    const capability = info.accountCapabilities[urn] as Record<string, unknown> | undefined;
    return capability?.[flag] === true;
  });
}

/**
 * Which of `accountIds` are groups the user belongs to, as far as Stalwart
 * 0.16 shows it: it gives a group's members an identity for each of the
 * group's addresses and names the group's account after its address. An
 * account shared by ACL has neither. A group whose identity the member
 * deleted goes unrecognised.
 */
function ownGroupAccounts(client: IJMAPClient, accountIds: Iterable<string>, identityEmails: Iterable<string>): Set<string> {
  const addresses = new Set(Array.from(identityEmails, (email) => email.trim().toLowerCase()));
  return new Set(Array.from(accountIds).filter((id) => {
    const info = client.getAccountInfo(id);
    return !!info && !info.isPersonal && addresses.has(info.name.trim().toLowerCase());
  }));
}

/**
 * The emailPush maps to try, widest first. Stalwart refuses the whole map as
 * `forbidden` when it names an account the user neither owns nor belongs to
 * as a group member - a mailbox shared by ACL - and only fans a subscription
 * out to owned accounts anyway, so dropping the others loses nothing.
 *
 * On 1.0 the map already holds only the accounts the capabilities allow, so
 * the only fallback is the primary account, which is always accepted. 0.16
 * lists both kinds of account as isPersonal:false, isReadOnly:false, so its
 * first fallback keeps the groups the user's identities reveal and the
 * accounts that look owned (see OWNERSHIP_FLAGS), and its last the primary
 * account alone.
 */
async function emailPushFallbacks(
  client: IJMAPClient,
  desired: Record<string, EmailPushConfig>,
): Promise<Record<string, EmailPushConfig>[]> {
  const primary = client.getAccountId();
  const keep = (predicate: (id: string) => boolean) =>
    Object.fromEntries(Object.entries(desired).filter(([id]) => id === primary || predicate(id)));
  const steps = [keep(() => false)];
  if (!emailPushCapabilityIsExact(client)) {
    // Without the identities no group is recognised, as before.
    const identities = await client.getIdentities().catch(() => []);
    const groups = ownGroupAccounts(client, Object.keys(desired), identities.map((identity) => identity.email));
    steps.unshift(keep((id) => groups.has(id) || looksOwned(client.getAccountInfo(id))));
  }
  const out = [desired];
  for (const next of steps) {
    // Only steps that actually drop an account are worth another round-trip.
    if (Object.keys(next).length < Object.keys(out[out.length - 1]).length) out.push(next);
  }
  return out;
}

/**
 * Run a subscription write that carries `emailPush`, narrowing the map along
 * emailPushFallbacks while the server refuses it with a `forbidden` SetError.
 * Anything else - a method-level error, overQuota, a failed request - would
 * fail the same way with a narrower map, so it is thrown as is. Resolves to
 * the write's result and the map the server took.
 */
async function writeWithEmailPush<T>(
  client: IJMAPClient,
  emailPush: Record<string, EmailPushConfig> | null,
  write: (emailPush: Record<string, EmailPushConfig> | null) => Promise<T>,
): Promise<{ result: T; emailPush: Record<string, EmailPushConfig> | null }> {
  let attempts: (Record<string, EmailPushConfig> | null)[] = [emailPush];
  for (let i = 0; ; i++) {
    try {
      return { result: await write(attempts[i]), emailPush: attempts[i] };
    } catch (err) {
      // Only a refused map is worth retrying with a narrower one.
      if (!emailPush || !isJmapSetError(err) || jmapErrorType(err) !== 'forbidden') throw err;
      // The narrower maps are worked out only once the server refused one.
      if (i === 0) attempts = await emailPushFallbacks(client, emailPush);
      if (i === attempts.length - 1) throw err;
    }
  }
}

function readRefusedEmailPushAccounts(accountId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(emailPushRefusedKey(accountId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** Add the accounts the server dropped from `wanted` to reach `accepted`. */
function rememberRefusedEmailPushAccounts(
  accountId: string,
  refusedBefore: string[],
  wanted: Record<string, EmailPushConfig> | null,
  accepted: Record<string, EmailPushConfig> | null,
): void {
  if (!wanted || !accepted) return;
  const refusedNow = Object.keys(wanted).filter((id) => !(id in accepted));
  if (refusedNow.length === 0) return;
  localStorage.setItem(
    emailPushRefusedKey(accountId),
    JSON.stringify(Array.from(new Set([...refusedBefore, ...refusedNow]))),
  );
}

function withoutAccounts(
  config: Record<string, EmailPushConfig>,
  accountIds: string[],
): Record<string, EmailPushConfig> {
  return Object.fromEntries(Object.entries(config).filter(([id]) => !accountIds.includes(id)));
}

/**
 * Which of `accountIds` (accounts the user sees mailboxes in) background
 * notifications don't reach: mailboxes others share with the user by ACL.
 * Stalwart only fans a subscription out to the user's own account and their
 * groups, whatever the emailPush map says, on every version.
 *
 * 1.0 leaves emailpush out of exactly those accounts' capabilities, and that
 * settles it. 0.16 doesn't say, so there it is the accounts the server refused
 * in the map and the ones that don't look owned, minus the groups the user's
 * identities (`identityEmails`) reveal: a group member without calendars,
 * contacts or files has no create flag to go by.
 */
export function mailAccountsWithoutPush(
  client: IJMAPClient,
  accountIds: Iterable<string>,
  identityEmails: Iterable<string> = [],
): string[] {
  const primary = client.getAccountId();
  const others = Array.from(new Set(accountIds)).filter((id) => id && id !== primary);
  if (others.length === 0) return [];
  if (emailPushCapabilityIsExact(client)) {
    return others.filter((id) => !client.hasAccountCapability(EMAIL_PUSH_CAPABILITY, id));
  }
  const groups = ownGroupAccounts(client, others, identityEmails);
  const refused = readRefusedEmailPushAccounts(primary);
  return others.filter((id) => !groups.has(id) && (refused.includes(id) || !looksOwned(client.getAccountInfo(id))));
}

export interface EnableWebPushParams {
  client: IJMAPClient;
  // Optional - falls back to DEFAULT_RELAY_BASE_URL.
  relayBaseUrl?: string;
  // Free-form label (callers pass the sign-in name). The relay stores it with
  // the registration and copies it into every push it forwards: encrypted for
  // the browser in a Web Push payload, readable to Google and Apple in the FCM
  // and APNs payloads of the native apps. It is not part of the relay's
  // /metrics.
  accountLabel?: string;
  // Destroy the recorded server-side subscription and create a brand-new one
  // instead of refreshing the existing record's expiry. Stalwart binds the set
  // of accounts a subscription fans out to at creation time, so a subscription
  // that outlives a permission change keeps pushing for mailboxes the user can
  // no longer read - recreating is the only client-side remedy (#841).
  forceRecreate?: boolean;
  // Scope OS push notifications to Inbox-only mail. Mirrors settings-store's
  // pushNotifyInboxOnly. Required, not optional: it changes the server-side
  // delivery filter, so every caller must decide explicitly.
  inboxOnly: boolean;
  // Muted accounts and folders, settings-store's notificationMutes (#1169).
  mutes?: NotificationMutes;
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
  // No service worker is registered in the static Lite build (see
  // components/service-worker-registration.tsx), so push cannot be enabled.
  if (IS_LITE) return false;
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Every relay request is built here, so the built-in relay can't be reached in the no-third-party mode (#903). */
function buildRelayUrl(base: string, suffix: string): string {
  if (!relayAllowed(base)) throw new Error('The built-in push relay is off: this server does not contact outside services');
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

// A browser that doesn't expose the key it subscribed with counts as a
// mismatch: we can't prove the subscription belongs to this relay.
function sameKey(existing: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!existing) return false;
  const bytes = new Uint8Array(existing);
  if (bytes.length !== expected.length) return false;
  return bytes.every((byte, i) => byte === expected[i]);
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
    registration = await navigator.serviceWorker.register(serviceWorkerUrl(), { scope: SW_SCOPE });
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

// Push the subscription's expiry forward and re-sync `types` / the delivery
// filter when they drift. Resolves to false when the server refused the
// update with a SetError (the subscription is gone, or no narrower map is
// accepted), which the caller answers with a replacement; otherwise to the
// emailPush map the update installed (null when it left the filter alone).
// Every other failure - the network, a timeout, rate limiting, a method-level
// error - says nothing about the subscription and is thrown.
async function refreshSubscriptionExpires(
  client: IJMAPClient,
  sub: {
    id: string;
    expires: string | null;
    types: string[] | null;
    emailPush?: Record<string, EmailPushConfig> | null;
  },
  // null when the server has no emailPush support - leave the property alone.
  desiredEmailPush: Record<string, EmailPushConfig> | null,
): Promise<false | { emailPush: Record<string, EmailPushConfig> | null }> {
  const typesNeedUpdate = !sameTypes(sub.types, PUSH_TYPES);
  // Also re-sync the delivery filter: a subscription created before this
  // client learned about emailPush has none, and the Junk mailbox id can
  // change under us.
  const emailPushNeedsUpdate = desiredEmailPush !== null && !sameEmailPush(sub.emailPush, desiredEmailPush);
  if (!typesNeedUpdate && !emailPushNeedsUpdate && sub.expires) {
    const remainingMs = new Date(sub.expires).getTime() - Date.now();
    const thresholdMs = SUBSCRIPTION_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(remainingMs) && remainingMs > thresholdMs) return { emailPush: null };
  }
  const patch: { expires?: string; types?: string[] } = {
    expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
  };
  if (typesNeedUpdate) patch.types = [...PUSH_TYPES];
  try {
    const { emailPush } = await writeWithEmailPush(
      client,
      emailPushNeedsUpdate ? desiredEmailPush : null,
      (filter) => client.updatePushSubscription(sub.id, filter ? { ...patch, emailPush: filter } : patch),
    );
    return { emailPush };
  } catch (err) {
    if (isJmapSetError(err)) return false;
    throw err;
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
  //
  // Only reuse it if it was made with THIS relay's key. A subscription is
  // bound to the VAPID key it was created with, so one left over from another
  // relay (or from before this relay rotated its keys) is rejected by the push
  // service on every send - Mozilla answers 401 "VAPID public key mismatch" -
  // while isWebPushEnabled keeps reporting push as on.
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
  // A stale or broken local record makes Firefox reject the lookup itself with
  // `AbortError: Error retrieving push subscription`, which would abort the
  // whole enable. There is nothing to reuse in that case, so carry on to
  // subscribe() and let its own error surface if the push service is really
  // unreachable.
  let pushSubscription = await registration.pushManager.getSubscription().catch(() => null);
  if (
    pushSubscription
    && !sameKey(pushSubscription.options?.applicationServerKey, applicationServerKey)
  ) {
    // An unsubscribe that fails leaves the old record in place; subscribing
    // with the right key is what matters, so don't abort the enable for it.
    await pushSubscription.unsubscribe().catch(() => undefined);
    pushSubscription = null;
  }
  if (!pushSubscription) {
    pushSubscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
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
  // forceRecreate we replace it instead: the account set a Stalwart
  // subscription fans out to is fixed at creation time, so refreshing
  // `expires` carries stale permissions forward and only a new record picks up
  // revoked shared-mailbox access (#841). Either way the old record keeps
  // delivering until its replacement is verified, so a replacement the server
  // refuses never leaves the browser without push.
  //
  // A failed listing ends the run here: taken for "the server has no
  // subscription", it would drop the key of a working registration and push
  // would read as off from then on.
  const existingSubs = await params.client.listPushSubscriptions();
  // A forced re-registration re-learns which accounts the server accepts in
  // the emailPush map.
  if (params.forceRecreate) localStorage.removeItem(emailPushRefusedKey(accountId));
  // On 1.0 the capabilities the map is built from already leave out every
  // account the server refuses; a list remembered under 0.16 could only keep
  // a group out.
  const refusedBefore = emailPushCapabilityIsExact(params.client) ? [] : readRefusedEmailPushAccounts(accountId);
  const emailPush = serverSupportsEmailPush(params.client)
    ? withoutAccounts(await buildEmailPushConfig(params.client, params.inboxOnly, params.mutes), refusedBefore)
    : null;
  const subIdKey = subscriptionIdKey(accountId);
  const storedServerId = localStorage.getItem(subIdKey);
  let replacedServerId: string | null = null;
  if (storedServerId) {
    const match = existingSubs.find((s) => s.id === storedServerId);
    if (match) {
      if (!params.forceRecreate) {
        const refreshed = await refreshSubscriptionExpires(params.client, match, emailPush);
        if (refreshed) {
          rememberRefusedEmailPushAccounts(accountId, refusedBefore, emailPush, refreshed.emailPush);
          return { subscriptionId: storedServerId };
        }
      }
      // The server refused the refresh, or the caller asked for a fresh
      // record: create a replacement below and destroy this one once the
      // replacement is verified.
      replacedServerId = storedServerId;
    }
    // When the server no longer has it (expired, or revoked elsewhere), the
    // stored id stays until the replacement is verified below: it is
    // what tells resyncWebPush this account opted in, so dropping it here
    // would end recovery for good after one interrupted attempt.
  }

  // Reap leftover subscriptions that would otherwise starve the new one's
  // verification. Stalwart emits only one PushVerification per account per
  // ~60s; up to 0.16.13 it picks the first unverified subscription it stores,
  // usually the oldest, so a single stale straggler blocks every fresh attempt
  // - the symptom is the confusing "Timed out waiting for PushVerification"
  // error (0.16.14 and later pick the newest). We can't read a subscription's
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

  const create = () => writeWithEmailPush(params.client, emailPush, (filter) =>
    params.client.createPushSubscription({
      deviceClientId,
      url: buildRelayUrl(relayBaseUrl, `/api/push/jmap/${encodeURIComponent(deviceClientId)}`),
      types: [...PUSH_TYPES],
      expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
      ...(filter ? { emailPush: filter } : {}),
    }),
  );
  let created: Awaited<ReturnType<typeof create>>;
  try {
    created = await create();
  } catch (err) {
    // Stalwart caps the subscriptions of an account (15 by default) and counts
    // the one being replaced, so at the cap Re-register could never create
    // its replacement. The user asked for a new record: free the old one's
    // place and try once more. Should that fail too, push is off and the
    // error says why.
    if (!params.forceRecreate || !replacedServerId || jmapErrorType(err) !== 'overQuota') throw err;
    await params.client.destroyPushSubscription(replacedServerId);
    localStorage.removeItem(subIdKey);
    replacedServerId = null;
    created = await create();
  }
  const serverAssignedId = created.result;
  rememberRefusedEmailPushAccounts(accountId, refusedBefore, emailPush, created.emailPush);

  const verificationCode = await pollVerificationCode(relayBaseUrl, deviceClientId);
  await params.client.verifyPushSubscription(serverAssignedId, verificationCode);
  localStorage.setItem(subIdKey, serverAssignedId);
  localStorage.setItem(relayBaseKey(accountId), relayBaseUrl);
  if (replacedServerId) {
    await params.client.destroyPushSubscription(replacedServerId).catch(() => undefined);
  }

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
  localStorage.removeItem(relayBaseKey(accountId));
  // Enabling again starts from the full emailPush map.
  localStorage.removeItem(emailPushRefusedKey(accountId));

  if (deviceClientId && relayBaseUrl && relayAllowed(relayBaseUrl)) {
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
  if (relayBaseUrl && relayAllowed(relayBaseUrl) && params.device.deviceClientId) {
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

// When each account was last re-synced during this page load, and whether
// that attempt worked. Once a day is enough for the drift between sessions
// (a client update that changed what we subscribe to, a recreated Junk
// mailbox), but not only once: Stalwart clamps `expires` to 7 days, so a tab
// or installed app left open for a week would otherwise let the subscription
// lapse and push stop silently.
const RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
// After a failed attempt: soon again, but not on every return to the tab.
const RESYNC_RETRY_MS = 15 * 60 * 1000;
interface ResyncAttempt {
  at: number;
  ok: boolean;
}
const lastResync = new Map<string, ResyncAttempt>();
// Re-syncs still running, per account. One at a time per login: they share
// the browser's single PushSubscription, and a parallel re-create would race
// on it. Also what lets the onboarding prompt wait instead of asking the
// user to enable push the re-sync is just restoring (#1321).
const inFlightResync = new Map<string, Promise<boolean>>();

export interface ResyncWebPushParams {
  client: IJMAPClient;
  relayBaseUrl?: string;
  accountLabel?: string;
  // Mirrors settings-store's pushNotifyInboxOnly - see EnableWebPushParams.
  inboxOnly: boolean;
  mutes?: NotificationMutes;
  // Skip the once-a-day limit: the filter itself changed (a folder was
  // muted) and has to reach the server now.
  force?: boolean;
}

/**
 * Bring an already-enabled push registration up to date without any user
 * action: refresh its expiry and install/repair the delivery filter. Nothing
 * here can prompt - it requires a saved opt-in and granted permission -
 * and every failure is swallowed because the app must not care whether the
 * background touch-up worked. A failed re-sync leaves the registration and
 * its key as they were. Returns true when a re-sync actually ran.
 */
export function resyncWebPush(params: ResyncWebPushParams): Promise<boolean> {
  let accountId: string;
  try {
    accountId = params.client.getAccountId();
  } catch {
    return Promise.resolve(false);
  }
  if (!accountId) return Promise.resolve(false);
  const pending = inFlightResync.get(accountId);
  if (pending) {
    if (!params.force) return pending;
    // The filter changed while a re-sync runs: send it once that one is done.
    return pending.then(() => resyncWebPush(params));
  }
  // Registered before the first await, so a waiter that asks in the same
  // tick already sees this run.
  const run: Promise<boolean> = runResync(accountId, params).finally(() => {
    if (inFlightResync.get(accountId) === run) inFlightResync.delete(accountId);
  });
  inFlightResync.set(accountId, run);
  return run;
}

async function runResync(accountId: string, params: ResyncWebPushParams): Promise<boolean> {
  try {
    // The browser may have lost its endpoint while our saved opt-in and
    // server registration survived. Recreate it through the normal enable
    // flow instead of skipping the account in that state, which is what
    // isWebPushEnabled (it requires a live browser subscription) would do.
    if (!isWebPushSupported() || Notification.permission !== 'granted'
      || !localStorage.getItem(subscriptionIdKey(accountId))) return false;
    // Registered with the built-in relay before third-party traffic was
    // turned off, and no relay of the organisation's own to move to: drop the
    // server's PushSubscription so the mail server stops pinging that relay
    // (#903). disableWebPush skips the relay itself.
    if (!params.relayBaseUrl && noThirdPartyTraffic()) {
      await disableWebPush({ client: params.client });
      return false;
    }
    // The registration points at another relay than the one to use now (the
    // admin changed the list, or the built-in relay went away with no
    // third-party traffic): make a new server record that points here. A
    // registration from before the relay was remembered counts as the
    // built-in one in that mode.
    const current = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
    const registeredWith = localStorage.getItem(relayBaseKey(accountId));
    const moved = !!current && (
      (registeredWith !== null && registeredWith !== current)
      || (noThirdPartyTraffic() && (registeredWith === null || isBuiltInHost(registeredWith)) && !isBuiltInHost(current))
    );
    if (!moved && !params.force && !(await resyncDue(accountId))) return false;
    await enableWebPush({
      client: params.client,
      forceRecreate: moved,
      relayBaseUrl: params.relayBaseUrl,
      accountLabel: params.accountLabel,
      inboxOnly: params.inboxOnly,
      mutes: params.mutes,
    });
    lastResync.set(accountId, { at: Date.now(), ok: true });
    return true;
  } catch {
    // A failed attempt must not wait a day for the next one, nor rerun the
    // whole enable on every tab focus.
    lastResync.set(accountId, { at: Date.now(), ok: false });
    return false;
  }
}

async function resyncDue(accountId: string): Promise<boolean> {
  const last = lastResync.get(accountId);
  if (!last) return true;
  const elapsed = Date.now() - last.at;
  if (!last.ok) return elapsed >= RESYNC_RETRY_MS;
  if (elapsed >= RESYNC_INTERVAL_MS) return true;
  // Inside the daily limit, but the browser may have dropped the subscription
  // since (Safari does when site data is cleared, Firefox when the push
  // service expires it). A tab that stays open would otherwise go without
  // push until it is reloaded. The check is local, so it can run on every
  // return to the tab.
  return browserSubscriptionLost();
}

// Whether the browser no longer holds a push subscription for our service
// worker. A missing registration counts as lost too: enableWebPush puts it
// back.
async function browserSubscriptionLost(): Promise<boolean> {
  const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE).catch(() => null);
  if (!registration) return true;
  const sub = await registration.pushManager.getSubscription().catch(() => null);
  return sub === null;
}

/**
 * Settles once no re-sync is running for the account; at once when none is.
 * isWebPushEnabled says "off" while a re-sync recreates the browser
 * subscription, so a caller that would act on "off" - the onboarding prompt -
 * waits for this first (#1321).
 */
export function waitForWebPushResync(accountId: string): Promise<void> {
  const pending = inFlightResync.get(accountId);
  if (!pending) return Promise.resolve();
  // A forced update may have queued up behind this run.
  return pending.then(() => waitForWebPushResync(accountId));
}

// Test hook: forget which accounts were re-synced during this page load.
export function resetWebPushResyncState(): void {
  lastResync.clear();
  inFlightResync.clear();
}

export interface BulkWebPushTarget {
  accountId: string;
  client: IJMAPClient;
  accountLabel?: string;
}

export interface BulkWebPushResult {
  enabled: string[];
  /** Accounts left untouched, with the reason the first failure gave. */
  failed: Array<{ accountId: string; error: unknown }>;
}

/**
 * Enable push for several accounts against one browser subscription.
 *
 * The browser only ever holds a single PushSubscription: `enableWebPush` reuses
 * it and registers one server-side subscription per account, which is why every
 * account has to be walked separately. Sequential on purpose - the first call
 * is the one that may prompt for permission, and parallel prompts race.
 *
 * A browser-level refusal (unsupported, permission denied or dismissed) applies
 * to every account, so it stops the walk instead of failing them one by one.
 */
export async function enableWebPushForAccounts(
  targets: BulkWebPushTarget[],
  // inboxOnly mirrors settings-store's pushNotifyInboxOnly, as for a single account.
  options: { relayBaseUrl?: string; forceRecreate?: boolean; inboxOnly: boolean; mutes?: NotificationMutes },
): Promise<BulkWebPushResult> {
  const result: BulkWebPushResult = { enabled: [], failed: [] };
  let browserRefusal: unknown;
  for (const target of targets) {
    if (browserRefusal !== undefined) {
      result.failed.push({ accountId: target.accountId, error: browserRefusal });
      continue;
    }
    try {
      await enableWebPush({
        client: target.client,
        relayBaseUrl: options.relayBaseUrl,
        accountLabel: target.accountLabel,
        forceRecreate: options.forceRecreate,
        inboxOnly: options.inboxOnly,
        mutes: options.mutes,
      });
      result.enabled.push(target.accountId);
    } catch (error) {
      if (error instanceof WebPushUnsupportedError || !isWebPushSupported()
        || Notification.permission !== 'granted') browserRefusal = error;
      result.failed.push({ accountId: target.accountId, error });
    }
  }
  return result;
}
