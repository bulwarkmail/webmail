/** What the page's flush asks the store. Each call is one transaction, so two tabs can't interleave. */

import type { AreaCall, StoreContext } from '../area';
import { upsertEmail, type EmailObject } from '../mail/records';
import { savePatch, EMAIL_TYPE } from '../outbox/email-set';
import type { ConflictSummary } from '../outbox/items';
import { applyPatch, destroyConflicts, type RecordState } from '../outbox/patches';
import type { DraftCreate } from './local-email';
import { destroyForDraft, listedDrafts, pendingForFlush, replaceLocalRow, replacesOf, resolveStandIns, type DraftError, type DraftRow, type DraftStatus } from './pending';

export interface PendingDraft {
  localId: string;
  jmap: string;
  seq: number;
  subject: string;
  create: DraftCreate;
  messageId: string;
  replaces: ReturnType<typeof replacesOf>;
  status: DraftStatus;
  firstAttemptAt: number | null;
}

export interface DraftGhost {
  jmap: string;
  messageId: string;
  at: number;
}

/** What the outbox view shows of a draft that's only on this device. */
export interface LocalDraftSummary {
  localId: string;
  jmap: string;
  subject: string;
  status: DraftStatus;
  error?: DraftError;
  createdAt: number;
}

/** A stand-in the page may still hold is resolved this long after it reached the server. */
const MAP_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

function toPending(row: DraftRow): PendingDraft {
  return {
    localId: row.local_id,
    jmap: row.jmap,
    seq: Number(row.seq),
    subject: row.subject ?? '',
    create: JSON.parse(row.create_json) as DraftCreate,
    messageId: row.message_id,
    replaces: replacesOf(row),
    status: row.status,
    firstAttemptAt: row.first_attempt_at === null ? null : Number(row.first_attempt_at),
  };
}

function read(ctx: StoreContext, params: { before: number }): { rows: PendingDraft[]; ghosts: DraftGhost[] } {
  return ctx.db.transaction(() => {
    // What a closed tab left on the way may have arrived.
    ctx.db.run("UPDATE draft_pending SET status = 'uncertain', sending_since = NULL WHERE status = 'sending' AND COALESCE(sending_since, 0) < ?", [params.before]);
    ctx.db.run('DELETE FROM draft_id_map WHERE at < ?', [ctx.now() - MAP_KEPT_MS]);
    return {
      rows: pendingForFlush(ctx.db).map(toPending),
      ghosts: ctx.db.all<{ jmap: string; message_id: string; at: number }>('SELECT jmap, message_id, at FROM draft_ghost').map((row) => ({ jmap: row.jmap, messageId: row.message_id, at: Number(row.at) })),
    };
  });
}

function list(ctx: StoreContext): LocalDraftSummary[] {
  return listedDrafts(ctx.db).map((row) => ({
    localId: row.local_id,
    jmap: row.jmap,
    subject: row.subject ?? '',
    status: row.status,
    createdAt: Number(row.created_at),
    ...(row.error ? { error: JSON.parse(row.error) as DraftError } : {}),
  }));
}

/** False when it isn't there any more, or it's no longer waiting: replaced, discarded, another tab took it. */
function claim(ctx: StoreContext, params: { localId: string }): boolean {
  const now = ctx.now();
  return ctx.db.run(
    `UPDATE draft_pending SET status = 'sending', sending_since = ?, first_attempt_at = COALESCE(first_attempt_at, ?)
     WHERE local_id = ? AND status IN ('waiting', 'uncertain')`,
    [now, now, params.localId],
  ).changes === 1;
}

/** Nothing arrived (waiting), it may have (uncertain), or the server said no (refused). */
function failed(ctx: StoreContext, params: { localId: string; status: 'waiting' | 'uncertain' | 'refused'; error?: DraftError; neverSent?: boolean }): void {
  ctx.db.run(
    `UPDATE draft_pending SET status = ?, error = ?, sending_since = NULL,
       first_attempt_at = CASE WHEN ? THEN NULL ELSE first_attempt_at END
     WHERE local_id = ?`,
    [params.status, params.error ? JSON.stringify(params.error) : null, params.neverSent ? 1 : 0, params.localId],
  );
}

/** Try a refused draft again, once there may be room for it. */
function retry(ctx: StoreContext, params: { localId: string }): void {
  ctx.db.run("UPDATE draft_pending SET status = 'waiting', error = NULL WHERE local_id = ? AND status = 'refused'", [params.localId]);
}

interface CreatedParams {
  localId: string;
  /** The row's place when it was taken: a later one means it was flagged or moved on the way. */
  seq: number;
  jmap: string;
  messageId: string;
  serverId: string;
  /** The new message as the server has it. Null when reading it back failed. */
  email: EmailObject | null;
  /** What the server has of the versions this replaces, with null for one it no longer has. */
  server: Record<string, EmailObject | null>;
}

function addConflict(ctx: StoreContext, jmap: string, recordId: string, summary: ConflictSummary): void {
  ctx.db.run(
    'INSERT INTO conflict (jmap, type, record_id, summary, local, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [jmap, EMAIL_TYPE, recordId, JSON.stringify(summary), JSON.stringify({ op: 'draft' }), ctx.now()],
  );
}

/**
 * The new version is on the server. Only now do the versions it replaces start
 * to go, by the usual queue: a failure there leaves an old copy, never no copy.
 * One changed elsewhere stays, with the user told: both are kept.
 */
function created(ctx: StoreContext, params: CreatedParams): { conflicts: string[] } {
  const conflicts: string[] = [];
  ctx.db.transaction(() => {
    const now = ctx.now();
    ctx.db.run('DELETE FROM draft_ghost WHERE jmap = ? AND message_id = ?', [params.jmap, params.messageId]);
    const row = ctx.db.get<DraftRow>('SELECT * FROM draft_pending WHERE local_id = ?', [params.localId]);
    if (!row) {
      // Replaced or discarded while it was on its way: this copy has no place.
      savePatch(ctx.db, { jmap: params.jmap, record_id: params.serverId, op: 'destroy', patch: '{}', base: null, server: null, subject: null }, now);
      return;
    }
    ctx.db.run('INSERT OR REPLACE INTO draft_id_map (local_id, jmap, server_id, at) VALUES (?, ?, ?, ?)', [row.local_id, row.jmap, params.serverId, now]);
    replaceLocalRow(ctx.db, row, params.serverId, params.email);
    if (Number(row.seq) !== params.seq) {
      const after = JSON.parse(row.create_json) as RecordState;
      const patch = JSON.stringify({ keywords: after.keywords, mailboxIds: after.mailboxIds });
      savePatch(ctx.db, { jmap: row.jmap, record_id: params.serverId, op: 'update', patch, base: null, server: null, subject: row.subject }, now);
      const kept = ctx.db.get<{ json: string; gen: number }>('SELECT json, gen FROM email WHERE jmap = ? AND id = ?', [row.jmap, params.serverId]);
      if (kept) upsertEmail(ctx.db, row.jmap, applyPatch(JSON.parse(kept.json) as EmailObject, JSON.parse(patch)), Number(kept.gen));
    }
    ctx.db.run('DELETE FROM draft_pending WHERE local_id = ?', [row.local_id]);
    for (const target of replacesOf(row)) {
      const server = params.server[target.id];
      const state = target.base ? JSON.stringify(target.base) : null;
      // Not read on this run (added on the way): the queue checks it again anyway.
      if (server === undefined || (server && !destroyConflicts(target.base, server))) {
        savePatch(ctx.db, { jmap: target.jmap, record_id: target.id, op: 'destroy', patch: '{}', base: state, server: state, subject: target.subject }, now);
        continue;
      }
      if (server) {
        const gen = Number(ctx.db.get<{ gen: number | null }>('SELECT MAX(gen) AS gen FROM email WHERE jmap = ?', [target.jmap])?.gen ?? 0);
        upsertEmail(ctx.db, target.jmap, server, gen);
      }
      const subject = (typeof server?.subject === 'string' ? server.subject : target.subject) ?? row.subject ?? '';
      addConflict(ctx, row.jmap, params.serverId, { subject, op: 'draft', reason: server ? 'changed' : 'gone' });
      conflicts.push(subject);
    }
  });
  ctx.emit({ type: 'changed', account: ctx.account, collections: ['Email', 'Mailbox', 'Thread'] });
  return { conflicts };
}

/** The ghosts looked up: copies found go through the usual queue. */
function ghostsLooked(ctx: StoreContext, params: { jmap: string; messageIds: string[]; found: string[] }): void {
  ctx.db.transaction(() => {
    for (const messageId of params.messageIds) ctx.db.run('DELETE FROM draft_ghost WHERE jmap = ? AND message_id = ?', [params.jmap, messageId]);
    for (const id of params.found) savePatch(ctx.db, { jmap: params.jmap, record_id: id, op: 'destroy', patch: '{}', base: null, server: null, subject: null }, ctx.now());
  });
}

/** A send took care of this draft without the page holding a client's word for it. */
function discard(ctx: StoreContext, params: { jmap: string; id: string }): void {
  ctx.db.transaction(() => {
    destroyForDraft(ctx, params.jmap, params.id, undefined);
  });
  ctx.emit({ type: 'changed', account: ctx.account, collections: ['Email', 'Mailbox', 'Thread'] });
}

export const DRAFT_CALLS: Readonly<Record<string, AreaCall>> = {
  'drafts.read': read,
  'drafts.list': list,
  'drafts.claim': claim,
  'drafts.failed': failed,
  'drafts.retry': retry,
  'drafts.created': created,
  'drafts.ghostsLooked': ghostsLooked,
  'drafts.discard': discard,
  'drafts.resolveStandIns': (ctx, params: { ids: string[] }) => resolveStandIns(ctx.db, params.ids),
};
