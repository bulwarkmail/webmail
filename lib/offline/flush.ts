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
 * - A failure before the submission request (SendNotStartedError, a file
 *   upload on a dead network), a rate limit, a login that needs renewing and
 *   trouble with this device's store put a message back to waiting. A send whose
 *   connection broke, or that got a 5xx, is marked uncertain. A refusal by the
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
import { isStandInId } from '@/lib/jmap/stand-in-ids';
import { useAuthStore } from '@/stores/auth-store';
import type { DraftElsewhere } from '@/lib/store/drafts/calls';
import { getStore } from '@/lib/store/client/api';
import { flushDrafts, type DraftFlushIo } from '@/lib/store/drafts/flush';
import { isStorageFailure } from '@/lib/store/storage';
import type { MethodCall } from '@/lib/store/engine/transport';
import { decideRetry, type LookupIo, type RetryDecision } from '@/lib/store/outbox/dedupe';
import { flushPatches, isRequestRefusal, type PatchIo, type PatchOutcome, type PendingPatch } from '@/lib/store/outbox/flush-patches';
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
  /** A draft saved on this device reached the server: lists and open pages read again. */
  onDraftSent?: () => void;
}

/** A message that just went may not show in a lookup yet, which would send it twice. */
export const LOOKUP_WAIT_MS = 30_000;

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

/**
 * Not the server's word about this message: it's rate limiting, the login needs
 * renewing, or this device's store is in the way. The next try goes as usual.
 */
function waitsForNextTry(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'RateLimitError' || error.name === 'StoreOwnerGoneError' || error.name === 'StoreKeyError') return true;
  if (isStorageFailure(error)) return true;
  return /^Request failed: (401|408|429)\b/.test(error.message);
}

/** A server error can come after the message went through: looked up before it goes again. */
function mayHaveArrived(error: unknown): boolean {
  if (isNetworkFailure(error)) return true;
  return error instanceof Error && (error.name === 'SendUnconfirmedError' || /^Request failed: 5\d\d\b/.test(error.message));
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
  let uploaded: string;
  try {
    uploaded = (await client.uploadBlob(file, { noHold: true })).blobId;
  } catch (error) {
    if (isNetworkFailure(error)) throw notStartedError('upload failed');
    throw error;
  }
  // The server went away just now, and offline mode held the file again.
  if (isLocalBlobId(uploaded)) throw notStartedError('upload held');
  return uploaded;
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
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  const run = () => flushLocked(account, client, deps, Boolean(locks?.request));
  if (locks?.request) {
    await locks.request(`bulwark-offline-flush:${account}`, run);
    return;
  }
  await run();
}

/** A file attached offline to something that was then discarded goes after this long. */
export const ORPHAN_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ORPHAN_CHECK_MS = 24 * 60 * 60 * 1000;
const orphansCheckedAt = new Map<string, number>();

async function dropOrphanFiles(account: string): Promise<void> {
  const now = Date.now();
  if (now - (orphansCheckedAt.get(account) ?? 0) < ORPHAN_CHECK_MS) return;
  orphansCheckedAt.set(account, now);
  await getStore().area(account, 'outbox.dropOrphans', { olderThan: now - ORPHAN_FILE_AGE_MS }).catch(() => {});
}

/** Tests only. */
export function forgetOrphanCheck(): void {
  orphansCheckedAt.clear();
}

/** Marks sends of closed tabs uncertain (they may have gone out). */
export async function settleStaleSends(account?: string, now = Date.now()): Promise<void> {
  const accounts = account ? [account] : visibleAccounts();
  // One account's store in trouble doesn't hold up another's.
  await Promise.allSettled(accounts.map((id) => getStore().area(id, 'outbox.settleStale', { before: now - SENDING_STALE_MS })));
}

/** The drafts saved on this device. False when the run stopped on an outage. */
function sendDrafts(account: string, client: JMAPClient, deps: FlushDeps, locked: boolean): Promise<boolean> {
  const store = getStore();
  const io: DraftFlushIo = {
    store: {
      // Under the lock, what says it's on its way was left by a tab that's gone.
      read: () => store.area(account, 'drafts.read', { before: locked ? Date.now() + 1 : Date.now() - SENDING_STALE_MS }),
      claim: (localId) => store.area(account, 'drafts.claim', { localId }),
      failed: (localId, status, error, neverSent) => store.area(account, 'drafts.failed', { localId, status, error, neverSent }),
      created: (result) => store.area(account, 'drafts.created', result),
      ghostsLooked: (jmap, messageIds, found) => store.area(account, 'drafts.ghostsLooked', { jmap, messageIds, found }),
    },
    request: (calls, using) => client.requestNetworkOnly(calls, using),
    upload: async (jmap, blobId) => {
      const file = await heldFile(account, blobId);
      return file ? (await client.uploadBlob(file, { accountId: jmap, noHold: true })).blobId : null;
    },
    // An upload's refusal has no JMAP problem document, only its status.
    isRefusal: (error) => isRequestRefusal(error) || (error instanceof Error && /^Failed to upload file: (400|403|404|413|422)\b/.test(error.message)),
    onRefused: (subject, error) => deps.notify({ kind: 'draft-refused', subject, error }),
    onConflict: (subject) => deps.notify({ kind: 'draft-conflict', subject }),
    onSent: () => deps.onDraftSent?.(),
  };
  return flushDrafts(io);
}

/**
 * Old versions in another login, now that their replacement is up. Best effort,
 * and only while still a draft there: an old copy is the worst that can come of it.
 */
async function removeVersionsElsewhere(account: string): Promise<void> {
  const store = getStore();
  for (const row of await store.area<DraftElsewhere[]>(account, 'drafts.elsewhereReady')) {
    const other = useAuthStore.getState().getClientForAccount?.(row.login);
    if (!other) continue;
    try {
      const response = await other.requestNetworkOnly([['Email/get', { accountId: row.jmap ?? other.getAccountId(), ids: [row.recordId], properties: ['keywords'] }, '0']]);
      const email = response.methodResponses?.[0]?.[1]?.list?.[0] as { keywords?: Record<string, boolean> } | undefined;
      if (email?.keywords?.$draft) await other.deleteEmail(row.recordId, row.jmap ?? undefined);
      await store.area(account, 'drafts.elsewhereDone', { id: row.id });
    } catch {
      // That login's server may be down too. It waits.
    }
  }
}

/** The changes queued before `upToSeq` (all, with null). False when the run stopped on an outage. */
async function sendPatches(account: string, client: JMAPClient, deps: FlushDeps, upToSeq: number | null): Promise<boolean> {
  const pending = await getStore().area<PendingPatch[]>(account, 'outbox.pendingPatches', { upToSeq });
  if (pending.length === 0) return true;
  const io: PatchIo = {
    request: (calls: MethodCall[], using: string[]) => client.requestNetworkOnly(calls, using),
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
  const jmap = options?.draftAccountId || client.getAccountId();
  try {
    if (isStandInId(entry.item.args[7])) {
      // Never reached the server: it only has to stop going there.
      await getStore().area(entry.account, 'drafts.discard', { jmap, id: entry.item.args[7] });
      return;
    }
    await client.requestNetworkOnly([['Email/set', { accountId: jmap, destroy: [entry.item.args[7]] }, '0']]);
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
    if (entry.lastAttemptAt && Date.now() - entry.lastAttemptAt < LOOKUP_WAIT_MS) {
      deps.retryLater?.();
      continue;
    }
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

async function flushLocked(account: string, client: JMAPClient, deps: FlushDeps, locked: boolean): Promise<void> {
  if (flushing.has(account) || !deps.allowed()) return;
  flushing.add(account);
  try {
    await settleStaleSends(account);
    // A draft goes before the changes that may be waiting: what it replaces
    // only starts to go once it's there.
    if (!(await sendDrafts(account, client, deps, locked))) {
      // Nothing else starts it again if the server only stumbled.
      if (!stillOffline()) deps.retryLater?.();
      return;
    }
    await removeVersionsElsewhere(account);
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
        if (waitsForNextTry(error)) {
          // Nothing the user can do about it, and the copy on the server stays useful.
          await updateOutboxEntry(entry, { status: 'waiting' });
          deps.retryLater?.();
          return;
        }
        if (mayHaveArrived(error)) {
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
    await dropOrphanFiles(account);
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
