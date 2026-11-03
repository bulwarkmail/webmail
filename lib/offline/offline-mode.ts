/**
 * Offline mode (#523): "Keep mail on this device".
 *
 * - Opt-in per account and per browser (state.ts), off by default, hidden
 *   and wiped when the organisation forbids it (policy.json
 *   `organisation.devices.noOffline`, per account) and in Lite.
 * - While on, the local store (lib/store, a database in a worker) keeps the
 *   account's mail in sync by itself, and the JMAP client asks it when the
 *   network is gone. This file is the orchestration around it: who may use
 *   it, when it syncs and flushes, the wipes.
 * - Changes and sends made offline wait in the store's outbox and go out in
 *   order once the server answers again and the organisation's policy was
 *   fetched afresh (flush.ts).
 * - Everything is wiped at a full sign-out, at the session limits and when the
 *   server really refuses the login (`invalid_grant`), by
 *   lib/sign-out-cleanup.ts; for one account when it signs out, is removed or
 *   switches offline mode off, and when the organisation forbids it (checked on
 *   every policy fetch). An account the app drops by itself because it couldn't
 *   confirm the login (an outage, an unknown refusal, a session cookie that ran
 *   out) keeps its data for 30 days or the next sign-in, hidden from everyone
 *   else. Unsent messages a sign-out deletes without the user's word are named
 *   (lost.ts).
 */

import { IS_LITE } from '@/lib/lite';
import { devicesForAccount } from '@/lib/device-policy';
import { accountSubjectPending, useAccountSubjects } from '@/lib/org/account-subjects';
import { labelsPolicyFor } from '@/lib/outgoing/classification';
import { getSendGuardSource, guardState, guardsSending } from '@/lib/plugin-send-guards';
import { emitPushStateChange } from '@/lib/push-events';
import { requestOutboxSync } from '@/lib/pwa-notify/outbox-sync';
import { STORAGE_ERROR_AREA } from '@/lib/store/area';
import { configureStore, getStore, type StorePageHooks } from '@/lib/store/client/api';
import { purgeStoreFiles } from '@/lib/store/client/purge';
import type { StoreSession } from '@/lib/store/engine/transport';
import { onAccountRemoved, useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore, whenPolicySettled } from '@/stores/policy-store';
import { onBeforeSignOut, onFullSignOut } from '@/lib/sign-out-cleanup';
import { generateMessageId } from '@/lib/jmap/client';
import { setOfflineHooks, type OfflineClientRef, type OfflineHooks, type OfflineMethodCall, type OfflineResponse } from '@/lib/jmap/offline-hooks';
import type { SendEmailResult } from '@/lib/jmap/types';
import { setOutboxHooks, type OutboxHooks } from './outbox-hooks';
import {
  heldFile,
  holdFile,
  isLocalBlobId,
  queueSend,
  readQueue,
  type OutboxEntry,
  type OutboxError,
  type OutboxSummary,
  type PolicyFingerprint,
} from './queue';
import { clearHandoffs } from '@/lib/launch-handoff';
import { clearEvicted, EVICTED_KEEP_MS, forgetMailSnapshot, isEvicted, offlineScopeFor, isOfflineNow, OFFLINE_ACCOUNTS_KEY, readEnabledFrom, readEvicted, visibleAccounts, serverKey, setServerDown, useOfflineStore, writeEnabled, type OutboxRow } from './state';
import { flushQueue, LOOKUP_WAIT_MS, SENDING_STALE_MS, settleStaleSends } from './flush';
import { LEGACY_DB_NAME, moveLegacyOutbox, strandedLegacyMessages } from './migrate-legacy';
import { deleteShellCaches, tellServiceWorker } from './shell';
import { rememberLost } from './lost';

export type OfflineNotice =
  | { kind: 'queued'; subject: string }
  | { kind: 'sent'; subject: string }
  | { kind: 'send-failed'; subject: string; error: OutboxError }
  | { kind: 'held'; subject: string }
  | { kind: 'lost'; subjects: string[] }
  | { kind: 'conflict'; count: number }
  | { kind: 'storage-failed' }
  | { kind: 'store-unavailable' }
  | { kind: 'store-reset' }
  | { kind: 'legacy-stranded' }
  | { kind: 'refused-delete' }
  | { kind: 'refused-other' }
  | { kind: 'forbidden' }
  | { kind: 'back-online-reload' };

let notify: (notice: OfflineNotice) => void = () => {};

/** Where the notices go (the host component turns them into toasts). */
export function setOfflineNotifier(fn: (notice: OfflineNotice) => void): void {
  notify = fn;
}

export function offlineNotify(notice: OfflineNotice): void {
  notify(notice);
}

// ---- Who may use it ----

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

/** Offline mode is possible here at all: not in Lite, with what the store needs. */
export function offlineSupported(): boolean {
  if (IS_LITE || !hasIndexedDb() || useOfflineStore.getState().storageBlocked) return false;
  try {
    return typeof crypto !== 'undefined' && !!crypto.subtle && getStore().supported();
  } catch {
    return false;
  }
}

/** The organisation allows this account to keep mail on the device. */
export function offlineAllowed(account: string | null | undefined): boolean {
  return offlineSupported() && !devicesForAccount(account ?? null).noOffline;
}

/** "Keep mail on this device" is on for this account here, and allowed. */
export function offlineActive(account: string | null | undefined): boolean {
  return !!account && useOfflineStore.getState().enabled.includes(account) && offlineAllowed(account);
}

/** The local account a JMAP client belongs to. */
export function accountForClient(client: OfflineClientRef): string | null {
  const auth = useAuthStore.getState();
  if (client === (auth.client as unknown) && auth.activeAccountId) return auth.activeAccountId;
  try {
    for (const [id, c] of auth.getAllConnectedClients()) if ((c as unknown) === client) return id;
  } catch {
    // A stand-in auth store in tests.
  }
  const server = client.getServerUrl().replace(/\/+$/, '');
  const user = client.getUsername();
  const entry = useAccountStore.getState().accounts.find((a) => a.serverUrl.replace(/\/+$/, '') === server && a.username === user);
  return entry?.id ?? null;
}

function onlineClientFor(account: string) {
  const client = useAuthStore.getState().getClientForAccount(account);
  if (!client || client.isOfflineOnly()) return null;
  return client;
}

// ---- The store's way to this tab ----

/** A full disk stays full: once in a while is enough to say so. */
const STORAGE_NOTICE_MS = 30 * 60_000;
let lastStorageNotice = 0;
let lastUnavailableNotice = 0;

/** The store won't open: what waits in it is out of reach, and the user should know why. */
function noteStoreUnavailable(): void {
  if (useOfflineStore.getState().enabled.length === 0) return;
  const now = Date.now();
  if (now - lastUnavailableNotice < STORAGE_NOTICE_MS) return;
  lastUnavailableNotice = now;
  notify({ kind: 'store-unavailable' });
}

const storeHooks: StorePageHooks = {
  inputs(account) {
    const client = onlineClientFor(account);
    return {
      session: (client?.getSessionSnapshot() as StoreSession | undefined) ?? null,
      auth: client?.getAuthHeader() ?? null,
      invertedKeywordSort: client?.keywordSortInverted() ?? null,
      scope: offlineScopeFor(account),
    };
  },
  async refreshAuth(account) {
    const client = onlineClientFor(account);
    if (!client) return null;
    // Through the client: a 401 there runs its token renewal or re-auth.
    await client.requestNetworkOnly([['Core/echo', {}, '0']]);
    return client.getAuthHeader();
  },
  onStoreLost(account) {
    // Whoever is here wasn't signed in to a dropped account: nothing to tell them.
    if (isEvicted(account)) return;
    useOfflineStore.setState((s) => ({ storeLost: [...new Set([...s.storeLost, account])] }));
    notify({ kind: 'store-reset' });
  },
  onEvent(event) {
    if (event.type === 'synced') {
      useOfflineStore.setState((s) => ({ lastSyncedAt: { ...s.lastSyncedAt, [event.account]: event.at } }));
      forgetMailSnapshot(event.account);
      void refreshUsage();
    }
    if (event.type === 'error' && event.area === STORAGE_ERROR_AREA) {
      const now = Date.now();
      if (now - lastStorageNotice < STORAGE_NOTICE_MS) return;
      lastStorageNotice = now;
      notify({ kind: 'storage-failed' });
    }
  },
};

// ---- What the client asks and tells ----

/** Parts cut short for a list view aren't what the user opened. */
function hasWholeText(email: { bodyValues?: Record<string, { isTruncated?: boolean }> }): boolean {
  const values = Object.values(email.bodyValues ?? {});
  return values.length > 0 && !values.some((value) => value?.isTruncated);
}

/** Mutating calls the device can't take: an import, calendar and contact changes. */
const NEEDS_SERVER = /^(EmailSubmission|Email\/import|CalendarEvent\/set|ContactCard\/set|AddressBook\/set|Calendar\/set|Mailbox\/set|FileNode\/set|SieveScript\/set|VacationResponse\/set|Identity\/set)/;
let lastRefusalNotice = 0;

function noticeRefused(answered: OfflineResponse | null, methodCalls: OfflineMethodCall[]): void {
  const refusedCall = methodCalls.some(([name, , id]) => NEEDS_SERVER.test(name)
    && (!answered || answered.methodResponses.some(([responseName, , responseId]) => responseId === id && responseName === 'error')));
  const refusedChange = answered?.methodResponses.some(([name, result]) => name === 'Email/set' && result?.notUpdated) ?? false;
  if (!refusedCall && !refusedChange) return;
  const now = Date.now();
  if (now - lastRefusalNotice < 5_000) return;
  lastRefusalNotice = now;
  const emptied = answered?.methodResponses.some(([name, result]) => name === 'Email/set'
    && Object.values((result?.notUpdated ?? {}) as Record<string, { type?: string }>).some((error) => error.type === 'invalidProperties'));
  notify({ kind: emptied ? 'refused-delete' : 'refused-other' });
}

const probes = new Map<string, Promise<boolean>>();
/** A black-holed connection never answers the probe either. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether a mail server is gone. Browsers report a refusal without CORS
 * headers (Stalwart answering "too many requests at once") the same way as
 * no network at all, so the server is asked once more without CORS: only
 * when that fails too is the server counted as gone, and sends to it go to
 * the outbox. Per server, so one server down doesn't hold the others' mail.
 */
export function probeServer(serverUrl: string): Promise<boolean> {
  const key = serverKey(serverUrl);
  const running = probes.get(key);
  if (running) return running;
  const probe = (async () => {
    try {
      await fetch(`${serverUrl.replace(/\/+$/, '')}/.well-known/jmap`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      if (setServerDown(serverUrl, false)) scheduleFlushAll(500);
      return false;
    } catch {
      setServerDown(serverUrl, true);
      return true;
    }
  })().finally(() => { probes.delete(key); });
  probes.set(key, probe);
  return probe;
}

const hooks: OfflineHooks = {
  skipNetwork(client) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) return false;
    return offlineActive(accountForClient(client));
  },
  async answer(client, methodCalls) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return null;
    let answered: OfflineResponse | null = null;
    try {
      answered = await getStore().answer(account, methodCalls);
    } catch {
      // The store couldn't start or lost its owner: as if nothing were kept.
    }
    noticeRefused(answered, methodCalls);
    if (methodCalls.some(([name]) => name === 'Email/set') && answered) {
      requestOutboxSync();
      void refreshQueueState();
    }
    return answered;
  },
  async resolveStandIns(client, ids) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return {};
    return getStore().area<Record<string, string | null>>(account, 'calendar.resolveStandIns', { ids }).catch(() => ({}));
  },
  fileOpened(client, accountId, id) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return;
    void getStore().area(account, 'files.noteOpened', { jmap: accountId, id }).catch(() => {});
  },
  async searchLocal(client, methodCalls) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return null;
    try {
      return await getStore().answer(account, methodCalls);
    } catch {
      return null;
    }
  },
  record(client, methodCalls, response) {
    // The store syncs by itself. What it may not have is a message the user
    // opened from outside the chosen window, so only those come through here.
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return;
    for (const [name, result, callId] of response.methodResponses) {
      if (name !== 'Email/get' || !Array.isArray(result?.list)) continue;
      const opened = (result.list as Array<{ bodyValues?: Record<string, { isTruncated?: boolean }> }>).filter(hasWholeText);
      if (opened.length === 0) continue;
      const args = methodCalls.find(([n, , id]) => id === callId && n === name)?.[1];
      const jmap = (result.accountId as string) || (args?.accountId as string) || client.getAccountId();
      // Copied now: callers change the answer's objects after this returns.
      const emails = JSON.parse(JSON.stringify(opened)) as unknown[];
      void getStore().area(account, 'mail.recordOpened', { jmap, emails }).catch(() => {});
    }
  },
  noteNetwork(client, reachable) {
    if (reachable) {
      if (setServerDown(client.getServerUrl(), false)) scheduleFlushAll(500);
    } else {
      void probeServer(client.getServerUrl());
    }
  },
  async serverGone(client, error) {
    if (!offlineActive(accountForClient(client))) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    // The proxy answered, so a probe would pass; the server behind it is what's gone.
    if (error instanceof Error && error.name === 'GatewayError') {
      setServerDown(client.getServerUrl(), true);
      return true;
    }
    return probeServer(client.getServerUrl());
  },
  stateChange(client, change) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account || !change.changed) return;
    void getStore().noteStateChange(account, change.changed).catch(() => {});
  },
  async blob(client, blobId, jmap) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account)) return null;
    if (isLocalBlobId(blobId)) return heldFile(account, blobId);
    // An attachment, or a file from the Files area.
    const kept = await getStore().area<KeptBlob | null>(account, 'mail.getBlob', { jmap, blobId }).catch(() => null)
      ?? await getStore().area<KeptBlob | null>(account, 'files.blob', { jmap, blobId }).catch(() => null);
    return kept ? new Blob([kept.data as BlobPart], { type: kept.type || 'application/octet-stream' }) : null;
  },
  recordBlob(client, blobId, jmap, blob) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account) || blob.size > MAX_RECORDED_BLOB_BYTES) return;
    // Filed under its kept message by the store: never a whole message an
    // export reads, never a stray file.
    void blob.arrayBuffer()
      .then((buffer) => getStore().area(account, 'mail.recordBlob', { jmap, blobId, type: blob.type || null, data: new Uint8Array(buffer) }))
      .catch(() => {});
  },
  async holdUpload(client, file, accountId) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account)) return null;
    return holdFile(account, file, file.name, accountId);
  },
};

interface KeptBlob { type: string | null; data: Uint8Array }

/** Attachments and images opened while online are kept up to this size. */
const MAX_RECORDED_BLOB_BYTES = 5 * 1024 * 1024;

// ---- The outbox ----

function summaryOf(args: unknown[]): OutboxSummary {
  const [to, subject, , cc, bcc] = args as [string[] | undefined, string | undefined, unknown, string[] | undefined, string[] | undefined];
  return { subject: subject ?? '', to: [...(to ?? []), ...(cc ?? []), ...(bcc ?? [])] };
}

/** Thrown instead of queueing while a plugin that may have to see the message isn't running. */
export class OfflinePluginsDownError extends Error {
  constructor() {
    super('A plugin is not running offline');
    this.name = 'OfflinePluginsDownError';
  }
}

/**
 * An enabled plugin isn't running (after a start without the network the
 * plugins can't load). It may be the user's signing or encryption plugin,
 * or a send check, so the message isn't queued: it would go out without it.
 */
export function pluginsNotRunning(): boolean {
  const source = getSendGuardSource();
  if (!source) return false;
  const { plugins, pluginsOff } = source.snapshot();
  if (pluginsOff) return false;
  return plugins.some((plugin) => plugin.status !== 'disabled' && plugin.status !== 'installed' && guardState(plugin) !== null);
}

/** The send checks the organisation requires now (forced plugins that check sends). */
function requiredGuards(): string[] {
  const source = getSendGuardSource();
  if (!source) return [];
  const { plugins, forced, pluginsOff } = source.snapshot();
  if (pluginsOff) return [];
  return [...new Set(plugins.filter((plugin) => forced(plugin) && guardsSending(plugin)).map((plugin) => plugin.id))].sort();
}

export function policyFingerprint(account: string, hasLabel: boolean): PolicyFingerprint {
  const labels = labelsPolicyFor({ accountId: account });
  return { labelRequired: labels.required && labels.list.length > 0, hasLabel, guards: requiredGuards() };
}

/** The organisation's rules got stricter since the message was finished. */
export function stricterNow(entry: OutboxEntry): boolean {
  const then = entry.fingerprint;
  if (!then) return false;
  const now = policyFingerprint(entry.account, then.hasLabel);
  if (now.labelRequired && !then.hasLabel) return true;
  return now.guards.some((id) => !then.guards.includes(id));
}

function queuedResult(outboxId: number): SendEmailResult {
  return { scheduled: false, queued: true, outboxId };
}

const outbox: OutboxHooks = {
  shouldQueue(client) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account)) return false;
    // A local copy has no way to the server, whatever the probes last said.
    if (client.isOfflineOnly?.()) return true;
    return isOfflineNow(client.getServerUrl()) || (typeof navigator !== 'undefined' && navigator.onLine === false);
  },
  async queueEmail(client, args) {
    const account = accountForClient(client);
    if (!account) throw new Error('No account for this send');
    if (pluginsNotRunning()) throw new OfflinePluginsDownError();
    const options = { ...((args[15] as Record<string, unknown> | undefined) ?? {}) };
    delete options.outbox;
    const stored = [...args.slice(0, 15), options];
    const summary = summaryOf(stored);
    const labelled = !!options.labelHeaders && Object.keys(options.labelHeaders as object).length > 0;
    // Fixed now and kept across retries: how a lost response is told from a send that never arrived.
    // Only its domain is used, and the sender may be written "Name <address>".
    const sender = ((args[6] as string | undefined) || client.getUsername()).replace(/>.*$/, '');
    const messageId = generateMessageId(sender);
    const id = await queueSend(account, summary, { kind: 'email', args: stored }, policyFingerprint(account, labelled), messageId);
    await refreshQueueState();
    notify({ kind: 'queued', subject: summary.subject });
    return queuedResult(id);
  },
  async queueRaw(client, raw, options) {
    const account = accountForClient(client);
    if (!account) throw new Error('No account for this send');
    if (pluginsNotRunning()) throw new OfflinePluginsDownError();
    const held = await holdFile(account, raw, 'message.eml');
    const { summary, labelled, messageId } = await rawSummary(raw);
    const id = await queueSend(account, summary, { kind: 'raw', blobId: held.blobId, ...options }, policyFingerprint(account, labelled), messageId);
    await refreshQueueState();
    notify({ kind: 'queued', subject: summary.subject });
    return queuedResult(id);
  },
  async resolveHeldAttachments(client, attachments) {
    const account = accountForClient(client);
    if (!account || !attachments.some((a) => isLocalBlobId(a.blobId))) return attachments;
    const real = onlineClientFor(account);
    if (!real) return attachments;
    const out = [];
    for (const attachment of attachments) {
      if (!isLocalBlobId(attachment.blobId)) { out.push(attachment); continue; }
      const file = await heldFile(account, attachment.blobId);
      if (!file) throw Object.assign(new Error('A file attached offline is no longer on this device'), { name: 'OfflineFileMissingError' });
      const { blobId } = await real.uploadBlob(file);
      out.push({ ...attachment, blobId });
    }
    return out;
  },
};

/** Subject, recipients, label and Message-ID of a raw message, for the outbox. */
async function rawSummary(raw: Blob): Promise<{ summary: OutboxSummary; labelled: boolean; messageId?: string }> {
  const head = await raw.slice(0, 64 * 1024).text();
  const end = head.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, ' ');
  const header = (name: string) => block.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? '';
  const to = ['to', 'cc'].flatMap((name) => header(name).split(',')).map((s) => s.trim()).filter(Boolean);
  return {
    summary: { subject: decodeMimeWords(header('subject')), to },
    labelled: header('sio-label') !== '',
    messageId: header('message-id').match(/<([^>\s]+)>/)?.[1],
  };
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toUpperCase() === 'B'
        ? Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
        : Uint8Array.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))), (c) => c.charCodeAt(0));
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/** Reads the queue into the store, for the outbox view and the banner. */
export async function refreshQueueState(): Promise<void> {
  if (!offlineSupported()) return;
  // Nothing is kept for an account that hasn't it on; and opening the
  // store would create it (on the sign-in page, after a sign-out).
  if (visibleAccounts().length === 0) {
    useOfflineStore.setState({ outbox: [], pendingChanges: 0, conflicts: [] });
    return;
  }
  try {
    // Sends of a tab closed on the way: uncertain, so they can be looked up.
    await settleStaleSends();
    const { failed, patches, outbox: entries, conflicts } = await readQueue();
    if (failed.length > 0) noteStoreUnavailable();
    const rows: OutboxRow[] = entries.map((entry) => ({
      id: entry.id,
      account: entry.account,
      createdAt: entry.createdAt,
      subject: entry.summary.subject,
      to: entry.summary.to,
      status: entry.status,
      error: entry.error,
    }));
    // What an account's store can't tell right now is still there.
    const unread = useOfflineStore.getState().outbox.filter((row) => failed.includes(row.account));
    useOfflineStore.setState({ outbox: [...unread, ...rows], pendingChanges: patches, conflicts });
    if (rows.some((row) => row.status === 'sending')) checkStaleSendsLater();
  } catch {
    // The store is being deleted, or can't start.
    noteStoreUnavailable();
  }
}

export async function refreshUsage(): Promise<void> {
  if (!offlineSupported() || visibleAccounts().length === 0) return;
  try {
    const usage = await Promise.all(visibleAccounts().map((account) => getStore().area<{ bytes: number }>(account, 'mail.usage')));
    useOfflineStore.setState({ usageBytes: usage.reduce((sum, { bytes }) => sum + bytes, 0) });
  } catch {
    /* deleted meanwhile */
  }
}

// ---- Sync and flush timing ----

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleSync(account: string, delayMs = 2_000): void {
  if (!offlineActive(account)) return;
  const existing = syncTimers.get(account);
  if (existing) clearTimeout(existing);
  syncTimers.set(account, setTimeout(() => {
    syncTimers.delete(account);
    void runSync(account);
  }, delayMs));
}

const syncsRunning = new Set<string>();

export async function runSync(account: string): Promise<void> {
  if (syncsRunning.has(account) || !offlineActive(account)) return;
  const client = onlineClientFor(account);
  if (!client || isOfflineNow(client.getServerUrl())) return;
  syncsRunning.add(account);
  useOfflineStore.setState((s) => ({ syncing: [...new Set([...s.syncing, account])] }));
  try {
    await getStore().ensureOpen(account);
    getStore().refresh(account);
    await getStore().sync(account);
  } catch {
    // Tried again at the next change or in 15 minutes.
  } finally {
    syncsRunning.delete(account);
    useOfflineStore.setState((s) => ({ syncing: s.syncing.filter((id) => id !== account) }));
    void refreshUsage();
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleFlushAll(delayMs = 1_000): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushAll();
  }, delayMs);
}

/** How long after a failed policy fetch the outbox asks again. */
const POLICY_RETRY_MS = 60_000;
/** A lost response with the server still there: nothing else would start the lookup. */
const LOOKUP_AGAIN_MS = LOOKUP_WAIT_MS + 1_000;

/** A send held by the server for undo, from the outbox: the undo toast as after any send. */
function offerUndo(entry: OutboxEntry, result: SendEmailResult): void {
  if (!result.emailSubmissionId || !result.sendAt) return;
  const identityId = entry.item.kind === 'raw' ? entry.item.identityId : (entry.item.args[5] as string | undefined);
  useEmailStore.setState({
    pendingUndoSend: {
      submissionId: result.emailSubmissionId,
      emailId: result.emailId,
      identityId,
      sendAt: result.sendAt,
      isSmime: entry.item.kind === 'raw',
      submissionAccountId: result.submissionAccountId,
      localAccountId: entry.account,
    },
  });
}

/**
 * What the other areas queued. The page may hold stand-in ids for what just
 * went out, so it reads again, the way a push makes it. Only the types go by
 * that way: the "state" isn't one, and nothing stores it.
 */
const AREA_FLUSHES = [
  { call: 'calendar.flush', types: ['Calendar', 'CalendarEvent'] },
  { call: 'contacts.flush', types: ['AddressBook', 'ContactCard'] },
];

async function flushAreas(account: string, client: NonNullable<ReturnType<typeof onlineClientFor>>): Promise<void> {
  for (const { call, types } of AREA_FLUSHES) {
    // Contacts may not be there in this build: nothing to flush then.
    const tally = await getStore().area<{ sent?: number; conflicts?: number | unknown[] } | null>(account, call).catch(() => null);
    if (!tally) continue;
    const conflicts = Array.isArray(tally.conflicts) ? tally.conflicts.length : tally.conflicts ?? 0;
    if (!tally.sent && !conflicts) continue;
    const role = (useAuthStore.getState().client as unknown) === client ? 'active' : 'background';
    const changed = { [client.getAccountId()]: Object.fromEntries(types.map((type) => [type, 'flushed'])) };
    emitPushStateChange({ '@type': 'StateChange', changed } as never, client, role);
  }
}

export async function flushAll(): Promise<void> {
  if (useOfflineStore.getState().startedOffline) {
    void leaveOfflineStart();
    return;
  }
  // Calendar and contact edits wait in their own areas, so what waits isn't known here.
  const { outbox: rows, enabled } = useOfflineStore.getState();
  if (rows.length === 0 && enabled.length === 0) return;
  // The organisation's current word before anything goes: a label now
  // required, a send check now required or offline mode now forbidden must
  // stop what waited under the old rules.
  await usePolicyStore.getState().fetchPolicy();
  if (usePolicyStore.getState().source !== 'server') {
    scheduleFlushAll(POLICY_RETRY_MS);
    return;
  }
  enforcePolicy();
  const accounts = new Set([...rows.map((r) => r.account), ...useOfflineStore.getState().enabled]);
  for (const account of accounts) {
    const client = onlineClientFor(account);
    if (!client || !offlineActive(account)) continue;
    await flushQueue(account, client, {
      notify,
      allowed: () => offlineAllowed(account),
      stricterNow,
      onScheduled: offerUndo,
      retryLater: () => scheduleFlushAll(LOOKUP_AGAIN_MS),
    }).catch(() => {});
    await flushAreas(account, client);
  }
  await refreshQueueState();
  for (const account of useOfflineStore.getState().enabled) scheduleSync(account, 3_000);
}

// ---- Switching it on and off, wiping ----

export async function enableOffline(account: string): Promise<void> {
  if (!offlineAllowed(account)) return;
  const enabled = useOfflineStore.getState().enabled;
  if (!enabled.includes(account)) writeEnabled([...enabled, account]);
  // Ask the browser not to clear it when space runs low (it may say no).
  try {
    void navigator.storage?.persist?.().catch(() => false);
  } catch {
    /* no Storage API */
  }
  await getStore().ensureOpen(account).catch(() => {});
  await tellServiceWorker(true);
  scheduleSync(account, 0);
}

/** Switches offline mode off for an account (the user confirmed losing unsent mail) and removes everything it kept here. */
export async function disableOffline(account: string): Promise<void> {
  confirmLoss(account);
  clearHandoffs();
  writeEnabled(useOfflineStore.getState().enabled.filter((id) => id !== account));
  await wipeAccount(account);
}

// ---- Unsent mail a wipe deletes ----

// The user agreed to lose unsent mail (the sign-out question, switching
// offline mode off): no word about it afterwards.
const confirmed = new Set<string>();
// Already named for this sign-out.
const named = new Set<string>();

export function confirmLoss(scope: string): void {
  confirmed.add(scope);
}

async function unsentSubjects(scope: string): Promise<string[]> {
  let rows = useOfflineStore.getState().outbox;
  // Reading an account's store would create it if it never had one.
  if (scope !== 'all' && !useOfflineStore.getState().enabled.includes(scope)) return rows.filter((row) => row.account === scope).map((row) => row.subject);
  try {
    rows = (await readQueue(scope === 'all' ? undefined : scope)).outbox.map((entry) => ({
      id: entry.id, account: entry.account, createdAt: entry.createdAt, subject: entry.summary.subject, to: entry.summary.to, status: entry.status,
    }));
  } catch {
    // No store: what the state last saw.
  }
  return rows.filter((row) => scope === 'all' || row.account === scope).map((row) => row.subject);
}

/** How long a sign-out waits for the store's word on what would be lost. */
const UNSENT_READ_MS = 2_000;

/** What a sign-out of `scope` would delete: messages, and edits the server hasn't got. */
export async function unsentCount(scope: string, waitMs = UNSENT_READ_MS): Promise<{ messages: number; changes: number }> {
  const shown = useOfflineStore.getState();
  const known = { messages: shown.outbox.filter((row) => scope === 'all' || row.account === scope).length, changes: shown.pendingChanges };
  const accounts = (scope === 'all' ? visibleAccounts() : [scope]).filter((account) => shown.enabled.includes(account));
  if (accounts.length === 0) return known;
  const pendingIn = (account: string, area: string) => getStore().area<number>(account, `${area}.pending`).catch(() => 0);
  const read = (async () => {
    const { failed, outbox, patches } = await readQueue(scope === 'all' ? undefined : scope);
    const edits = await Promise.all(accounts.flatMap((account) => [pendingIn(account, 'calendar'), pendingIn(account, 'contacts')]));
    return {
      // An account that can't answer counts with what it last said.
      messages: outbox.length + shown.outbox.filter((row) => failed.includes(row.account)).length,
      changes: patches + edits.reduce((sum, count) => sum + count, 0),
    };
  })().catch(() => known);
  return Promise.race([read, new Promise<typeof known>((resolve) => setTimeout(() => resolve(known), waitMs))]);
}

/** Names the unsent messages a wipe of `scope` deletes, unless the user agreed. */
async function nameLost(scope: string, stillSignedIn: boolean): Promise<void> {
  if (named.has(scope) || named.has('all')) return;
  if (confirmed.has(scope) || confirmed.has('all')) {
    // Agreed once, for this sign-out: the wipes that follow it stay quiet too.
    named.add(confirmed.has('all') ? 'all' : scope);
    confirmed.delete(scope);
    confirmed.delete('all');
    return;
  }
  const subjects = await unsentSubjects(scope);
  if (subjects.length === 0) return;
  named.add(scope);
  rememberLost(subjects);
  if (stillSignedIn) notify({ kind: 'lost', subjects });
}

export async function wipeAccount(account: string): Promise<void> {
  const timer = syncTimers.get(account);
  if (timer) clearTimeout(timer);
  syncTimers.delete(account);
  // Waited for a sign-in that never came: whoever is here now mustn't read its subjects.
  if (isEvicted(account)) named.add(account);
  if (useOfflineStore.getState().enabled.includes(account) || useOfflineStore.getState().outbox.some((row) => row.account === account)) {
    await nameLost(account, useAuthStore.getState().isAuthenticated);
  }
  named.delete(account);
  clearEvicted(account);
  if (useOfflineStore.getState().enabled.includes(account)) {
    writeEnabled(useOfflineStore.getState().enabled.filter((id) => id !== account));
  }
  // Nobody keeps mail here any more: everything goes (and isn't opened
  // again, which would create it anew).
  if (useOfflineStore.getState().enabled.length === 0) {
    await wipeEverything();
    return;
  }
  try {
    await getStore().remove(account);
  } catch {
    // No store: nothing to remove. The key is gone in any case.
  }
  await refreshQueueState();
  await refreshUsage();
}

/** Nothing of offline mode stays on this device. */
export async function wipeEverything(): Promise<void> {
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  writeEnabled([]);
  getStore().stop();
  await purgeStoreFiles();
  try {
    indexedDB.deleteDatabase(LEGACY_DB_NAME);
  } catch {
    /* no IndexedDB */
  }
  await tellServiceWorker(false);
  await deleteShellCaches();
  clearHandoffs();
  confirmed.clear();
  named.clear();
  useOfflineStore.setState({ outbox: [], pendingChanges: 0, conflicts: [], usageBytes: 0, syncing: [], lastSyncedAt: {} });
}

/** Whether the policy of an account is known well enough to decide on it. */
function policyDecided(account: string): boolean {
  // Dropped, with no groups to wait for: what applies to everyone reaches it.
  if (isEvicted(account)) return true;
  const auth = useAuthStore.getState();
  if (account === auth.activeAccountId || !auth.activeAccountId) return !usePolicyStore.getState().subjectPending;
  // Another signed-in account: its groups have to be known first (a group
  // scope may forbid it); a signed-out one is wiped with its sign-out.
  if (!auth.getClientForAccount?.(account)) return false;
  return !accountSubjectPending(account);
}

/** The organisation forbids it for an account that has it on: wipe that account. */
export function enforcePolicy(): void {
  const { loaded } = usePolicyStore.getState();
  if (!loaded) return;
  for (const account of useOfflineStore.getState().enabled) {
    if (!policyDecided(account)) continue;
    if (!offlineAllowed(account)) {
      // Whoever is here now wasn't signed in to a dropped account.
      const someoneElses = isEvicted(account);
      clearHandoffs();
      void wipeAccount(account);
      if (!someoneElses) notify({ kind: 'forbidden' });
    }
  }
}

// ---- Started without the server ----

const RECONNECT_MS = 30_000;
let reconnecting = false;

/**
 * After a start without the server: once the server answers, sign in for
 * real and replace the device-only clients (no reload). With a message
 * being written that would close the composer, so the user is asked to
 * reload instead.
 */
async function leaveOfflineStart(): Promise<void> {
  if (reconnecting || !useOfflineStore.getState().startedOffline) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  reconnecting = true;
  try {
    const accounts = useAccountStore.getState().accounts;
    const servers = [...new Set(accounts.map((a) => a.serverUrl))];
    const reachable = (await Promise.all(servers.map((url) => probeServer(url).then((gone) => !gone)))).some(Boolean);
    if (!reachable) return;
    const { useUIStore } = await import('@/stores/ui-store');
    if ((useUIStore.getState().composingCount ?? 0) > 0) {
      notify({ kind: 'back-online-reload' });
      return;
    }
    const swapped = await useAuthStore.getState().reconnectOfflineClients();
    if (swapped) {
      useOfflineStore.setState({ startedOffline: false });
      scheduleFlushAll(1_000);
    }
  } finally {
    reconnecting = false;
  }
}

// ---- Starting ----

let started = false;
const cleanups: Array<() => void> = [];

/**
 * The JMAP client's hooks. Separate from startOfflineMode because the auth
 * store needs them before it restores accounts: a start from the local copy
 * asks the store long before the host component mounts.
 */
export function registerOfflineHooks(): void {
  if (!offlineSupported()) return;
  configureStore(storeHooks);
  setOfflineHooks(hooks);
  setOutboxHooks(outbox);
  void moveLegacyOutbox();
}

/** Runs offline mode in this tab. Safe to call more than once. */
export function startOfflineMode(): () => void {
  if (!started && !offlineSupported()) void noteStrandedMail();
  if (started || !offlineSupported()) return () => {};
  started = true;
  registerOfflineHooks();

  const onOnline = () => {
    useOfflineStore.setState({ browserOffline: false });
    void getStore().setOnline(true).catch(() => {});
    scheduleFlushAll(500);
  };
  const onOffline = () => {
    useOfflineStore.setState({ browserOffline: true });
    void getStore().setOnline(false).catch(() => {});
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  cleanups.push(() => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  });

  // Back in front: catch up now rather than at the next interval.
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    for (const account of useOfflineStore.getState().enabled) scheduleSync(account, 0);
  };
  document.addEventListener('visibilitychange', onVisible);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));

  // Another tab switched it off for an account (or everyone signed out
  // there): stop here too, and don't write anything for that account. One
  // switched on there has to be opened here if this tab owns the store.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== OFFLINE_ACCOUNTS_KEY && event.key !== null) return;
    const next = readEnabledFrom(event.key === null ? null : event.newValue);
    const before = useOfflineStore.getState().enabled;
    const removed = before.filter((id) => !next.includes(id));
    for (const id of removed) {
      const timer = syncTimers.get(id);
      if (timer) clearTimeout(timer);
      syncTimers.delete(id);
    }
    useOfflineStore.setState({ enabled: next });
    for (const id of next) if (!before.includes(id)) void getStore().ensureOpen(id).catch(() => {});
    void refreshQueueState();
  };
  window.addEventListener('storage', onStorage);
  cleanups.push(() => window.removeEventListener('storage', onStorage));

  // The organisation's word, on every policy fetch (and the cached copy at
  // an offline start), and once another account's groups are known.
  cleanups.push(usePolicyStore.subscribe((state, prev) => {
    if (state.rawPolicy !== prev.rawPolicy || state.loaded !== prev.loaded || state.subject !== prev.subject || state.subjectPending !== prev.subjectPending) enforcePolicy();
  }));
  cleanups.push(useAccountSubjects.subscribe(() => enforcePolicy()));
  enforcePolicy();

  // An account signed out or removed takes its data with it. One the app
  // dropped by itself doesn't: its session ran out, or the server can't
  // confirm it right now, and that says nothing against the mail on this device.
  cleanups.push(onAccountRemoved((id, reason) => {
    if (reason === 'explicit') void wipeAccount(id);
  }));
  void sweepAccountsGone();
  void checkStorageAccess();

  // Session, then a sync, for every account signed in with offline mode on.
  // A client that just became real is what the waiting mail was waiting for:
  // the flush at the start may have run before it was connected.
  const flushedFor = new WeakSet<object>();
  const syncSignedIn = () => {
    let connected = false;
    for (const account of useOfflineStore.getState().enabled) {
      const client = onlineClientFor(account);
      if (!client || !offlineActive(account)) continue;
      void getStore().ensureOpen(account).then(() => getStore().refresh(account)).catch(() => {});
      scheduleSync(account, 3_000);
      if (!flushedFor.has(client)) {
        flushedFor.add(client);
        if (!isOfflineNow(client.getServerUrl())) connected = true;
      }
    }
    if (connected) scheduleFlushAll(1_000);
  };
  cleanups.push(useAuthStore.subscribe((state, prev) => {
    if (state.client !== prev.client || state.connectedAccountsRevision !== prev.connectedAccountsRevision) syncSignedIn();
  }));
  syncSignedIn();

  const interval = setInterval(() => {
    for (const account of useOfflineStore.getState().enabled) scheduleSync(account, 0);
  }, SYNC_INTERVAL_MS);
  const reconnect = setInterval(() => {
    void leaveOfflineStart();
    // Nothing else tells a server that was down is back: a client that thinks
    // it's down has no reason to ask it. A passing probe starts the flush.
    for (const server of useOfflineStore.getState().downServers) void probeServer(server);
  }, RECONNECT_MS);
  cleanups.push(() => {
    clearInterval(interval);
    clearInterval(reconnect);
    if (staleCheck) clearTimeout(staleCheck);
    staleCheck = null;
  });

  if (useOfflineStore.getState().enabled.length > 0) void tellServiceWorker(true);
  void (async () => {
    await moveLegacyOutbox();
    await refreshQueueState();
    if (!isOfflineNow()) scheduleFlushAll(2_000);
  })();
  void refreshUsage();

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    setOfflineHooks(null);
    setOutboxHooks(null);
    configureStore(null);
    started = false;
  };
}

/**
 * Data no signed-in account vouches for. A dropped account's waits 30 days. One
 * that left the registry on purpose before this ran (a login without "remember
 * me" ends at a reload, before the host mounts) goes now, naming lost mail.
 */
async function sweepAccountsGone(now = Date.now()): Promise<void> {
  const evicted = readEvicted();
  const accounts = useAccountStore.getState().accounts;
  for (const account of useOfflineStore.getState().enabled) {
    const at = evicted[account];
    const gone = at !== undefined ? now - at > EVICTED_KEEP_MS : !accounts.some((entry) => entry.id === account);
    if (gone) await wipeAccount(account).catch(() => {});
  }
}

let staleCheck: ReturnType<typeof setTimeout> | null = null;

/** A send taken by a tab that closed on the way: nothing else comes back to it. */
function checkStaleSendsLater(): void {
  if (staleCheck) return;
  staleCheck = setTimeout(() => {
    staleCheck = null;
    void refreshQueueState().then(() => scheduleFlushAll(0));
  }, SENDING_STALE_MS + 1_000);
}

/** Firefox's private windows refuse this at once, where the worker would try for half a minute. */
async function checkStorageAccess(): Promise<void> {
  try {
    await navigator.storage.getDirectory();
  } catch (error) {
    if ((error as Error)?.name === 'SecurityError') useOfflineStore.setState({ storageBlocked: true });
  }
}

let strandedNoted = false;

/** An earlier version's unsent mail, in a browser that can't run what would move it. */
async function noteStrandedMail(): Promise<void> {
  if (strandedNoted || IS_LITE || !hasIndexedDb()) return;
  if ((await strandedLegacyMessages().catch(() => 0)) === 0) return;
  strandedNoted = true;
  notify({ kind: 'legacy-stranded' });
}

/** How often the store catches up while the tab is open, on top of pushes. */
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;

// A full sign-out deletes the store (lib/sign-out-cleanup.ts); forget what
// is held in memory as well.
onFullSignOut(({ keepLocalStore }) => {
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  if (!keepLocalStore) getStore().stop();
  confirmed.clear();
  named.clear();
  useOfflineStore.setState((s) => ({ enabled: keepLocalStore ? s.enabled : [], outbox: [], pendingChanges: 0, conflicts: [], usageBytes: 0, syncing: [], lastSyncedAt: {}, startedOffline: false }));
});

// Every sign-out the user didn't agree to lose mail at (the session limits,
// a refused token renewal, a removed account) names the unsent messages.
onBeforeSignOut(async (accountId, { keepLocalStore }) => {
  // Nothing is lost: it waits for the next sign-in.
  if (keepLocalStore) return;
  const stillSignedIn = accountId !== 'all' && useAccountStore.getState().accounts.some((a) => a.id !== accountId);
  await nameLost(accountId, stillSignedIn);
});

/** Whether the mail server can't be reached: the browser is offline or a probe fails. */
export async function serverUnreachable(serverUrl: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return probeServer(serverUrl);
}

/** How long a start waits for the store before it signs in the usual way. */
const SESSION_READ_TIMEOUT_MS = 5_000;

/** The session kept for an account, for starting from the local copy. */
/** A start doesn't hang on a black-holed fetch or a stuck database. */
const BOOT_WAIT_MS = 3_000;

function withinBootWait(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, BOOT_WAIT_MS))]);
}

export async function offlineSessionFor(account: string, options: { withFolders?: boolean } = {}): Promise<unknown | null> {
  // The organisation's last word: the policy kept from the last fetch (the
  // fetch itself fails without a network), never the defaults.
  const policy = usePolicyStore.getState();
  await withinBootWait(!policy.loaded && !policy.fetching ? policy.fetchPolicy() : whenPolicySettled(BOOT_WAIT_MS));
  // Still nothing to go on: the usual start, which has its own errors.
  if (!usePolicyStore.getState().loaded || !offlineActive(account)) return null;
  registerOfflineHooks();
  try {
    // What's in the old database goes on moving behind the start.
    await withinBootWait(moveLegacyOutbox());
    return await Promise.race([
      (async () => {
        if (options.withFolders && !(await getStore().area<boolean>(account, 'mail.hasFolders'))) return null;
        return getStore().area<unknown>(account, 'mail.session');
      })(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SESSION_READ_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

export function markStartedOffline(): void {
  useOfflineStore.setState({ startedOffline: true });
}
