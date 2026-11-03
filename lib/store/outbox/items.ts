/**
 * What a finished send looks like when it waits. An outbox entry is a finished
 * message: everything a send does up to the transport ran when the user clicked
 * Send (the organisation's checks, the label, signatures, plugin send checks,
 * S/MIME or PGP with the user present). What is kept is the arguments of the
 * final send, or the finished raw message of a plugin's send. Sending it later
 * can't skip any of that.
 */

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
 * - uncertain: the connection broke after it may have reached the server.
 *   Looked up when the server is back; stays this way only when the lookup
 *   can't tell, and then it's the user's to send again or delete;
 * - held: the organisation's rules got stricter while it waited.
 */
export type OutboxStatus = 'waiting' | 'sending' | 'failed' | 'uncertain' | 'held';

/** Why an entry failed: one of ours (a code the UI translates) or the server's own words. */
export interface OutboxError {
  code?: 'file_missing' | 'no_sent_mailbox' | 'no_drafts_mailbox';
  text?: string;
}

/** What the organisation required when the message was finished. */
export interface PolicyFingerprint {
  labelRequired: boolean;
  hasLabel: boolean;
  guards: string[];
}

export interface StoredOutboxEntry {
  id: number;
  seq: number;
  createdAt: number;
  summary: OutboxSummary;
  status: OutboxStatus;
  sendingSince?: number;
  firstAttemptAt?: number;
  error?: OutboxError;
  item: SendItem;
  fingerprint?: PolicyFingerprint;
  messageId?: string;
  copyId?: string;
  skipLookup?: boolean;
}

/** Stand-in blob ids of files kept on this device start with this. */
export const LOCAL_BLOB_PREFIX = 'bulwark-local-';

export function isLocalBlobId(blobId: unknown): blobId is string {
  return typeof blobId === 'string' && blobId.startsWith(LOCAL_BLOB_PREFIX);
}

/** The stand-in blob ids an outbox entry needs uploaded first. */
export function heldBlobIds(item: SendItem): string[] {
  if (item.kind === 'raw') return isLocalBlobId(item.blobId) ? [item.blobId] : [];
  const attachments = item.args[10];
  if (!Array.isArray(attachments)) return [];
  return attachments.map((a) => (a as { blobId?: unknown }).blobId).filter(isLocalBlobId);
}

export type ConflictReason = 'changed' | 'gone' | 'refused';

export interface ConflictSummary {
  subject: string;
  op: 'update' | 'destroy';
  reason: ConflictReason;
  /** The server's word when it refused. */
  detail?: string;
}

export interface StoredConflict {
  id: number;
  jmap: string;
  recordId: string;
  createdAt: number;
  summary: ConflictSummary;
}
