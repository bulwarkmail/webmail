/**
 * What waits on this device for the network (#523): the page's view of the
 * outbox in the local store (lib/store/outbox). Changes made offline wait there
 * merged per record; messages wait as finished sends. Everything is kept
 * encrypted in the store, and taking an entry for sending is one SQLite
 * transaction, so two tabs can't both take it (claimForSending).
 */

import { requestOutboxSync } from '@/lib/pwa-notify/outbox-sync';
import { getStore } from '@/lib/store/client/api';
import type { LocalDraftSummary } from '@/lib/store/drafts/calls';
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
export async function readQueue(account?: string): Promise<{ failed: string[]; patches: number; patchesBy: Record<string, number>; outbox: OutboxEntry[]; conflicts: ConflictEntry[] }> {
  const accounts = account ? [account] : visibleAccounts();
  const settled = await Promise.allSettled(accounts.map(async (id) => ({ id, queue: await getStore().area<StoredQueue>(id, 'outbox.read') })));
  const read = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const failed = accounts.filter((_, index) => settled[index].status === 'rejected');
  // Nothing could be read: that isn't an empty queue.
  if (read.length === 0 && failed.length > 0) throw (settled[0] as PromiseRejectedResult).reason;
  return {
    failed,
    patches: read.reduce((sum, { queue }) => sum + queue.patches, 0),
    patchesBy: Object.fromEntries(read.map(({ id, queue }) => [id, queue.patches])),
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

export interface LocalDraftRow extends LocalDraftSummary {
  account: string;
}

/** Drafts that are only on this device, oldest first. */
export async function readLocalDrafts(account?: string): Promise<LocalDraftRow[]> {
  const accounts = account ? [account] : visibleAccounts();
  // An account in trouble is what readQueue reports. Its drafts are still there.
  const settled = await Promise.allSettled(accounts.map(async (id) => ((await getStore().area<LocalDraftSummary[] | undefined>(id, 'drafts.list')) ?? []).map((row) => ({ ...row, account: id }))));
  return settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

/** An old version in another login: removed through it once the draft here is on the server. */
export function noteDraftReplacedElsewhere(account: string, localId: string, version: { login: string; jmap?: string; id: string }): Promise<void> {
  return getStore().area(account, 'drafts.noteElsewhere', { localId, ...version });
}

/** Asks the server again about a draft it refused. */
export function retryLocalDraft(account: string, localId: string): Promise<void> {
  return getStore().area(account, 'drafts.retry', { localId });
}

export function dismissConflict(account: string, id: number): Promise<void> {
  return getStore().area(account, 'outbox.dismissConflict', { id });
}

// ---- Files attached while offline ----

/** A file on its way to the store is cut into pieces of this size, so it's never in memory as a whole. */
const HOLD_CHUNK_BYTES = 1024 * 1024;

/** Keeps a file under a stand-in blob id until its message is sent. */
export async function holdFile(account: string, file: Blob, name: string, jmap?: string): Promise<{ blobId: string; size: number; type: string }> {
  const store = getStore();
  const { blobId } = await store.area<{ blobId: string }>(account, 'outbox.holdStart', { jmap, name, type: file.type, size: file.size });
  try {
    for (let at = 0, seq = 0; at < file.size; at += HOLD_CHUNK_BYTES, seq += 1) {
      const data = new Uint8Array(await file.slice(at, at + HOLD_CHUNK_BYTES).arrayBuffer());
      await store.area(account, 'outbox.holdChunk', { blobId, seq, data });
    }
    return await store.area(account, 'outbox.holdEnd', { blobId });
  } catch (error) {
    await store.area(account, 'outbox.holdAbort', { blobId }).catch(() => {});
    throw error;
  }
}

export async function heldFile(account: string, blobId: string): Promise<File | null> {
  const held = await getStore().area<{ name: string; type: string; blob: Blob } | null>(account, 'outbox.heldFile', { blobId });
  if (!held) return null;
  return new File([held.blob], held.name, { type: held.type });
}
