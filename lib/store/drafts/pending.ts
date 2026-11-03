/**
 * Drafts saved on this device. createDraft on the client saves by creating a new
 * version and then destroying the one before, and that's how it reaches this
 * file: a create hands out a stand-in id, and the destroy that follows names the
 * new version in `replacedBy`. Each draft therefore has one pending row however
 * often it's saved. A version on the server stays there, hidden here, until the
 * new one has arrived (flush.ts).
 *
 * A version that may already have reached the server (its Message-ID was handed
 * over, and the answer got lost) leaves a ghost behind when it's replaced.
 */

import { isStandInId, newStandInId } from '@/lib/jmap/stand-in-ids';
import type { MethodContext, RecordOverlay, StoreContext } from '../area';
import { listObjects } from '../engine/core-schema';
import { deleteEmail, storeBody, upsertEmail, type EmailObject } from '../mail/records';
import { localEmail, nextSeq, pendingRow, queueDestroy, queueUpdate, savePatch, EMAIL_TYPE } from '../outbox/email-set';
import { applyPatch, normalizePatch, patchProblem, stateOf, type Patch, type RecordState } from '../outbox/patches';
import type { StorageAdapter } from '../storage';
import { localEmailFrom, type DraftCreate } from './local-email';

export interface ReplacedDraft {
  jmap: string;
  id: string;
  base: RecordState | null;
  subject: string | null;
}

/** What a version sent to the server should look like there, to tell it from anything else under its Message-ID. */
export interface DraftVersion {
  messageId: string;
  /** Its first and last attempt. */
  from: number;
  to: number;
  subject: string;
  size: number;
}

export interface DraftRow {
  local_id: string;
  jmap: string;
  seq: number;
  subject: string | null;
  create_json: string;
  message_id: string;
  replaces: string;
  status: DraftStatus;
  sending_since: number | null;
  first_attempt_at: number | null;
  last_attempt_at: number | null;
  size: number;
  ghosts: string;
  error: string | null;
  created_at: number;
}

/**
 * - waiting: goes up by itself when the server answers;
 * - sending: on its way (a tab took it);
 * - uncertain: the connection broke after it may have arrived. Looked up first;
 * - refused: the server said no. Stays here until it's edited or tried again.
 */
export type DraftStatus = 'waiting' | 'sending' | 'uncertain' | 'refused';

export interface DraftError {
  code?: 'file_missing';
  type?: string;
  text?: string;
}

interface SetError { type: string; description?: string }

const notADraft = (): SetError => ({ type: 'serverUnavailable', description: 'This needs the server' });

function rowOf(db: StorageAdapter, localId: string): DraftRow | undefined {
  return db.get<DraftRow>('SELECT * FROM draft_pending WHERE local_id = ?', [localId]);
}

export function replacesOf(row: Pick<DraftRow, 'replaces'>): ReplacedDraft[] {
  return JSON.parse(row.replaces) as ReplacedDraft[];
}

/** A message of the Drafts folder with the draft keyword, in a request that doesn't also send it. */
function isDraftCreate(ctx: MethodContext, jmap: string, create: DraftCreate): boolean {
  if (ctx.calls.some(([name]) => name === 'EmailSubmission/set')) return false;
  if (!(create.keywords as Record<string, boolean> | undefined)?.$draft) return false;
  const boxes = Object.keys((create.mailboxIds ?? {}) as object);
  if (boxes.length === 0) return false;
  const drafts = listObjects<{ id: string; role?: string | null }>(ctx.db, jmap, 'Mailbox').filter((box) => box.role === 'drafts').map((box) => box.id);
  return boxes.every((box) => drafts.includes(box));
}

export function ghostsOf(row: Pick<DraftRow, 'ghosts'>): DraftVersion[] {
  return JSON.parse(row.ghosts) as DraftVersion[];
}

/** This version as a later one sees it, if it may have reached the server. */
export function versionOf(row: DraftRow): DraftVersion {
  const from = Number(row.first_attempt_at ?? 0);
  return { messageId: row.message_id, from, to: Number(row.last_attempt_at ?? from), subject: row.subject ?? '', size: Number(row.size) };
}

/** Attempts in a long outage are few, but nothing should grow without end. */
const MOST_GHOSTS = 50;

function currentGen(db: StorageAdapter, jmap: string): number {
  return Number(db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM email WHERE jmap = ?', [jmap])?.gen ?? 0);
}

/** Writes the row lists and search read. A held file isn't something sync could fetch, and there's no raw message yet. */
function writeLocalRow(db: StorageAdapter, jmap: string, id: string, create: DraftCreate, messageId: string, now: number): { size: number } {
  const { list, body } = localEmailFrom(db, jmap, id, create, messageId, now);
  const rowid = upsertEmail(db, jmap, list, currentGen(db, jmap));
  storeBody(db, rowid, JSON.stringify(list), body);
  db.run("DELETE FROM email_part WHERE email_rowid = ? AND (raw = 1 OR blob_id LIKE 'bulwark-local-%')", [rowid]);
  return { size: Number(list.size) };
}

export function createLocalDraft(ctx: MethodContext, jmap: string, create: DraftCreate, networkTried: boolean): Record<string, unknown> | SetError & { refused: true } {
  if (!isDraftCreate(ctx, jmap, create)) return { ...notADraft(), refused: true };
  const id = newStandInId();
  const now = ctx.now();
  const messageId = (create.messageId as string[] | undefined)?.[0] ?? `${id}@bulwark.invalid`;
  const stored: DraftCreate = { ...create, messageId: [messageId] };
  const { size } = writeLocalRow(ctx.db, jmap, id, stored, messageId, now);
  ctx.db.run(
    `INSERT INTO draft_pending (local_id, jmap, seq, subject, create_json, message_id, replaces, status, first_attempt_at, last_attempt_at, size, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
    [id, jmap, nextSeq(ctx.db), typeof create.subject === 'string' ? create.subject : '', JSON.stringify(stored), messageId, networkTried ? 'uncertain' : 'waiting', networkTried ? now : null, networkTried ? now : null, size, now],
  );
  return { id, blobId: id, threadId: id, size };
}

/** A flag or a move on a draft that only exists here: it goes into the create. */
export function updateLocalDraft(ctx: Pick<StoreContext, 'db' | 'now'>, jmap: string, id: string, rawPatch: Patch): SetError | null {
  const row = rowOf(ctx.db, id);
  if (!row) {
    const real = mappedId(ctx.db, id);
    return real ? queueUpdate(ctx.db, jmap, real, rawPatch, ctx.now()) : { type: 'notFound' };
  }
  const problem = patchProblem(rawPatch);
  if (problem) return problem;
  const local = localEmail(ctx.db, row.jmap, id);
  const create = JSON.parse(row.create_json) as DraftCreate;
  const after = applyPatch(create, normalizePatch(rawPatch));
  if (Object.keys(after.mailboxIds ?? {}).length === 0) return { type: 'invalidProperties', description: 'A message has to stay in a folder' };
  ctx.db.run('UPDATE draft_pending SET create_json = ?, seq = ? WHERE local_id = ?', [JSON.stringify(after), nextSeq(ctx.db), id]);
  if (local) upsertEmail(ctx.db, row.jmap, { ...local.email, keywords: after.keywords, mailboxIds: after.mailboxIds }, local.gen);
  return null;
}

/** What `id` is now on the server, for a stand-in that made it there. */
function mappedId(db: StorageAdapter, id: string): string | null {
  return db.get<{ server_id: string }>('SELECT server_id FROM draft_id_map WHERE local_id = ?', [id])?.server_id ?? null;
}

export function resolveStandIns(db: StorageAdapter, ids: readonly string[]): Record<string, string | null> {
  return Object.fromEntries(ids.map((id) => [id, mappedId(db, id)]));
}

function queueRemoval(db: StorageAdapter, target: ReplacedDraft, now: number): void {
  const state = target.base ? JSON.stringify(target.base) : null;
  savePatch(db, { jmap: target.jmap, record_id: target.id, op: 'destroy', patch: '{}', base: state, server: state, subject: target.subject }, now);
}

/**
 * Takes a pending row away: `into` carries on what it replaced, else the user
 * discarded or sent the draft and what it replaced goes too.
 */
function dropPending(ctx: Pick<StoreContext, 'db' | 'now'>, row: DraftRow, into: DraftRow | null): void {
  const { db } = ctx;
  const replaced = replacesOf(row);
  const ghosts = [...ghostsOf(row), ...(row.first_attempt_at !== null ? [versionOf(row)] : [])];
  if (into) {
    // Only once the new version is up: until then these may be the only copy on the server.
    db.run('UPDATE draft_pending SET replaces = ?, ghosts = ? WHERE local_id = ?', [
      JSON.stringify([...replacesOf(into), ...replaced]),
      JSON.stringify([...ghostsOf(into), ...ghosts].slice(-MOST_GHOSTS)),
      into.local_id,
    ]);
    db.run('UPDATE draft_elsewhere SET local_id = ? WHERE local_id = ?', [into.local_id, row.local_id]);
  } else {
    for (const target of replaced) queueRemoval(db, target, ctx.now());
    for (const version of ghosts) {
      db.run(
        'INSERT OR REPLACE INTO draft_ghost (jmap, message_id, first_at, last_at, subject, size) VALUES (?, ?, ?, ?, ?, ?)',
        [row.jmap, version.messageId, version.from, version.to, version.subject, version.size],
      );
    }
    db.run('UPDATE draft_elsewhere SET local_id = NULL WHERE local_id = ?', [row.local_id]);
  }
  db.run('DELETE FROM draft_pending WHERE local_id = ?', [row.local_id]);
  deleteEmail(db, row.jmap, row.local_id);
}

/**
 * Email/set destroy of a stand-in, or of any message when a new version on the
 * device replaces it. False when it's an ordinary delete for the outbox to queue.
 */
export function destroyForDraft(ctx: Pick<StoreContext, 'db' | 'now'>, jmap: string, id: string, replacedBy: string | undefined): boolean {
  const { db } = ctx;
  const into = replacedBy ? rowOf(db, replacedBy) ?? null : null;
  if (isStandInId(id)) {
    const row = rowOf(db, id);
    if (row) {
      dropPending(ctx, row, into);
      return true;
    }
    const real = mappedId(db, id);
    if (!real) return true; // Gone already: that's the same result.
    if (into) return destroyForDraft(ctx, jmap, real, replacedBy);
    queueDestroy(db, jmap, real, ctx.now());
    return true;
  }
  if (!into) return false;
  // The version on the server stays there until the new one has arrived.
  const local = localEmail(db, jmap, id);
  const waiting = pendingRow(db, jmap, id);
  const base = local ? stateOf(local.email) : waiting?.base ? JSON.parse(waiting.base) as RecordState : null;
  const entry: ReplacedDraft = { jmap, id, base, subject: typeof local?.email.subject === 'string' ? local.email.subject : waiting?.subject ?? null };
  db.run('UPDATE draft_pending SET replaces = ? WHERE local_id = ?', [JSON.stringify([...replacesOf(into), entry]), into.local_id]);
  db.run('DELETE FROM outbox_patch WHERE jmap = ? AND type = ? AND record_id = ?', [jmap, EMAIL_TYPE, id]);
  deleteEmail(db, jmap, id);
  return true;
}

/** A plain draft: only in the Drafts folder, with the keyword. Anything else someone did something with. */
export function isPlainDraft(db: StorageAdapter, jmap: string, email: EmailObject): boolean {
  const boxes = Object.entries((email.mailboxIds ?? {}) as Record<string, boolean>).filter(([, on]) => on).map(([box]) => box);
  if (boxes.length !== 1 || !(email.keywords as Record<string, boolean> | undefined)?.$draft) return false;
  return listObjects<{ id: string; role?: string | null }>(db, jmap, 'Mailbox').some((box) => box.id === boxes[0] && box.role === 'drafts');
}

/** A send naming a draft that's still on the device: the send takes care of it. */
function draftsWithQueuedSend(db: StorageAdapter): Set<string> {
  const rows = db.all<{ payload: string }>("SELECT payload FROM outbox WHERE status IN ('waiting', 'sending', 'uncertain', 'held') AND kind = 'email'");
  const out = new Set<string>();
  for (const row of rows) {
    const draft = (JSON.parse(row.payload) as { item: { args: unknown[] } }).item.args[7];
    if (typeof draft === 'string' && isStandInId(draft)) out.add(draft);
  }
  return out;
}

export function allPending(db: StorageAdapter): DraftRow[] {
  return db.all<DraftRow>('SELECT * FROM draft_pending ORDER BY seq ASC');
}

/** The drafts that are only here and nothing else speaks for. One a send names is that message, in the outbox. */
export function listedDrafts(db: StorageAdapter): DraftRow[] {
  const held = draftsWithQueuedSend(db);
  return allPending(db).filter((row) => !held.has(row.local_id));
}

export function pendingForFlush(db: StorageAdapter): DraftRow[] {
  const held = draftsWithQueuedSend(db);
  return allPending(db).filter((row) => row.status !== 'refused' && !held.has(row.local_id));
}

/**
 * Sync must not bring back a version that a draft here replaces, and the folder
 * counts stay the server's with what waits here added when they're read.
 */
export const draftsOverlay: RecordOverlay = (ctx, jmap, type, records) => {
  if (type !== 'Email' && type !== 'Thread' && type !== 'Mailbox') return records;
  const rows = ctx.db.all<Pick<DraftRow, 'replaces'>>('SELECT replaces FROM draft_pending');
  if (rows.length === 0) return records;
  const replaced = rows.flatMap(replacesOf).filter((target) => target.jmap === jmap);
  if (type === 'Email') {
    const hidden = new Set(replaced.map((target) => target.id));
    return records.filter((record) => !hidden.has(record.id));
  }
  if (type === 'Thread') {
    const hidden = new Set(replaced.map((target) => target.id));
    return (records as Array<{ id: string; emailIds: string[] }>).map((thread) => ({ ...thread, emailIds: thread.emailIds.filter((id) => !hidden.has(id)) }));
  }
  const deltas = new Map<string, { total: number; unread: number }>();
  const bump = (box: string, total: number, unread: number) => {
    const delta = deltas.get(box) ?? { total: 0, unread: 0 };
    deltas.set(box, { total: delta.total + total, unread: delta.unread + unread });
  };
  for (const row of allPending(ctx.db)) {
    if (row.jmap !== jmap) continue;
    const create = JSON.parse(row.create_json) as RecordState;
    for (const box of Object.keys(create.mailboxIds ?? {})) bump(box, 1, create.keywords?.$seen ? 0 : 1);
  }
  for (const target of replaced) {
    for (const box of Object.keys(target.base?.mailboxIds ?? {})) bump(box, -1, target.base?.keywords?.$seen ? 0 : -1);
  }
  if (deltas.size === 0) return records;
  return (records as Array<{ id: string; totalEmails?: unknown; unreadEmails?: unknown }>).map((box) => {
    const delta = deltas.get(box.id);
    if (!delta) return box;
    const count = (value: unknown, by: number) => (typeof value === 'number' ? Math.max(0, value + by) : value);
    return { ...box, totalEmails: count(box.totalEmails, delta.total), unreadEmails: count(box.unreadEmails, delta.unread) };
  });
};

/** After a create went through: the real message takes the stand-in's place. */
export function replaceLocalRow(db: StorageAdapter, row: DraftRow, serverId: string, email: EmailObject | null): void {
  const local = localEmail(db, row.jmap, row.local_id);
  deleteEmail(db, row.jmap, row.local_id);
  const gen = currentGen(db, row.jmap);
  if (email) {
    const { bodyValues, textBody, htmlBody, attachments, bodyStructure, headers, bcc, replyTo, messageId, inReplyTo, references, sender, ...list } = email;
    const rowid = upsertEmail(db, row.jmap, list as EmailObject, gen);
    storeBody(db, rowid, JSON.stringify(list), { bodyValues, textBody, htmlBody, attachments, bodyStructure, headers, bcc, replyTo, messageId, inReplyTo, references, sender });
    return;
  }
  // It's there, but reading it back failed. Sync brings the text when it can.
  if (local) upsertEmail(db, row.jmap, { ...local.email, id: serverId, threadId: serverId, blobId: serverId }, gen);
}
