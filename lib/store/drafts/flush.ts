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
 * Message-ID on either Stalwart (decision 4). A Message-ID alone says little:
 * another client can save again under it. So a copy only counts as a version
 * made here when it still looks like one. Anything else is left alone: a spare
 * copy on the server is always better than no copy.
 */

import { JmapMethodError, responseFor, type JmapResponse, type MethodCall } from '../engine/transport';
import { EMAIL_BODY_PROPERTIES, EMAIL_LIST_PROPERTIES, MAIL_USING, type EmailObject } from '../mail/records';
import { CLOCK_SKEW_MARGIN_MS } from '../outbox/dedupe';
import { isLocalBlobId } from '../outbox/items';
import type { RecordState } from '../outbox/patches';
import type { DraftGhost, PendingDraft } from './calls';
import { blobPartsOf, heldBlobsOf, withUploadedBlobs, type CreatePart } from './local-email';
import type { DraftError, DraftVersion } from './pending';

export interface FoundCopy {
  id: string;
  base: RecordState;
}

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
    ghostCopies: FoundCopy[];
  }): Promise<{ conflicts: string[] }>;
  ghostsLooked(jmap: string, messageIds: string[], found: FoundCopy[]): Promise<void>;
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
/** How far a copy's receivedAt may be from the attempts, in either direction, for clocks that differ. */
const CLOSE_TO_ATTEMPT_MS = 15 * 60 * 1000;
/** A server's size counts headers and encoding, which only add to what the store counted: base64 about a third. */
const SIZE_SLACK_BYTES = 64 * 1024;

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

interface CopyFound {
  id: string;
  messageId?: string[] | null;
  mailboxIds?: Record<string, boolean>;
  keywords?: Record<string, boolean>;
  receivedAt?: string;
  subject?: string | null;
  size?: number;
}

interface Copies {
  drafts: string | null;
  byMessageId: Map<string, CopyFound[]>;
}

const NO_COPIES: Copies = { drafts: null, byMessageId: new Map() };

/** Copies in Drafts by Message-ID. More than the pages hold can only cost a spare copy. */
async function copiesInDrafts(io: DraftFlushIo, jmap: string, since: number): Promise<Copies> {
  const boxes = await io.request([['Mailbox/get', { accountId: jmap, properties: ['id', 'role'] }, 'm']], MAIL_USING);
  const drafts = (responseFor(boxes, 'm')[1].list as Array<{ id: string; role?: string | null }>).find((box) => box.role === 'drafts');
  if (!drafts) return NO_COPIES;
  const byMessageId = new Map<string, CopyFound[]>();
  const filter = { operator: 'AND', conditions: [{ inMailbox: drafts.id }, { after: new Date(since - CLOCK_SKEW_MARGIN_MS).toISOString() }] };
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await io.request([
      ['Email/query', { accountId: jmap, filter, sort: [{ property: 'receivedAt', isAscending: false }], position: page * PAGE, limit: PAGE }, 'q'],
      ['Email/get', {
        accountId: jmap,
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['id', 'messageId', 'mailboxIds', 'keywords', 'receivedAt', 'subject', 'size'],
      }, 'g'],
    ], MAIL_USING);
    const ids = responseFor(response, 'q')[1].ids as string[];
    for (const email of responseFor(response, 'g')[1].list as CopyFound[]) {
      for (const messageId of email.messageId ?? []) {
        const key = bare(messageId);
        byMessageId.set(key, [...(byMessageId.get(key) ?? []), email]);
      }
    }
    if (ids.length < PAGE) break;
  }
  return { drafts: drafts.id, byMessageId };
}

/** Whether a copy is that version, untouched: only in Drafts, still a draft, from the time it was sent, the same subject and size. */
function isThatVersion(copy: CopyFound, drafts: string | null, version: DraftVersion): boolean {
  const boxes = Object.keys(copy.mailboxIds ?? {}).filter((box) => copy.mailboxIds?.[box]);
  if (boxes.length !== 1 || boxes[0] !== drafts || !copy.keywords?.$draft) return false;
  const at = Date.parse(String(copy.receivedAt));
  if (!Number.isFinite(at) || at < version.from - CLOSE_TO_ATTEMPT_MS || at > version.to + CLOSE_TO_ATTEMPT_MS) return false;
  if ((copy.subject ?? '') !== version.subject) return false;
  const size = copy.size ?? 0;
  return size >= version.size * 0.9 && size <= version.size * 1.5 + SIZE_SLACK_BYTES;
}

function versionCopies(copies: Copies, version: DraftVersion): FoundCopy[] {
  return (copies.byMessageId.get(bare(version.messageId)) ?? [])
    .filter((copy) => isThatVersion(copy, copies.drafts, version))
    .map((copy) => ({ id: copy.id, base: { keywords: copy.keywords ?? {}, mailboxIds: copy.mailboxIds ?? {} } }));
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

function leaves(part: CreatePart): CreatePart[] {
  return part.subParts ? part.subParts.flatMap(leaves) : [part];
}

/**
 * The part ids a create names that have died: every new version of a message
 * gets new ones, and the old ones go with the old version. The same files are in
 * the versions this draft replaces, under the ids they have now.
 */
async function livingParts(io: DraftFlushIo, row: PendingDraft, named: CreatePart[]): Promise<Map<string, string>> {
  const fresh = new Map<string, string>();
  const ids = row.replaces.filter((target) => target.jmap === row.jmap).map((target) => target.id);
  if (ids.length === 0) return fresh;
  const response = await io.request([['Email/get', { accountId: row.jmap, ids, properties: ['id', 'attachments', 'textBody', 'htmlBody', 'bodyStructure'] }, 'p']], MAIL_USING);
  const found = (responseFor(response, 'p')[1].list as Array<{ attachments?: CreatePart[]; textBody?: CreatePart[]; htmlBody?: CreatePart[]; bodyStructure?: CreatePart }>)
    .flatMap((email) => [
      ...(email.attachments ?? []),
      // Inline parts Stalwart 1.0 doesn't list under attachments. The text itself isn't a file.
      ...[...(email.textBody ?? []), ...(email.htmlBody ?? []), ...(email.bodyStructure ? leaves(email.bodyStructure) : [])].filter((part) => !part.type?.startsWith('text/')),
    ])
    .filter((part) => part.blobId);
  const free = [...new Map(found.map((part) => [part.blobId, part])).values()];
  // What's still alive keeps its part, so a file of the same name can't take it.
  const dead = named.filter((part) => {
    const at = free.findIndex((candidate) => candidate.blobId === part.blobId);
    if (at < 0) return true;
    free.splice(at, 1);
    return false;
  });
  for (const part of dead) {
    const at = free.findIndex((candidate) => candidate.name === part.name && (candidate.type ?? '') === (part.type ?? ''));
    if (at < 0) continue;
    fresh.set(part.blobId as string, free[at].blobId as string);
    free.splice(at, 1);
  }
  return fresh;
}

type RowOutcome = 'next' | 'stop';

async function flushRow(io: DraftFlushIo, row: PendingDraft, copies: Copies): Promise<RowOutcome> {
  if (!(await io.store.claim(row.localId))) return 'next';
  // Each step knows what a failure means: before the create nothing has left.
  let serverId = versionCopies(copies, row.self)[0]?.id;
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
    const ids = new Map<string, string>();
    try {
      for (const blobId of new Set(heldBlobsOf(row.create))) {
        const real = await io.upload(row.jmap, blobId);
        if (real === null) return refuse({ code: 'file_missing' });
        ids.set(blobId, real);
      }
    } catch (error) {
      if (isOutage(error, io)) return stay(row.firstAttemptAt === null ? 'waiting' : 'uncertain');
      return refuse({ text: errorText(error) });
    }
    const creationId = 'draft';
    type SetResult = Record<string, Record<string, { id?: string; type?: string; description?: string }>>;
    const create = async (): Promise<SetResult> => {
      const response = await io.request([['Email/set', {
        accountId: row.jmap,
        create: { [creationId]: withUploadedBlobs(row.create, ids) },
      }, 'c']], MAIL_USING);
      return responseFor(response, 'c')[1] as SetResult;
    };
    let result: SetResult;
    try {
      result = await create();
      if (result.notCreated?.[creationId]?.type === 'blobNotFound') {
        const named = blobPartsOf(row.create).filter((part) => !isLocalBlobId(part.blobId));
        const fresh = await livingParts(io, row, named);
        if (fresh.size > 0) {
          for (const [dead, alive] of fresh) ids.set(dead, alive);
          result = await create();
        }
      }
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
    serverId = result.created?.[creationId]?.id as string;
    if (!serverId) return stay('uncertain');
  }
  const email = await readCreated(io, row.jmap, serverId);
  const ghostCopies = row.ghosts.flatMap((ghost) => versionCopies(copies, ghost)).filter((copy) => copy.id !== serverId);
  const { conflicts } = await io.store.created({ localId: row.localId, seq: row.seq, jmap: row.jmap, messageId: row.messageId, serverId, email, server, ghostCopies });
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
    const attempts = [
      ...ours.filter((row) => row.firstAttemptAt !== null).map((row) => row.firstAttemptAt as number),
      ...ours.flatMap((row) => row.ghosts.map((ghost) => ghost.from)),
      ...theirGhosts.map((entry) => entry.from),
    ];
    let copies = NO_COPIES;
    if (attempts.length > 0) {
      try {
        copies = await copiesInDrafts(io, jmap, Math.min(...attempts));
      } catch (error) {
        // Can't look now: nothing may go that might go twice. Refused for good:
        // there's nothing to wait for, and a spare copy is the worst that can come of it.
        if (isOutage(error, io)) return false;
      }
      if (theirGhosts.length > 0) {
        await io.store.ghostsLooked(jmap, theirGhosts.map((entry) => entry.messageId), theirGhosts.flatMap((entry) => versionCopies(copies, entry)));
      }
    }
    for (const row of ours) {
      if ((await flushRow(io, row, copies)) === 'stop') return false;
    }
  }
  return true;
}
