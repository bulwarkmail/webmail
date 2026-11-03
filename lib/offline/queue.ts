/**
 * What waits on this device for the network (#523): the page's view of the
 * outbox in the local store (lib/store/outbox). Changes made offline wait there
 * merged per record; messages wait as finished sends. Everything is kept
 * encrypted in the store, and taking an entry for sending is one SQLite
 * transaction, so two tabs can't both take it (claimForSending).
 */

import { requestOutboxSync } from '@/lib/pwa-notify/outbox-sync';
import { getStore } from '@/lib/store/client/api';
import type { ConflictSummary, OutboxError, OutboxStatus, OutboxSummary, PolicyFingerprint, SendItem, StoredConflict, StoredOutboxEntry } from '@/lib/store/outbox/items';
import { visibleAccounts } from './state';

export { LOCAL_BLOB_PREFIX, heldBlobIds, isLocalBlobId } from '@/lib/store/outbox/items';
export type { EmailSendItem, OutboxError, OutboxStatus, OutboxSummary, PolicyFingerprint, RawSendItem, SendItem } from '@/lib/store/outbox/items';

export interface OutboxEntry extends StoredOutboxEntry {
  account: string;
}

export interface ConflictEntry {
  id: number;
  account: string;
  recordId: string;
  createdAt: number;
  summary: ConflictSummary;
}

export async function queueSend(account: string, summary: OutboxSummary, item: SendItem, fingerprint?: PolicyFingerprint, messageId?: string): Promise<number> {
  const id = await getStore().area<number>(account, 'outbox.queueSend', { summary, item, fingerprint, messageId });
  requestOutboxSync();
  return id;
}

interface StoredQueue {
  patches: number;
  entries: StoredOutboxEntry[];
  conflicts: StoredConflict[];
}

/** Everything waiting for one account (or every account with it on), oldest first. */
export async function readQueue(account?: string): Promise<{ patches: number; outbox: OutboxEntry[]; conflicts: ConflictEntry[] }> {
  const accounts = account ? [account] : visibleAccounts();
  const read = await Promise.all(accounts.map(async (id) => ({ id, queue: await getStore().area<StoredQueue>(id, 'outbox.read') })));
  return {
    patches: read.reduce((sum, { queue }) => sum + queue.patches, 0),
    outbox: read.flatMap(({ id, queue }) => queue.entries.map((entry) => ({ ...entry, account: id }))),
    conflicts: read.flatMap(({ id, queue }) => queue.conflicts.map((conflict) => ({
      id: conflict.id,
      account: id,
      recordId: conflict.recordId,
      createdAt: conflict.createdAt,
      summary: conflict.summary,
    }))),
  };
}

/** Takes a waiting entry for sending: false when it isn't waiting any more (another tab took it, the user deleted it). */
export function claimForSending(account: string, id: number): Promise<boolean> {
  return getStore().area<boolean>(account, 'outbox.claim', { id });
}

export function updateOutboxEntry(
  entry: Pick<OutboxEntry, 'account' | 'id'>,
  patch: { status: OutboxStatus; error?: OutboxError; copyId?: string | null },
): Promise<void> {
  return getStore().area(entry.account, 'outbox.update', { id: entry.id, ...patch });
}

/** Removes an outbox entry and the files it held. */
export function removeOutboxEntry(entry: Pick<OutboxEntry, 'account' | 'id'>): Promise<void> {
  return getStore().area(entry.account, 'outbox.remove', { id: entry.id });
}

export function dismissConflict(account: string, id: number): Promise<void> {
  return getStore().area(account, 'outbox.dismissConflict', { id });
}

// ---- Files attached while offline ----

/** Keeps a file under a stand-in blob id until its message is sent. */
export async function holdFile(account: string, file: Blob, name: string, jmap?: string): Promise<{ blobId: string; size: number; type: string }> {
  const data = new Uint8Array(await file.arrayBuffer());
  return getStore().area(account, 'outbox.holdFile', { jmap, name, type: file.type, data });
}

export async function heldFile(account: string, blobId: string): Promise<File | null> {
  const held = await getStore().area<{ name: string; type: string; data: Uint8Array } | null>(account, 'outbox.heldFile', { blobId });
  if (!held) return null;
  return new File([held.data as BlobPart], held.name, { type: held.type });
}
