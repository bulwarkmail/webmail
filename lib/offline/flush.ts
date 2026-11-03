/**
 * Sends what waited on this device (#523), once the server answers again:
 * changes (read, flagged, tags, moves, deletes) and messages, in the order
 * they were made.
 *
 * - One tab at a time per account (Web Locks), and each message is taken
 *   for sending in one transaction (claimForSending), so two tabs never send
 *   it twice.
 * - A change the server refuses, or that meets a record changed since, goes
 *   to the user as a conflict (lib/store/outbox/flush-patches.ts).
 * - A message is sent as it was finished at Send (queue.ts); files attached
 *   offline are uploaded first. A hold for undo-send that has passed is
 *   dropped, so the message goes at once.
 * - Only a failure before the submission request (SendNotStartedError, a
 *   file upload on a dead network) puts a message back to waiting. A send
 *   whose connection broke after that is marked uncertain. A refusal by the
 *   server is marked failed, with the reason.
 * - An uncertain message is looked up when the server is back, by the
 *   Message-ID fixed when it was queued (lib/store/outbox/dedupe.ts): it's
 *   done, its copy gets submitted, or it goes again. Only when the lookup
 *   can't tell does it stay uncertain, for the user to decide.
 * - A message taken for sending by a tab that was closed on the way is
 *   uncertain after a minute.
 * - A message finished under rules the organisation has since made stricter
 *   (a label now required, a send check now required) is held for the user.
 */

import type { JMAPClient } from '@/lib/jmap/client';
import { isNetworkFailure } from '@/lib/jmap/offline-hooks';
import type { SendEmailResult } from '@/lib/jmap/types';
import { getStore } from '@/lib/store/client/api';
import type { MethodCall } from '@/lib/store/engine/transport';
import { decideRetry, type LookupIo, type RetryDecision } from '@/lib/store/outbox/dedupe';
import { flushPatches, type PatchIo, type PatchOutcome, type PendingPatch } from '@/lib/store/outbox/flush-patches';
import {
  claimForSending,
  heldFile,
  isLocalBlobId,
  readQueue,
  removeOutboxEntry,
  updateOutboxEntry,
  type OutboxEntry,
  type OutboxError,
} from './queue';
import { visibleAccounts } from './state';
import type { OfflineNotice } from './offline-mode';

export interface FlushDeps {
  notify: (notice: OfflineNotice) => void;
  allowed: () => boolean;
  /** Whether the organisation's rules got stricter since this message was finished. */
  stricterNow?: (entry: OutboxEntry) => boolean;
  /** A held send went out (an undo window still open). */
  onScheduled?: (entry: OutboxEntry, result: SendEmailResult) => void;
  /** A send's connection broke though the server may be fine: look it up again soon. */
  retryLater?: () => void;
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
    if (item.submitOnly) return client.submitRawEmail(file, item.identityId, delayed, item.envelopeRecipients, entry.copyId);
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
    return client.sendRawEmail(file, item.identityId, sent.id, drafts?.id, delayed, item.envelopeRecipients, entry.copyId);
  }
  const args = [...item.args];
  const attachments = args[10];
  // A copy on the server has its files already.
  if (Array.isArray(attachments) && !entry.copyId) {
    const resolved = [];
    for (const attachment of attachments as Array<{ blobId: string }>) {
      resolved.push(isLocalBlobId(attachment.blobId) ? { ...attachment, blobId: await uploadHeld(account, client, attachment.blobId) } : attachment);
    }
    args[10] = resolved;
  }
  const delayedUntil = args[13] as string | undefined;
  if (delayedUntil && Date.parse(delayedUntil) - Date.now() <= MIN_HOLD_MS) args[13] = undefined;
  if (entry.messageId || entry.copyId) {
    args[15] = {
      ...((args[15] as Record<string, unknown> | undefined) ?? {}),
      ...(entry.messageId ? { messageId: entry.messageId } : {}),
      ...(entry.copyId ? { existingCopyId: entry.copyId } : {}),
    };
  }
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
  const accounts = account ? [account] : visibleAccounts();
  await Promise.all(accounts.map((id) => getStore().area(id, 'outbox.settleStale', { before: now - SENDING_STALE_MS })));
}

/** The server refused the request itself: more tries won't change that. Outages and auth wait instead. */
function isRequestRefusal(error: unknown): boolean {
  return error instanceof Error && /^Request failed: (400|403|404|413|422)\b/.test(error.message);
}

/** The changes queued before `upToSeq` (all, with null). False when the run stopped on an outage. */
async function sendPatches(account: string, client: JMAPClient, deps: FlushDeps, upToSeq: number | null): Promise<boolean> {
  const pending = await getStore().area<PendingPatch[]>(account, 'outbox.pendingPatches', { upToSeq });
  if (pending.length === 0) return true;
  const io: PatchIo = {
    request: (calls: MethodCall[], using: string[]) => client.requestNetworkOnly(calls, using),
    isRefusal: isRequestRefusal,
  };
  return flushPatches(io, pending, async (outcomes: PatchOutcome[]) => {
    const conflicts = await getStore().area<number>(account, 'outbox.patchResults', { outcomes });
    if (conflicts > 0) deps.notify({ kind: 'conflict', count: conflicts });
  });
}

async function lookUp(client: JMAPClient, entry: OutboxEntry): Promise<RetryDecision> {
  const io: LookupIo = { request: (calls, using) => client.requestNetworkOnly(calls, using) };
  const fromEmail = entry.item.kind === 'email' ? entry.item.args[6] as string | undefined : undefined;
  const jmap = await client.resolveSendAccountId(fromEmail);
  const options = entry.item.kind === 'email' ? entry.item.args[15] as { noSentCopy?: boolean } | undefined : undefined;
  return decideRetry(io, {
    jmap,
    submissionJmap: client.submissionAccountFor(jmap),
    messageId: entry.messageId,
    attemptAt: entry.firstAttemptAt ?? entry.createdAt,
    now: Date.now(),
    copyKept: entry.item.kind === 'raw' ? !entry.item.submitOnly : !options?.noSentCopy,
  });
}

/** The draft the send was meant to replace: the lost response left it behind. Best effort. */
async function dropOldDraft(client: JMAPClient, entry: OutboxEntry): Promise<void> {
  if (entry.item.kind !== 'email' || typeof entry.item.args[7] !== 'string') return;
  const options = entry.item.args[15] as { draftAccountId?: string } | undefined;
  try {
    await client.requestNetworkOnly([['Email/set', { accountId: options?.draftAccountId || client.getAccountId(), destroy: [entry.item.args[7]] }, '0']]);
  } catch {
    // An orphan in Drafts, nothing worse.
  }
}

/** Uncertain messages, looked up now that the server answers. False when the run stopped on an outage. */
async function settleUncertain(account: string, client: JMAPClient, deps: FlushDeps): Promise<boolean> {
  const { outbox } = await readQueue(account);
  for (const entry of outbox) {
    if (entry.status !== 'uncertain') continue;
    if (stillOffline() || !deps.allowed()) return false;
    let decision: RetryDecision;
    try {
      decision = await lookUp(client, entry);
    } catch (error) {
      // The lookup failed: it stays uncertain, for this time.
      if (isNetworkFailure(error)) return false;
      continue;
    }
    switch (decision.action) {
      case 'done':
        await removeOutboxEntry(entry);
        await dropOldDraft(client, entry);
        void client.pruneEmailSubmissions();
        // A canceled one wasn't sent: someone decided that, and it's in Drafts.
        if (decision.why !== 'canceled') deps.notify({ kind: 'sent', subject: entry.summary.subject });
        break;
      case 'submit':
        await updateOutboxEntry(entry, { status: 'waiting', copyId: decision.emailId });
        break;
      case 'send':
        await updateOutboxEntry(entry, { status: 'waiting', copyId: null });
        break;
      case 'undecided':
        break;
    }
  }
  return true;
}

async function flushLocked(account: string, client: JMAPClient, deps: FlushDeps): Promise<void> {
  if (flushing.has(account) || !deps.allowed()) return;
  flushing.add(account);
  try {
    await settleStaleSends(account);
    if (!(await settleUncertain(account, client, deps))) return;
    // In the order they were made: a reply's $answered, queued after the
    // reply, goes after it.
    const { outbox } = await readQueue(account);
    for (const entry of outbox) {
      if (entry.status !== 'waiting') continue;
      if (stillOffline() || !deps.allowed()) return;
      if (!(await sendPatches(account, client, deps, entry.seq))) return;
      if (deps.stricterNow?.(entry)) {
        await updateOutboxEntry(entry, { status: 'held' });
        deps.notify({ kind: 'held', subject: entry.summary.subject });
        continue;
      }
      // Another tab took it, or it was deleted meanwhile.
      if (!(await claimForSending(account, entry.id))) continue;
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
          await updateOutboxEntry(entry, { status: 'failed', error: { code }, copyId: null });
          deps.notify({ kind: 'send-failed', subject: entry.summary.subject, error: { code } });
          continue;
        }
        if (isNetworkFailure(error) || (error instanceof Error && error.name === 'SendUnconfirmedError')) {
          // It may have reached the server: looked up before it goes again.
          await updateOutboxEntry(entry, { status: 'uncertain' });
          deps.retryLater?.();
          return;
        }
        const text = error instanceof Error ? error.message : String(error);
        // The client took back the copy of a refused send.
        await updateOutboxEntry(entry, { status: 'failed', error: { text }, copyId: null });
        deps.notify({ kind: 'send-failed', subject: entry.summary.subject, error: { text } });
        continue;
      }
      await removeOutboxEntry(entry);
      void client.pruneEmailSubmissions();
      if (result.scheduled) deps.onScheduled?.(entry, result);
      deps.notify({ kind: 'sent', subject: entry.summary.subject });
    }
    if (stillOffline() || !deps.allowed()) return;
    await sendPatches(account, client, deps, null);
  } finally {
    flushing.delete(account);
  }
}

/** "Send again" for a failed or uncertain message (a held one waits for its rules). */
export async function retryOutboxEntry(account: string, id: number): Promise<void> {
  const { outbox } = await readQueue(account);
  const entry = outbox.find((e) => e.id === id);
  if (entry && (entry.status === 'failed' || entry.status === 'uncertain')) await updateOutboxEntry(entry, { status: 'waiting' });
}

/** "Delete" in the outbox. */
export async function deleteOutboxEntry(account: string, id: number): Promise<void> {
  await removeOutboxEntry({ account, id });
}
