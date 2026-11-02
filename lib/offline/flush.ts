/**
 * Sends what waited on this device (#523), once the server answers again:
 * first the changes (read, flagged, tags, moves) in the order they were
 * made, then the outbox, oldest first.
 *
 * - One tab at a time per account (Web Locks), and each message is taken
 *   for sending in one database transaction (claimForSending), so two tabs
 *   never send it twice.
 * - Changes and messages go in the order they were made.
 * - A change the server refuses (the message is gone, moved elsewhere) is
 *   dropped: the server's state wins.
 * - A message is sent as it was finished at Send (queue.ts); files attached
 *   offline are uploaded first. A hold for undo-send that has passed is
 *   dropped, so the message goes at once.
 * - Only a failure before the submission request (SendNotStartedError, a
 *   file upload on a dead network) puts a message back to waiting. A send
 *   whose connection broke after that is marked uncertain and never sent
 *   again by itself: it may have gone out. A refusal by the server is marked
 *   failed, with the reason.
 * - A message taken for sending by a tab that was closed on the way is
 *   uncertain after a minute.
 * - A message finished under rules the organisation has since made stricter
 *   (a label now required, a send check now required) is held for the user.
 */

import type { JMAPClient } from '@/lib/jmap/client';
import { isNetworkFailure } from '@/lib/jmap/offline-hooks';
import type { SendEmailResult } from '@/lib/jmap/types';
import {
  claimForSending,
  heldFile,
  isLocalBlobId,
  readQueue,
  removeOutboxEntry,
  removeQueued,
  updateOutboxEntry,
  type OutboxEntry,
  type OutboxError,
} from './queue';
import type { OfflineNotice } from './offline-mode';

export interface FlushDeps {
  notify: (notice: OfflineNotice) => void;
  allowed: () => boolean;
  /** Whether the organisation's rules got stricter since this message was finished. */
  stricterNow?: (entry: OutboxEntry) => boolean;
  /** A held send went out (an undo window still open). */
  onScheduled?: (entry: OutboxEntry, result: SendEmailResult) => void;
}

/** A send is taken for at most this long before a closed tab's send counts as uncertain. */
export const SENDING_STALE_MS = 60_000;

const flushing = new Set<string>();

/** A hold shorter than this is dropped: the undo window passed while the message waited. */
const MIN_HOLD_MS = 10_000;

/** Ours to tell the user, not the server's. */
class OutboxPrepError extends Error {
  constructor(readonly code: NonNullable<OutboxError['code']>) {
    super(code);
    this.name = 'OutboxPrepError';
  }
}

function notStartedError(message: string): Error {
  return Object.assign(new Error(message), { name: 'SendNotStartedError' });
}

function stillOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/** Before anything was handed to the server: a dead network here means nothing went out. */
function notStarted(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'SendNotStartedError' || error.name === 'OfflineUnavailableError';
}

async function uploadHeld(account: string, client: JMAPClient, blobId: string): Promise<string> {
  const file = await heldFile(account, blobId);
  if (!file) throw new OutboxPrepError('file_missing');
  try {
    return (await client.uploadBlob(file)).blobId;
  } catch (error) {
    if (isNetworkFailure(error)) throw notStartedError('upload failed');
    throw error;
  }
}

async function sendEntry(account: string, client: JMAPClient, entry: OutboxEntry): Promise<SendEmailResult> {
  const item = entry.item;
  if (item.kind === 'raw') {
    const file = await heldFile(account, item.blobId);
    if (!file) throw new OutboxPrepError('file_missing');
    const delayed = item.delayedUntil && Date.parse(item.delayedUntil) - Date.now() > MIN_HOLD_MS ? item.delayedUntil : undefined;
    if (item.submitOnly) return client.submitRawEmail(file, item.identityId, delayed, item.envelopeRecipients);
    let mailboxes;
    try {
      mailboxes = await client.getMailboxes();
    } catch (error) {
      if (isNetworkFailure(error)) throw notStartedError('folders unavailable');
      throw error;
    }
    const sent = mailboxes.find((m) => m.role === 'sent');
    if (!sent) throw new OutboxPrepError('no_sent_mailbox');
    const drafts = mailboxes.find((m) => m.role === 'drafts');
    return client.sendRawEmail(file, item.identityId, sent.id, drafts?.id, delayed, item.envelopeRecipients);
  }
  const args = [...item.args];
  const attachments = args[10];
  if (Array.isArray(attachments)) {
    const resolved = [];
    for (const attachment of attachments as Array<{ blobId: string }>) {
      resolved.push(isLocalBlobId(attachment.blobId) ? { ...attachment, blobId: await uploadHeld(account, client, attachment.blobId) } : attachment);
    }
    args[10] = resolved;
  }
  const delayedUntil = args[13] as string | undefined;
  if (delayedUntil && Date.parse(delayedUntil) - Date.now() <= MIN_HOLD_MS) args[13] = undefined;
  const send = client.sendEmail.bind(client) as (...a: unknown[]) => Promise<SendEmailResult>;
  return send(...args);
}

/** Sends what waits for an account, one tab at a time. */
export async function flushQueue(account: string, client: JMAPClient, deps: FlushDeps): Promise<void> {
  const run = () => flushLocked(account, client, deps);
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  if (locks?.request) {
    await locks.request(`bulwark-offline-flush:${account}`, run);
    return;
  }
  await run();
}

/** Marks sends of closed tabs uncertain (they may have gone out). */
export async function settleStaleSends(account?: string, now = Date.now()): Promise<void> {
  const { outbox } = await readQueue(account);
  for (const entry of outbox) {
    if (entry.status === 'sending' && (entry.sendingSince ?? 0) < now - SENDING_STALE_MS) {
      await updateOutboxEntry(entry, { status: 'uncertain' });
    }
  }
}

async function flushLocked(account: string, client: JMAPClient, deps: FlushDeps): Promise<void> {
  if (flushing.has(account) || !deps.allowed()) return;
  flushing.add(account);
  try {
    await settleStaleSends(account);
    const { patches, outbox } = await readQueue(account);
    // In the order they were made: a reply's $answered, queued after the
    // reply, goes after it.
    const items = [
      ...patches.map((patch) => ({ id: patch.id, patch })),
      ...outbox.map((entry) => ({ id: entry.id, entry })),
    ].sort((x, y) => x.id - y.id);

    for (const item of items) {
      if ('patch' in item && item.patch) {
        if (stillOffline()) return;
        try {
          await client.applyEmailPatches(item.patch.item.jmap, item.patch.item.update);
        } catch (error) {
          // Still no server: try again later. Anything else: the server's state wins.
          if (isNetworkFailure(error)) return;
        }
        await removeQueued([item.patch.id]);
        continue;
      }
      const entry = (item as { entry: OutboxEntry }).entry;
      if (entry.status !== 'waiting') continue;
      if (stillOffline() || !deps.allowed()) return;
      if (deps.stricterNow?.(entry)) {
        await updateOutboxEntry(entry, { status: 'held' });
        deps.notify({ kind: 'held', subject: entry.summary.subject });
        continue;
      }
      // Another tab took it, or it was deleted meanwhile.
      if (!(await claimForSending(entry.id))) continue;
      let result: SendEmailResult;
      try {
        result = await sendEntry(account, client, entry);
      } catch (error) {
        if (notStarted(error)) {
          // Nothing left: it waits for the next try.
          await updateOutboxEntry(entry, { status: 'waiting' });
          return;
        }
        if (error instanceof Error && error.name === 'OutboxPrepError') {
          const code = (error as OutboxPrepError).code;
          await updateOutboxEntry(entry, { status: 'failed', error: { code } });
          deps.notify({ kind: 'send-failed', subject: entry.summary.subject, error: { code } });
          continue;
        }
        if (isNetworkFailure(error) || (error instanceof Error && (error.name === 'RequestTimeoutError' || error.name === 'SendUnconfirmedError'))) {
          // It may have reached the server: never sent again by itself.
          await updateOutboxEntry(entry, { status: 'uncertain' });
          return;
        }
        const text = error instanceof Error ? error.message : String(error);
        await updateOutboxEntry(entry, { status: 'failed', error: { text } });
        deps.notify({ kind: 'send-failed', subject: entry.summary.subject, error: { text } });
        continue;
      }
      await removeOutboxEntry(entry);
      void client.pruneEmailSubmissions();
      if (result.scheduled) deps.onScheduled?.(entry, result);
      deps.notify({ kind: 'sent', subject: entry.summary.subject });
    }
  } finally {
    flushing.delete(account);
  }
}

/** "Send again" for a failed or uncertain message (a held one waits for its rules). */
export async function retryOutboxEntry(id: number): Promise<void> {
  const { outbox } = await readQueue();
  const entry = outbox.find((e) => e.id === id);
  if (entry && (entry.status === 'failed' || entry.status === 'uncertain')) await updateOutboxEntry(entry, { status: 'waiting' });
}

/** "Delete" in the outbox. */
export async function deleteOutboxEntry(id: number): Promise<void> {
  const { outbox } = await readQueue();
  const entry = outbox.find((e) => e.id === id);
  if (entry) await removeOutboxEntry(entry);
}
