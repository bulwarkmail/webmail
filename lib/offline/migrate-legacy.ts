/**
 * One time, on the first start after the update: what can't be fetched again
 * moves from the old IndexedDB `bulwark-offline` into the local store. That's
 * the outbox, the changes that wait, the files they hold and the session kept
 * for a start without the server. The mail itself syncs again.
 *
 * The old database holds its own key, so it goes only after the store has
 * committed every account. A move that fails leaves it in place and the next
 * start tries again; the store takes each account's part only once.
 */

import { generateMessageId } from '@/lib/jmap/client';
import { getStore } from '@/lib/store/client/api';
import type { StoreSession } from '@/lib/store/engine/transport';
import type { LegacyImport } from '@/lib/store/outbox/calls';
import type { OutboxError, OutboxStatus, OutboxSummary, PolicyFingerprint, SendItem } from '@/lib/store/outbox/items';
import { useOfflineStore } from './state';

export const LEGACY_DB_NAME = 'bulwark-offline';

interface Sealed {
  iv: Uint8Array;
  data: ArrayBuffer;
}

interface QueueRecord extends Sealed {
  id: number;
  account: string;
  kind: 'patch' | 'send';
  createdAt: number;
  status?: string;
}

interface UploadRecord extends Sealed {
  key: string;
  account: string;
  meta: Sealed;
}

interface SendPayload {
  summary: OutboxSummary;
  item: SendItem;
  fingerprint?: PolicyFingerprint;
  error?: OutboxError;
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Opens the old database only if it exists: opening it must never create it. */
function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME);
    let creating = false;
    request.onupgradeneeded = () => {
      creating = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      if (creating) resolve(null);
      else reject(request.error);
    };
    request.onblocked = () => resolve(null);
  });
}

function deleteLegacy(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    // An old tab still has it open: it goes when that tab does.
    request.onblocked = () => resolve();
  });
}

function storeNamesHold(db: IDBDatabase, ...names: string[]): boolean {
  return names.every((name) => db.objectStoreNames.contains(name));
}

async function open(key: CryptoKey, sealed: Sealed): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv as BufferSource }, key, sealed.data);
}

async function openJson<T>(key: CryptoKey, sealed: Sealed): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await open(key, sealed))) as T;
}

/** The Message-ID of a finished raw message, from its head. */
function rawMessageId(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder().decode(bytes.subarray(0, 64 * 1024));
  const end = head.search(/\r?\n\r?\n/);
  const block = (end >= 0 ? head.slice(0, end) : head).replace(/\r?\n[ \t]+/g, ' ');
  return block.match(/^message-id:\s*<([^>\s]+)>/im)?.[1];
}

interface AccountPart extends LegacyImport {
  session: StoreSession | null;
}

async function readAccount(db: IDBDatabase, key: CryptoKey | null, account: string): Promise<AccountPart> {
  const part: AccountPart = { entries: [], patches: [], files: [], session: null };
  if (!key) return part;
  const stores = db.transaction(['queue', 'uploads', 'misc'], 'readonly');
  const [queue, uploads, session] = await Promise.all([
    result(stores.objectStore('queue').index('account').getAll(account)) as Promise<QueueRecord[]>,
    result(stores.objectStore('uploads').index('account').getAll(account)) as Promise<UploadRecord[]>,
    result(stores.objectStore('misc').get(`${account}\u0001misc\u0001session`)) as Promise<Sealed | undefined>,
  ]);
  if (session) part.session = await openJson<StoreSession>(key, session).catch(() => null);

  const rawIds = new Map<string, string | undefined>();
  for (const record of uploads) {
    // Sealed with a key that is gone, as the old code skipped it.
    try {
      const meta = await openJson<{ name?: string; type?: string }>(key, record.meta);
      const data = new Uint8Array(await open(key, record));
      const blobId = record.key.split('\u0001')[1];
      part.files.push({ blobId, name: meta.name || 'attachment', type: meta.type || 'application/octet-stream', data });
      rawIds.set(blobId, rawMessageId(data));
    } catch {
      continue;
    }
  }

  // In the order they were made.
  for (const record of [...queue].sort((a, b) => a.id - b.id)) {
    try {
      if (record.kind === 'patch') {
        const item = await openJson<{ jmap: string; update: Record<string, Record<string, unknown>> }>(key, record);
        part.patches.push({ jmap: item.jmap, update: item.update });
        continue;
      }
      const payload = await openJson<SendPayload>(key, record);
      // Sent by a tab that's gone: it may have left, so it's looked up or asked about.
      const status = (record.status === 'sending' ? 'uncertain' : record.status ?? 'waiting') as OutboxStatus;
      const item = payload.item;
      let messageId: string | undefined;
      if (item.kind === 'raw') messageId = rawIds.get(item.blobId);
      // Not sent yet: it can still get a fixed id. One that left under the old
      // code had another id, which nothing here knows.
      else if (status === 'waiting' && typeof item.args[6] === 'string') messageId = generateMessageId(item.args[6]);
      part.entries.push({
        summary: payload.summary,
        item,
        fingerprint: payload.fingerprint,
        error: payload.error,
        status,
        createdAt: record.createdAt,
        messageId,
      });
    } catch {
      continue;
    }
  }
  return part;
}

let moving: Promise<void> | null = null;

async function moveNow(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openLegacy();
  if (!db) return;
  try {
    if (!storeNamesHold(db, 'keys', 'queue', 'uploads', 'misc')) return;
    const keyRecord = await result(db.transaction('keys', 'readonly').objectStore('keys').get('aes')) as { key: CryptoKey } | undefined;
    const key = keyRecord?.key ?? null;
    for (const account of useOfflineStore.getState().enabled) {
      const part = await readAccount(db, key, account);
      const { session, ...content } = part;
      if (session) await getStore().ensureOpen(account, session);
      if (content.entries.length + content.patches.length + content.files.length === 0) continue;
      await getStore().area(account, 'outbox.importLegacy', content);
    }
  } finally {
    db.close();
  }
  await deleteLegacy();
}

/** Runs the move once per page. A failure is kept for nobody to see: the old database stays and the next start tries again. */
export function moveLegacyOutbox(): Promise<void> {
  moving ??= moveNow().catch(() => {});
  return moving;
}

/** Tests only: forget that this page already ran it. */
export function forgetLegacyMove(): void {
  moving = null;
}
