/**
 * What waits on this device for the network (#523): changes made offline
 * (read, flagged, tags, moves) and the outbox. Both are kept encrypted in
 * the offline database and sent in the order they were made.
 *
 * An outbox entry is a finished message: everything a send does up to the
 * transport ran when the user clicked Send (the organisation's checks,
 * the classification label, signatures and disclaimers, plugin send checks,
 * S/MIME or PGP with the user present). What is kept is the arguments of the
 * final send, with the files that couldn't be uploaded yet, or the finished
 * raw message of a plugin's send. Sending it later can't skip any of that.
 *
 * The state of an outbox entry (waiting, sending, ...) is kept unencrypted
 * next to it, so that taking an entry for sending is one database
 * transaction: two tabs can't both take it (claimForSending).
 */

import { idbAdd, idbDeleteAccount, idbGet, idbGetAll, idbGetAllByAccount, idbUpdate, idbWrite } from './db';
import { openBytes, openJson, sealBytes, sealJson, type Sealed } from './crypto';
import { generateUUID } from '@/lib/utils';

export interface PatchItem {
  kind: 'patch';
  jmap: string;
  update: Record<string, Record<string, unknown>>;
}

/** The arguments of useEmailStore.sendEmail after the client (positional, as the client takes them). */
export interface EmailSendItem {
  kind: 'email';
  args: unknown[];
}

export interface RawSendItem {
  kind: 'raw';
  /** The finished message, kept as an upload until it is sent. */
  blobId: string;
  identityId: string;
  delayedUntil?: string;
  envelopeRecipients?: string[];
  /** submitRaw: no copy in Sent. */
  submitOnly?: boolean;
}

export type SendItem = EmailSendItem | RawSendItem;

export interface OutboxSummary {
  subject: string;
  to: string[];
}

/**
 * - waiting: goes out by itself when the server answers;
 * - sending: on its way (a tab took it);
 * - failed: the server refused it; the error says why;
 * - uncertain: the connection broke after it may have reached the server;
 *   never sent again by itself;
 * - held: the organisation's rules got stricter while it waited.
 */
export type OutboxStatus = 'waiting' | 'sending' | 'failed' | 'uncertain' | 'held';

/** Why an entry failed: one of ours (a code the UI translates) or the server's own words. */
export interface OutboxError {
  code?: 'file_missing' | 'no_sent_mailbox' | 'no_drafts_mailbox';
  text?: string;
}

/** What the organisation required when the message was finished (see offline-mode.ts policyFingerprint). */
export interface PolicyFingerprint {
  labelRequired: boolean;
  hasLabel: boolean;
  guards: string[];
}

export interface OutboxEntry {
  id: number;
  account: string;
  createdAt: number;
  summary: OutboxSummary;
  status: OutboxStatus;
  /** When a tab took it for sending (ms). */
  sendingSince?: number;
  error?: OutboxError;
  item: SendItem;
  fingerprint?: PolicyFingerprint;
}

interface QueueRecord extends Sealed {
  id?: number;
  account: string;
  kind: 'patch' | 'send';
  createdAt: number;
  status?: OutboxStatus;
  sendingSince?: number;
}

interface SendPayload {
  summary: OutboxSummary;
  error?: OutboxError;
  item: SendItem;
  fingerprint?: PolicyFingerprint;
}

export async function queuePatch(account: string, jmap: string, update: PatchItem['update']): Promise<void> {
  const item: PatchItem = { kind: 'patch', jmap, update };
  await idbAdd('queue', { account, kind: 'patch', createdAt: Date.now(), ...(await sealJson(item)) } satisfies QueueRecord);
}

export async function queueSend(account: string, summary: OutboxSummary, item: SendItem, fingerprint?: PolicyFingerprint): Promise<number> {
  const payload: SendPayload = { summary, item, fingerprint };
  return Number(await idbAdd('queue', { account, kind: 'send', createdAt: Date.now(), status: 'waiting', ...(await sealJson(payload)) } satisfies QueueRecord));
}

export interface QueuedPatch { id: number; account: string; item: PatchItem }

/** Everything waiting for one account (or all), oldest first. */
export async function readQueue(account?: string): Promise<{ patches: QueuedPatch[]; outbox: OutboxEntry[] }> {
  const records = account ? await idbGetAllByAccount<QueueRecord>('queue', account) : await idbGetAll<QueueRecord>('queue');
  records.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const patches: QueuedPatch[] = [];
  const outbox: OutboxEntry[] = [];
  for (const record of records) {
    try {
      if (record.kind === 'patch') {
        patches.push({ id: record.id!, account: record.account, item: await openJson<PatchItem>(record) });
      } else {
        const payload = await openJson<SendPayload>(record);
        outbox.push({
          id: record.id!,
          account: record.account,
          createdAt: record.createdAt,
          status: record.status ?? 'waiting',
          sendingSince: record.sendingSince,
          ...payload,
        });
      }
    } catch {
      // Sealed with a key that is gone; removed with the account.
    }
  }
  return { patches, outbox };
}

/**
 * Takes a waiting entry for sending, in one transaction: false when it
 * isn't waiting any more (another tab took it, the user deleted it).
 */
export async function claimForSending(id: number): Promise<boolean> {
  return idbUpdate<QueueRecord>('queue', id, (record) => {
    if (!record || record.kind !== 'send' || (record.status ?? 'waiting') !== 'waiting') return undefined;
    return { ...record, status: 'sending', sendingSince: Date.now() };
  });
}

/** Sets an entry's state; with an error or a new after-send list, its payload too. */
export async function updateOutboxEntry(
  entry: OutboxEntry,
  patch: { status: OutboxStatus; error?: OutboxError },
): Promise<void> {
  const payload: SendPayload = {
    summary: entry.summary,
    item: entry.item,
    fingerprint: entry.fingerprint,
    error: patch.error,
  };
  const sealed = await sealJson(payload);
  await idbUpdate<QueueRecord>('queue', entry.id, (record) => {
    // Deleted meanwhile: stays deleted.
    if (!record) return undefined;
    return { ...record, status: patch.status, sendingSince: patch.status === 'sending' ? Date.now() : undefined, ...sealed };
  });
}

export async function removeQueued(ids: number[]): Promise<void> {
  await idbWrite(ids.map((id) => ({ store: 'queue' as const, del: id })));
}

/** Removes an outbox entry and the files it held. */
export async function removeOutboxEntry(entry: OutboxEntry): Promise<void> {
  const blobIds = heldBlobIds(entry.item);
  await idbWrite([
    { store: 'queue', del: entry.id },
    ...blobIds.map((blobId) => ({ store: 'uploads' as const, del: uploadKey(entry.account, blobId) })),
  ]);
}

// ---- Files attached while offline ----

/** Stand-in blob ids of files kept on this device start with this. */
export const LOCAL_BLOB_PREFIX = 'bulwark-local-';

const uploadKey = (account: string, blobId: string) => `${account}\u0001${blobId}`;

export function isLocalBlobId(blobId: unknown): blobId is string {
  return typeof blobId === 'string' && blobId.startsWith(LOCAL_BLOB_PREFIX);
}

interface UploadRecord extends Sealed {
  key: string;
  account: string;
  createdAt: number;
  /** The file's name and type, sealed: names say a lot about a message. */
  meta: Sealed;
}

/** Keeps a file under a stand-in blob id until its message is sent. */
export async function holdFile(account: string, file: Blob, name: string): Promise<{ blobId: string; size: number; type: string }> {
  const blobId = `${LOCAL_BLOB_PREFIX}${generateUUID()}`;
  const sealed = await sealBytes(await file.arrayBuffer());
  const meta = await sealJson({ name, type: file.type });
  await idbWrite([{ store: 'uploads', put: { key: uploadKey(account, blobId), account, createdAt: Date.now(), meta, ...sealed } satisfies UploadRecord }]);
  return { blobId, size: file.size, type: file.type || 'application/octet-stream' };
}

export async function heldFile(account: string, blobId: string): Promise<File | null> {
  const record = await idbGet<UploadRecord>('uploads', uploadKey(account, blobId));
  if (!record) return null;
  try {
    const meta = await openJson<{ name?: string; type?: string }>(record.meta);
    return new File([await openBytes(record)], meta.name || 'attachment', { type: meta.type || 'application/octet-stream' });
  } catch {
    return null;
  }
}

/** The stand-in blob ids an outbox entry needs uploaded first. */
export function heldBlobIds(item: SendItem): string[] {
  if (item.kind === 'raw') return isLocalBlobId(item.blobId) ? [item.blobId] : [];
  const attachments = item.args[10];
  if (!Array.isArray(attachments)) return [];
  return attachments.map((a) => (a as { blobId?: unknown }).blobId).filter(isLocalBlobId);
}

/** Files held for no outbox entry (attached offline to a message that was then discarded). */
export async function dropOrphanFiles(account: string, olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  const { outbox } = await readQueue(account);
  const needed = new Set(outbox.flatMap((entry) => heldBlobIds(entry.item)));
  const held = await idbGetAllByAccount<{ key: string; createdAt?: number }>('uploads', account);
  const cutoff = Date.now() - olderThanMs;
  const stale = held.filter((record) => {
    const blobId = record.key.split('\u0001')[1];
    return !needed.has(blobId) && (record.createdAt ?? 0) < cutoff;
  });
  await idbWrite(stale.map((record) => ({ store: 'uploads' as const, del: record.key })));
}

/** The queue and held files of one account. */
export async function wipeAccountQueue(account: string): Promise<void> {
  await idbDeleteAccount(account, ['queue', 'uploads']);
}
