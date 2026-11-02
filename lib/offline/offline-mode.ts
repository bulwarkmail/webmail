/**
 * Offline mode (#523): "Keep mail on this device".
 *
 * - Opt-in per account and per browser (state.ts), off by default, hidden
 *   and wiped when the organisation forbids it (policy.json
 *   `organisation.devices.noOffline`, per account) and in Lite.
 * - While on, the JMAP client hands every answer of the mail server to the
 *   cache (cache.ts) and asks this device when the network is gone
 *   (responder.ts); a background sync keeps the last 30 days of the Inbox
 *   and of the folders the user opened, with bodies and attachments, under
 *   a cap (sync.ts).
 * - Changes and sends made offline wait in the queue (queue.ts) and go out
 *   in order once the server answers again and the organisation's policy
 *   was fetched afresh (flush.ts).
 * - Everything is wiped at a full sign-out and the automatic sign-outs
 *   (lib/sign-out-cleanup.ts deletes the database), for one account when it
 *   signs out or switches offline mode off, and when the organisation
 *   forbids it (checked on every policy fetch). Unsent messages a sign-out
 *   deletes without the user's word are named (lost.ts).
 */

import { IS_LITE } from '@/lib/lite';
import { devicesForAccount } from '@/lib/device-policy';
import { accountSubjectPending, useAccountSubjects } from '@/lib/org/account-subjects';
import { labelsPolicyFor } from '@/lib/outgoing/classification';
import { getSendGuardSource, guardState, guardsSending } from '@/lib/plugin-send-guards';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { usePolicyStore, whenPolicySettled } from '@/stores/policy-store';
import { onBeforeSignOut, onFullSignOut } from '@/lib/sign-out-cleanup';
import { setOfflineHooks, type OfflineClientRef, type OfflineHooks, type OfflineMethodCall, type OfflineResponse } from '@/lib/jmap/offline-hooks';
import type { SendEmailResult } from '@/lib/jmap/types';
import { setOutboxHooks, type OutboxHooks } from './outbox-hooks';
import { answerOffline } from './responder';
import {
  CACHE_WINDOW_MS,
  cacheUsage,
  emailIndex,
  enforceCap,
  forgetIndexes,
  getBlob,
  getMisc,
  messageOfBlob,
  patchEmails,
  putBlob,
  putEmails,
  putMisc,
  removeEmails,
  wipeAccountCache,
  emailKey,
  type CachedEmail,
} from './cache';
import { allowOfflineDbCreation, deleteOfflineDb, hasIndexedDb } from './db';
import { forgetDeviceKey } from './crypto';
import {
  heldFile,
  holdFile,
  isLocalBlobId,
  queuePatch,
  queueSend,
  readQueue,
  wipeAccountQueue,
  type OutboxEntry,
  type OutboxError,
  type OutboxSummary,
  type PolicyFingerprint,
} from './queue';
import { isOfflineNow, OFFLINE_ACCOUNTS_KEY, readEnabledFrom, serverKey, setServerDown, useOfflineStore, writeEnabled, type OutboxRow } from './state';
import { flushQueue, settleStaleSends } from './flush';
import { syncAccount } from './sync';
import { deleteShellCaches, tellServiceWorker } from './shell';
import { rememberLost } from './lost';

export type OfflineNotice =
  | { kind: 'queued'; subject: string }
  | { kind: 'sent'; subject: string }
  | { kind: 'send-failed'; subject: string; error: OutboxError }
  | { kind: 'held'; subject: string }
  | { kind: 'lost'; subjects: string[] }
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

/** Offline mode is possible here at all: not in Lite, with IndexedDB and WebCrypto. */
export function offlineSupported(): boolean {
  if (IS_LITE || !hasIndexedDb()) return false;
  try {
    return typeof crypto !== 'undefined' && !!crypto.subtle;
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

function serverOf(account: string): string | undefined {
  return useAccountStore.getState().accounts.find((a) => a.id === account)?.serverUrl;
}

// ---- What the server sends, into the cache ----

export interface Scope {
  inbox: Record<string, string>;
  opened: Record<string, string[]>;
}

const MAX_OPENED_FOLDERS = 10;

/** The Inbox and the opened folders that still exist, per JMAP account. */
export async function scopeOf(account: string): Promise<Scope> {
  const mailboxes = (await getMisc<Record<string, Array<{ id: string; role?: string | null }>>>(account, 'mailboxes')) ?? {};
  const inbox: Record<string, string> = {};
  for (const [jmap, list] of Object.entries(mailboxes)) {
    const box = list.find((m) => m.role === 'inbox');
    if (box) inbox[jmap] = box.id;
  }
  const stored = (await getMisc<Record<string, string[]>>(account, 'opened')) ?? {};
  // A folder deleted or moved away is no longer opened.
  const opened: Record<string, string[]> = {};
  let pruned = false;
  for (const [jmap, ids] of Object.entries(stored)) {
    const list = mailboxes[jmap];
    const kept = list ? ids.filter((id) => list.some((m) => m.id === id)) : ids;
    if (kept.length !== ids.length) pruned = true;
    opened[jmap] = kept;
  }
  if (pruned) await putMisc(account, 'opened', opened);
  return { inbox, opened };
}

export async function scopeMailboxes(account: string): Promise<Array<{ jmap: string; mailboxId: string; isInbox: boolean }>> {
  const scope = await scopeOf(account);
  const out: Array<{ jmap: string; mailboxId: string; isInbox: boolean }> = [];
  for (const [jmap, id] of Object.entries(scope.inbox)) out.push({ jmap, mailboxId: id, isInbox: true });
  for (const [jmap, ids] of Object.entries(scope.opened)) {
    for (const id of ids) if (scope.inbox[jmap] !== id) out.push({ jmap, mailboxId: id, isInbox: false });
  }
  return out;
}

function keptFolders(scope: Scope): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [jmap, id] of Object.entries(scope.inbox)) out[jmap] = [id];
  for (const [jmap, ids] of Object.entries(scope.opened)) out[jmap] = [...(out[jmap] ?? []), ...ids];
  return out;
}

/** A message the cache keeps: received in the last 30 days, in the Inbox or an opened folder. */
export function inScope(scope: Scope, jmap: string, email: CachedEmail, now = Date.now()): boolean {
  const at = Date.parse(String(email.receivedAt ?? ''));
  if (Number.isFinite(at) && at < now - CACHE_WINDOW_MS) return false;
  const boxes = Object.keys(email.mailboxIds ?? {});
  const wanted = new Set([...(scope.opened[jmap] ?? []), ...(scope.inbox[jmap] ? [scope.inbox[jmap]] : [])]);
  return boxes.some((id) => wanted.has(id));
}

/** The folder a list query opened, if it is one. */
function openedFolder(args: Record<string, unknown>): string | null {
  if (typeof args.limit !== 'number') return null;
  const filter = args.filter as Record<string, unknown> | undefined;
  if (!filter) return null;
  if (typeof filter.inMailbox === 'string' && Object.keys(filter).every((k) => k === 'inMailbox' || k === 'hasKeyword')) return filter.inMailbox;
  if (filter.operator === 'AND' && Array.isArray(filter.conditions)) {
    for (const c of filter.conditions as Array<Record<string, unknown>>) if (typeof c.inMailbox === 'string' && Object.keys(c).length === 1) return c.inMailbox;
  }
  return null;
}

async function noteOpenedFolder(account: string, jmap: string, mailboxId: string): Promise<void> {
  const opened = (await getMisc<Record<string, string[]>>(account, 'opened')) ?? {};
  const list = opened[jmap] ?? [];
  if (list[0] === mailboxId) return;
  opened[jmap] = [mailboxId, ...list.filter((id) => id !== mailboxId)].slice(0, MAX_OPENED_FOLDERS);
  await putMisc(account, 'opened', opened);
  scheduleSync(account, 5_000);
}

async function putList(account: string, name: 'mailboxes' | 'identities', jmap: string, list: unknown[]): Promise<void> {
  const all = (await getMisc<Record<string, unknown[]>>(account, name)) ?? {};
  all[jmap] = list;
  await putMisc(account, name, all);
}

/** The methods whose answers the cache takes. */
const RECORDED = new Set(['Mailbox/get', 'Identity/get', 'Email/get', 'Email/query', 'Email/set']);

/** What the server answered, into the cache. */
export async function recordAnswer(account: string, defaultJmap: string, calls: OfflineMethodCall[], response: OfflineResponse): Promise<void> {
  const scope = await scopeOf(account);
  for (const [name, result, callId] of response.methodResponses) {
    if (!result || typeof result !== 'object') continue;
    const call = calls.find(([n, , id]) => id === callId && n === name);
    const args = call?.[1] ?? {};
    const jmap = (result.accountId as string) || (args.accountId as string) || defaultJmap;
    const properties = args.properties as string[] | undefined;
    switch (name) {
      case 'Mailbox/get':
        if (!args.ids && (!properties || properties.includes('name')) && Array.isArray(result.list)) {
          await putList(account, 'mailboxes', jmap, result.list);
        }
        break;
      case 'Identity/get':
        if (!args.ids && Array.isArray(result.list)) await putList(account, 'identities', jmap, result.list);
        break;
      case 'Email/get': {
        const list = (Array.isArray(result.list) ? result.list : []) as CachedEmail[];
        // Fresh state for every message already kept; new ones only within the scope.
        const index = await emailIndex(account);
        const keep = list.filter((email) => index.has(emailKey(account, jmap, email.id)) || inScope(scope, jmap, email));
        await putEmails(account, jmap, keep);
        if (keep.length) scheduleCapCheck();
        break;
      }
      case 'Email/query': {
        const folder = openedFolder(args);
        if (folder) await noteOpenedFolder(account, jmap, folder);
        break;
      }
      case 'Email/set': {
        const update = (args.update ?? {}) as Record<string, Record<string, unknown>>;
        const updated = Object.keys((result.updated ?? {}) as object);
        if (updated.length) await patchEmails(account, jmap, Object.fromEntries(updated.filter((id) => update[id]).map((id) => [id, update[id]])));
        const destroyed = (Array.isArray(result.destroyed) ? result.destroyed : []) as string[];
        if (destroyed.length) await removeEmails(account, destroyed.map((id) => emailKey(account, jmap, id)));
        break;
      }
      default:
        break;
    }
  }
}

// One write after the other per account, so a list and its refresh land in order.
const recording = new Map<string, Promise<void>>();

function enqueueRecord(account: string, task: () => Promise<void>): void {
  const previous = recording.get(account) ?? Promise.resolve();
  const next = previous.then(task).catch(() => {});
  recording.set(account, next);
}

let capTimer: ReturnType<typeof setTimeout> | null = null;

/** The cap holds between syncs too: checked shortly after writes. */
function scheduleCapCheck(delayMs = 5_000): void {
  if (capTimer) return;
  capTimer = setTimeout(() => {
    capTimer = null;
    if (useOfflineStore.getState().enabled.length === 0) return;
    void enforceCap().then(() => refreshUsage()).catch(() => {});
  }, delayMs);
}

/** Mutating calls the device can't take: a send, an import, calendar and contact changes. */
const NEEDS_SERVER = /^(EmailSubmission|Email\/import|CalendarEvent\/set|ContactCard\/set|AddressBook\/set|Calendar\/set|Mailbox\/set|FileNode\/set|SieveScript\/set|VacationResponse\/set|Identity\/set)/;
let lastRefusalNotice = 0;

function noticeRefused(methodCalls: OfflineMethodCall[]): void {
  if (!methodCalls.some(([name]) => NEEDS_SERVER.test(name))) return;
  const now = Date.now();
  if (now - lastRefusalNotice < 5_000) return;
  lastRefusalNotice = now;
  notify({ kind: 'refused-other' });
}

// ---- Hooks for the JMAP client ----

const probes = new Map<string, Promise<boolean>>();

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
      await fetch(`${serverUrl.replace(/\/+$/, '')}/.well-known/jmap`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
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
    const scope = await scopeOf(account).catch(() => null);
    const answered = await answerOffline({
      account,
      defaultJmap: client.getAccountId(),
      keptFolders: scope ? keptFolders(scope) : undefined,
      queuePatch: async (jmap, update) => {
        await queuePatch(account, jmap, update);
        void refreshQueueState();
      },
      onRefused: (what) => notify({ kind: what === 'destroy' ? 'refused-delete' : 'refused-other' }),
    }, methodCalls);
    if (!answered) noticeRefused(methodCalls);
    return answered;
  },
  record(client, methodCalls, response) {
    const account = accountForClient(client);
    if (!offlineActive(account) || !account) return;
    // Only the answers the cache takes; copied now, because callers change
    // the answer's objects after this returns.
    const wanted = response.methodResponses.filter(([name]) => RECORDED.has(name));
    if (wanted.length === 0) return;
    const ids = new Set(wanted.map(([, , id]) => id));
    const copy = JSON.parse(JSON.stringify({ methodResponses: wanted })) as OfflineResponse;
    const calls = JSON.parse(JSON.stringify(methodCalls.filter(([, , id]) => ids.has(id)))) as OfflineMethodCall[];
    const jmap = client.getAccountId();
    enqueueRecord(account, () => recordAnswer(account, jmap, calls, copy));
  },
  noteNetwork(client, reachable) {
    if (reachable) {
      if (setServerDown(client.getServerUrl(), false)) scheduleFlushAll(500);
    } else {
      void probeServer(client.getServerUrl());
    }
  },
  async serverGone(client) {
    if (!offlineActive(accountForClient(client))) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return probeServer(client.getServerUrl());
  },
  async blob(client, blobId, jmap) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account)) return null;
    if (isLocalBlobId(blobId)) return heldFile(account, blobId);
    return getBlob(account, jmap, blobId);
  },
  recordBlob(client, blobId, jmap, blob) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account) || blob.size > MAX_RECORDED_BLOB_BYTES) return;
    // Only a part of a kept message (an attachment, an inline image), filed
    // with it: never a whole message an export reads, never a stray file.
    enqueueRecord(account, async () => {
      const owner = await messageOfBlob(account, jmap, blobId);
      if (!owner) return;
      await putBlob(account, jmap, blobId, blob, owner.at, owner.key);
      scheduleCapCheck();
    });
  },
  async holdUpload(client, file) {
    const account = accountForClient(client);
    if (!account || !offlineActive(account)) return null;
    return holdFile(account, file, file.name);
  },
};

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
    const id = await queueSend(account, summary, { kind: 'email', args: stored }, policyFingerprint(account, labelled));
    await refreshQueueState();
    notify({ kind: 'queued', subject: summary.subject });
    return queuedResult(id);
  },
  async queueRaw(client, raw, options) {
    const account = accountForClient(client);
    if (!account) throw new Error('No account for this send');
    if (pluginsNotRunning()) throw new OfflinePluginsDownError();
    const held = await holdFile(account, raw, 'message.eml');
    const { summary, labelled } = await rawSummary(raw);
    const id = await queueSend(account, summary, { kind: 'raw', blobId: held.blobId, ...options }, policyFingerprint(account, labelled));
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

/** Subject, recipients and label of a raw message, for the outbox list. */
async function rawSummary(raw: Blob): Promise<{ summary: OutboxSummary; labelled: boolean }> {
  const head = await raw.slice(0, 64 * 1024).text();
  const end = head.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, ' ');
  const header = (name: string) => block.split(/\r?\n/).find((line) => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? '';
  const to = ['to', 'cc'].flatMap((name) => header(name).split(',')).map((s) => s.trim()).filter(Boolean);
  return { summary: { subject: decodeMimeWords(header('subject')), to }, labelled: header('sio-label') !== '' };
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
  // database would create it (on the sign-in page, after a sign-out).
  if (useOfflineStore.getState().enabled.length === 0) {
    useOfflineStore.setState({ outbox: [], pendingChanges: 0 });
    return;
  }
  try {
    // Sends of a tab closed on the way: uncertain, so they can be retried or deleted.
    await settleStaleSends();
    const { patches, outbox: entries } = await readQueue();
    const rows: OutboxRow[] = entries.map((entry) => ({
      id: entry.id,
      account: entry.account,
      createdAt: entry.createdAt,
      subject: entry.summary.subject,
      to: entry.summary.to,
      status: entry.status,
      error: entry.error,
    }));
    useOfflineStore.setState({ outbox: rows, pendingChanges: patches.length });
  } catch {
    // The database is being deleted.
  }
}

export async function refreshUsage(): Promise<void> {
  if (!offlineSupported() || useOfflineStore.getState().enabled.length === 0) return;
  try {
    useOfflineStore.setState({ usageBytes: (await cacheUsage()).total });
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
    await syncAccount(account, client, {
      stillActive: () => offlineActive(account),
      recorded: async () => { await recording.get(account); },
      scopeMailboxes,
    });
    useOfflineStore.setState((s) => ({ lastSyncedAt: { ...s.lastSyncedAt, [account]: Date.now() } }));
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

export async function flushAll(): Promise<void> {
  if (useOfflineStore.getState().startedOffline) {
    void leaveOfflineStart();
    return;
  }
  const { outbox: rows, pendingChanges } = useOfflineStore.getState();
  if (rows.length === 0 && pendingChanges === 0) return;
  // The organisation's current word before anything goes: a label now
  // required, a send check now required or offline mode now forbidden must
  // stop what waited under the old rules.
  await usePolicyStore.getState().fetchPolicy();
  if (usePolicyStore.getState().source !== 'server') {
    scheduleFlushAll(POLICY_RETRY_MS);
    return;
  }
  enforcePolicy();
  const accounts = new Set(rows.map((r) => r.account));
  if (pendingChanges > 0) for (const id of useOfflineStore.getState().enabled) accounts.add(id);
  for (const account of accounts) {
    const client = onlineClientFor(account);
    if (!client || !offlineActive(account)) continue;
    await flushQueue(account, client, {
      notify,
      allowed: () => offlineAllowed(account),
      stricterNow,
      onScheduled: offerUndo,
    });
  }
  await refreshQueueState();
  for (const account of useOfflineStore.getState().enabled) scheduleSync(account, 3_000);
}

// ---- Switching it on and off, wiping ----

export async function enableOffline(account: string): Promise<void> {
  if (!offlineAllowed(account)) return;
  allowOfflineDbCreation();
  const enabled = useOfflineStore.getState().enabled;
  if (!enabled.includes(account)) writeEnabled([...enabled, account]);
  // Ask the browser not to clear it when space runs low (it may say no).
  try {
    void navigator.storage?.persist?.().catch(() => false);
  } catch {
    /* no Storage API */
  }
  const client = onlineClientFor(account);
  if (client) await putMisc(account, 'session', client.getSessionSnapshot());
  await tellServiceWorker(true);
  scheduleSync(account, 0);
}

/** Switches offline mode off for an account (the user confirmed losing unsent mail) and removes everything it kept here. */
export async function disableOffline(account: string): Promise<void> {
  confirmLoss(account);
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
  try {
    rows = (await readQueue(scope === 'all' ? undefined : scope)).outbox.map((entry) => ({
      id: entry.id, account: entry.account, createdAt: entry.createdAt, subject: entry.summary.subject, to: entry.summary.to, status: entry.status,
    }));
  } catch {
    // No database: what the store last saw.
  }
  return rows.filter((row) => scope === 'all' || row.account === scope).map((row) => row.subject);
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
  await recording.get(account)?.catch(() => {});
  if (useOfflineStore.getState().enabled.includes(account) || useOfflineStore.getState().outbox.some((row) => row.account === account)) {
    await nameLost(account, useAuthStore.getState().isAuthenticated);
  }
  named.delete(account);
  if (useOfflineStore.getState().enabled.includes(account)) {
    writeEnabled(useOfflineStore.getState().enabled.filter((id) => id !== account));
  }
  // Nobody keeps mail here any more: the whole database goes (and isn't
  // opened again, which would create it anew).
  if (useOfflineStore.getState().enabled.length === 0) {
    await wipeEverything();
    return;
  }
  try {
    await wipeAccountCache(account);
    await wipeAccountQueue(account);
  } catch {
    // No database: nothing to remove.
  }
  await refreshQueueState();
  await refreshUsage();
}

/** Nothing of offline mode stays on this device. */
export async function wipeEverything(): Promise<void> {
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  writeEnabled([]);
  forgetIndexes();
  forgetDeviceKey();
  await deleteOfflineDb();
  await tellServiceWorker(false);
  await deleteShellCaches();
  confirmed.clear();
  named.clear();
  useOfflineStore.setState({ outbox: [], pendingChanges: 0, usageBytes: 0, syncing: [], lastSyncedAt: {} });
}

/** Whether the policy of an account is known well enough to decide on it. */
function policyDecided(account: string): boolean {
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
      void wipeAccount(account);
      notify({ kind: 'forbidden' });
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

/** Runs offline mode in this tab. Safe to call more than once. */
export function startOfflineMode(): () => void {
  if (started || !offlineSupported()) return () => {};
  started = true;
  setOfflineHooks(hooks);
  setOutboxHooks(outbox);

  const onOnline = () => {
    useOfflineStore.setState({ browserOffline: false });
    scheduleFlushAll(500);
  };
  const onOffline = () => useOfflineStore.setState({ browserOffline: true });
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  cleanups.push(() => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
  });

  // Another tab switched it off for an account (or everyone signed out
  // there): stop here too, and don't write anything for that account.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== OFFLINE_ACCOUNTS_KEY && event.key !== null) return;
    const next = readEnabledFrom(event.key === null ? null : event.newValue);
    const before = useOfflineStore.getState().enabled;
    const removed = before.filter((id) => !next.includes(id));
    for (const id of removed) {
      const timer = syncTimers.get(id);
      if (timer) clearTimeout(timer);
      syncTimers.delete(id);
      forgetIndexes(id);
    }
    if (next.length === 0) {
      forgetIndexes();
      forgetDeviceKey();
    }
    useOfflineStore.setState({ enabled: next });
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

  // An account that signs out (or is removed) takes its offline data with it.
  let known = new Set(useAccountStore.getState().accounts.map((a) => a.id));
  cleanups.push(useAccountStore.subscribe((state) => {
    const now = new Set(state.accounts.map((a) => a.id));
    for (const id of known) if (!now.has(id)) void wipeAccount(id);
    known = now;
  }));

  // Session, then a sync, for every account signed in with offline mode on.
  const syncSignedIn = () => {
    for (const account of useOfflineStore.getState().enabled) {
      const client = onlineClientFor(account);
      if (!client || !offlineActive(account)) continue;
      void putMisc(account, 'session', client.getSessionSnapshot()).catch(() => {});
      scheduleSync(account, 3_000);
    }
  };
  cleanups.push(useAuthStore.subscribe((state, prev) => {
    if (state.client !== prev.client || state.connectedAccountsRevision !== prev.connectedAccountsRevision) syncSignedIn();
  }));
  syncSignedIn();

  const interval = setInterval(() => {
    for (const account of useOfflineStore.getState().enabled) scheduleSync(account, 0);
  }, SYNC_INTERVAL_MS);
  const reconnect = setInterval(() => { void leaveOfflineStart(); }, RECONNECT_MS);
  cleanups.push(() => {
    clearInterval(interval);
    clearInterval(reconnect);
  });

  if (useOfflineStore.getState().enabled.length > 0) void tellServiceWorker(true);
  void (async () => {
    if (useOfflineStore.getState().enabled.length > 0) await settleStaleSends().catch(() => {});
    await refreshQueueState();
    if (!isOfflineNow()) scheduleFlushAll(2_000);
  })();
  void refreshUsage();

  return () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    setOfflineHooks(null);
    setOutboxHooks(null);
    started = false;
  };
}

/** How often the cache catches up while the tab is open. */
export const SYNC_INTERVAL_MS = 15 * 60 * 1000;

// A full sign-out deletes the database (lib/sign-out-cleanup.ts); forget
// what is held in memory as well.
onFullSignOut(() => {
  for (const timer of syncTimers.values()) clearTimeout(timer);
  syncTimers.clear();
  forgetIndexes();
  forgetDeviceKey();
  confirmed.clear();
  named.clear();
  useOfflineStore.setState({ enabled: [], outbox: [], pendingChanges: 0, usageBytes: 0, syncing: [], lastSyncedAt: {}, startedOffline: false });
});

// Every sign-out the user didn't agree to lose mail at (the session limits,
// a refused token renewal, a removed account) names the unsent messages.
onBeforeSignOut(async (accountId) => {
  const stillSignedIn = accountId !== 'all' && useAccountStore.getState().accounts.some((a) => a.id !== accountId);
  await nameLost(accountId, stillSignedIn);
});

/** Whether the mail server can't be reached: the browser is offline or a probe fails. */
export async function serverUnreachable(serverUrl: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return probeServer(serverUrl);
}

/** The session kept for an account, for starting without the server. */
export async function offlineSessionFor(account: string): Promise<unknown | null> {
  // The organisation's last word: the policy kept from the last fetch (the
  // fetch itself fails without a network), never the defaults.
  const policy = usePolicyStore.getState();
  if (!policy.loaded && !policy.fetching) await policy.fetchPolicy();
  else await whenPolicySettled(3000);
  if (!offlineActive(account)) return null;
  try {
    return await getMisc<unknown>(account, 'session');
  } catch {
    return null;
  }
}

export function markStartedOffline(): void {
  useOfflineStore.setState({ startedOffline: true });
}
