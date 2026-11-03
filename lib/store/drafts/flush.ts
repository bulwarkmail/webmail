/**
 * Sends the drafts saved on this device, written against a small `io` so the
 * page can run it through the JMAP client while the logic is tested next to the
 * store (decision 15).
 *
 * For each draft, in order: look up whether it arrived already when an answer got
 * lost, read the versions it replaces, upload its files, create it, and report.
 * The store only then queues the old versions for removal, so a failure anywhere
 * leaves a copy on the server or on the device, never neither. Anything that
 * looks like an outage ends the run and the draft waits. A refusal stays with
 * the draft, on the device, for the user to see.
 *
 * Message-ID lookups match on the client: `header` and `text` filters find no
 * Message-ID on either Stalwart (decision 4).
 */

import { JmapMethodError, responseFor, type JmapResponse, type MethodCall } from '../engine/transport';
import { EMAIL_BODY_PROPERTIES, EMAIL_LIST_PROPERTIES, MAIL_USING, type EmailObject } from '../mail/records';
import { CLOCK_SKEW_MARGIN_MS } from '../outbox/dedupe';
import type { DraftGhost, PendingDraft } from './calls';
import { heldBlobsOf, withUploadedBlobs } from './local-email';
import type { DraftError } from './pending';

export interface DraftFlushStore {
  read(): Promise<{ rows: PendingDraft[]; ghosts: DraftGhost[] }>;
  claim(localId: string): Promise<boolean>;
  failed(localId: string, status: 'waiting' | 'uncertain' | 'refused', error?: DraftError, neverSent?: boolean): Promise<void>;
  created(result: {
    localId: string;
    seq: number;
    jmap: string;
    messageId: string;
    serverId: string;
    email: EmailObject | null;
    server: Record<string, EmailObject | null>;
  }): Promise<{ conflicts: string[] }>;
  ghostsLooked(jmap: string, messageIds: string[], found: string[]): Promise<void>;
}

export interface DraftFlushIo {
  store: DraftFlushStore;
  request(calls: MethodCall[], using: string[]): Promise<JmapResponse>;
  /** Puts a held file on the server. Null when it's no longer on this device. */
  upload(jmap: string, blobId: string): Promise<string | null>;
  /** The server refused for good: no use retrying. Anything else counts as an outage. */
  isRefusal(error: unknown): boolean;
  onRefused(subject: string, error: DraftError): void;
  onConflict(subject: string): void;
  /** One more draft is on the server. */
  onSent(): void;
}

const PAGE = 500;
const MAX_PAGES = 5;
/** Set errors that mean "not now" rather than "no". */
const RETRY_LATER = new Set(['serverUnavailable', 'serverFail', 'serverPartialFail', 'rateLimit']);

function bare(id: string): string {
  return id.trim().replace(/^<|>$/g, '');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOutage(error: unknown, io: DraftFlushIo): boolean {
  if (error instanceof JmapMethodError) return RETRY_LATER.has(error.type);
  return !io.isRefusal(error);
}

/** Copies in Drafts by Message-ID, for the ones asked about. More than the pages hold can only cost a spare copy. */
async function copiesInDrafts(io: DraftFlushIo, jmap: string, since: number): Promise<Map<string, string>> {
  const boxes = await io.request([['Mailbox/get', { accountId: jmap, properties: ['id', 'role'] }, 'm']], MAIL_USING);
  const drafts = (responseFor(boxes, 'm')[1].list as Array<{ id: string; role?: string | null }>).find((box) => box.role === 'drafts');
  const found = new Map<string, string>();
  if (!drafts) return found;
  const filter = { operator: 'AND', conditions: [{ inMailbox: drafts.id }, { after: new Date(since - CLOCK_SKEW_MARGIN_MS).toISOString() }] };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await io.request([
      ['Email/query', { accountId: jmap, filter, sort: [{ property: 'receivedAt', isAscending: false }], position: page * PAGE, limit: PAGE }, 'q'],
      ['Email/get', { accountId: jmap, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'messageId'] }, 'g'],
    ], MAIL_USING);
    const ids = responseFor(response, 'q')[1].ids as string[];
    for (const email of responseFor(response, 'g')[1].list as Array<{ id: string; messageId?: string[] | null }>) {
      for (const messageId of email.messageId ?? []) found.set(bare(messageId), email.id);
    }
    if (ids.length < PAGE) break;
  }
  return found;
}

async function readReplaced(io: DraftFlushIo, row: PendingDraft): Promise<Record<string, EmailObject | null>> {
  const out: Record<string, EmailObject | null> = {};
  const byAccount = new Map<string, string[]>();
  for (const target of row.replaces) byAccount.set(target.jmap, [...(byAccount.get(target.jmap) ?? []), target.id]);
  for (const [jmap, ids] of byAccount) {
    const response = await io.request([['Email/get', { accountId: jmap, ids, properties: EMAIL_LIST_PROPERTIES }, 'r']], MAIL_USING);
    const list = responseFor(response, 'r')[1].list as EmailObject[];
    for (const id of ids) out[id] = list.find((email) => email.id === id) ?? null;
  }
  return out;
}

/** Reading the new message back can't fail the flush: it's on the server. */
async function readCreated(io: DraftFlushIo, jmap: string, id: string): Promise<EmailObject | null> {
  try {
    const response = await io.request([['Email/get', {
      accountId: jmap,
      ids: [id],
      properties: [...EMAIL_LIST_PROPERTIES, ...EMAIL_BODY_PROPERTIES],
      fetchAllBodyValues: true,
      maxBodyValueBytes: 1_000_000,
    }, 'n']], MAIL_USING);
    return (responseFor(response, 'n')[1].list as EmailObject[])[0] ?? null;
  } catch {
    return null;
  }
}

type RowOutcome = 'next' | 'stop';

async function flushRow(io: DraftFlushIo, row: PendingDraft, copies: Map<string, string> | null): Promise<RowOutcome> {
  if (!(await io.store.claim(row.localId))) return 'next';
  // Each step knows what a failure means: before the create nothing has left.
  let serverId = copies?.get(bare(row.messageId));
  let server: Record<string, EmailObject | null>;
  const stay = async (status: 'waiting' | 'uncertain') => {
    await io.store.failed(row.localId, status, undefined, status === 'waiting' && row.firstAttemptAt === null);
    return 'stop' as const;
  };
  const refuse = async (error: DraftError) => {
    await io.store.failed(row.localId, 'refused', error);
    io.onRefused(row.subject, error);
    return 'next' as const;
  };
  try {
    server = await readReplaced(io, row);
  } catch (error) {
    if (isOutage(error, io)) return stay(row.firstAttemptAt === null ? 'waiting' : 'uncertain');
    return refuse({ text: errorText(error) });
  }
  if (!serverId) {
    const uploaded = new Map<string, string>();
    try {
      for (const blobId of new Set(heldBlobsOf(row.create))) {
        const real = await io.upload(row.jmap, blobId);
        if (real === null) return refuse({ code: 'file_missing' });
        uploaded.set(blobId, real);
      }
    } catch (error) {
      if (isOutage(error, io)) return stay(row.firstAttemptAt === null ? 'waiting' : 'uncertain');
      return refuse({ text: errorText(error) });
    }
    const creationId = 'draft';
    let result: Record<string, Record<string, { id?: string; type?: string; description?: string }>>;
    try {
      const response = await io.request([['Email/set', {
        accountId: row.jmap,
        create: { [creationId]: withUploadedBlobs(row.create, uploaded) },
      }, 'c']], MAIL_USING);
      [, result] = responseFor(response, 'c');
    } catch (error) {
      // It went out: from here on it may have arrived.
      if (isOutage(error, io)) return stay('uncertain');
      return refuse({ text: errorText(error) });
    }
    const refusal = result.notCreated?.[creationId];
    if (refusal) {
      if (RETRY_LATER.has(refusal.type ?? '')) return stay('uncertain');
      return refuse({ type: refusal.type, text: refusal.description ?? refusal.type });
    }
    serverId = result.created?.[creationId]?.id;
    if (!serverId) return stay('uncertain');
  }
  const email = await readCreated(io, row.jmap, serverId);
  const { conflicts } = await io.store.created({ localId: row.localId, seq: row.seq, jmap: row.jmap, messageId: row.messageId, serverId, email, server });
  for (const subject of conflicts) io.onConflict(subject);
  io.onSent();
  return 'next';
}

/** True when all went through to an answer, false when the run stopped on an outage. */
export async function flushDrafts(io: DraftFlushIo): Promise<boolean> {
  const { rows, ghosts } = await io.store.read();
  if (rows.length === 0 && ghosts.length === 0) return true;
  const accounts = new Set([...rows.map((row) => row.jmap), ...ghosts.map((entry) => entry.jmap)]);
  for (const jmap of accounts) {
    const ours = rows.filter((row) => row.jmap === jmap);
    const theirGhosts = ghosts.filter((entry) => entry.jmap === jmap);
    const attempts = [...ours.filter((row) => row.firstAttemptAt !== null).map((row) => row.firstAttemptAt as number), ...theirGhosts.map((entry) => entry.at)];
    let copies: Map<string, string> | null = null;
    if (attempts.length > 0) {
      try {
        copies = await copiesInDrafts(io, jmap, Math.min(...attempts));
      } catch {
        // Can't look: nothing may go that might go twice.
        return false;
      }
      const looked = theirGhosts.map((entry) => entry.messageId);
      const found = looked.flatMap((messageId) => copies?.get(bare(messageId)) ?? []);
      if (looked.length > 0) await io.store.ghostsLooked(jmap, looked, found);
    }
    for (const row of ours) {
      if ((await flushRow(io, row, copies)) === 'stop') return false;
    }
  }
  return true;
}
