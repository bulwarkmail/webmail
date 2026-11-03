/** What the page's flush asks the store. Each call is one transaction, so two tabs can't interleave. */

import type { AreaCall, StoreContext } from '../area';
import { upsertEmail, type EmailObject } from '../mail/records';
import { savePatch, EMAIL_TYPE } from '../outbox/email-set';
import type { ConflictSummary } from '../outbox/items';
import { applyPatch, destroyConflicts, stateOf, type RecordState } from '../outbox/patches';
import type { DraftCreate } from './local-email';
import { destroyForDraft, ghostsOf, isPlainDraft, listedDrafts, pendingForFlush, replaceLocalRow, replacesOf, resolveStandIns, versionOf, type DraftError, type DraftRow, type DraftStatus, type DraftVersion } from './pending';

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
  /** What this version should look like on the server. */
  self: DraftVersion;
  /** Earlier versions that may have reached the server. */
  ghosts: DraftVersion[];
}

export interface DraftGhost extends DraftVersion {
  jmap: string;
}

export interface DraftElsewhere {
  id: number;
  login: string;
  jmap: string | null;
  recordId: string;
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
    self: versionOf(row),
    ghosts: ghostsOf(row),
  };
}

function read(ctx: StoreContext, params: { before: number }): { rows: PendingDraft[]; ghosts: DraftGhost[] } {
  return ctx.db.transaction(() => {
    // What a closed tab left on the way may have arrived.
    ctx.db.run("UPDATE draft_pending SET status = 'uncertain', sending_since = NULL WHERE status = 'sending' AND COALESCE(sending_since, 0) < ?", [params.before]);
    ctx.db.run('DELETE FROM draft_id_map WHERE at < ?', [ctx.now() - MAP_KEPT_MS]);
    return {
      rows: pendingForFlush(ctx.db).map(toPending),
      ghosts: ctx.db.all<{ jmap: string; message_id: string; first_at: number; last_at: number; subject: string; size: number }>('SELECT * FROM draft_ghost').map((row) => ({
        jmap: row.jmap,
        messageId: row.message_id,
        from: Number(row.first_at),
        to: Number(row.last_at),
        subject: row.subject,
        size: Number(row.size),
      })),
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
    `UPDATE draft_pending SET status = 'sending', sending_since = ?, first_attempt_at = COALESCE(first_attempt_at, ?), last_attempt_at = ?
     WHERE local_id = ? AND status IN ('waiting', 'uncertain')`,
    [now, now, now, params.localId],
  ).changes === 1;
}

/** Nothing arrived (waiting), it may have (uncertain), or the server said no (refused). */
function failed(ctx: StoreContext, params: { localId: string; status: 'waiting' | 'uncertain' | 'refused'; error?: DraftError; neverSent?: boolean }): void {
  ctx.db.run(
    `UPDATE draft_pending SET status = ?, error = ?, sending_since = NULL,
       first_attempt_at = CASE WHEN ? THEN NULL ELSE first_attempt_at END,
       last_attempt_at = CASE WHEN ? THEN NULL ELSE last_attempt_at END
     WHERE local_id = ?`,
    [params.status, params.error ? JSON.stringify(params.error) : null, params.neverSent ? 1 : 0, params.neverSent ? 1 : 0, params.localId],
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
  /** Copies of earlier versions of this draft that still look untouched. */
  ghostCopies: Array<{ id: string; base: RecordState }>;
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
    const row = ctx.db.get<DraftRow>('SELECT * FROM draft_pending WHERE local_id = ?', [params.localId]);
    // Replaced or discarded while it was on its way: it left a ghost, and the
    // next flush looks at this copy as it does at any other.
    if (!row) return;
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
    ctx.db.run('UPDATE draft_elsewhere SET local_id = NULL WHERE local_id = ?', [row.local_id]);
    for (const copy of params.ghostCopies) {
      const state = JSON.stringify(copy.base);
      savePatch(ctx.db, { jmap: row.jmap, record_id: copy.id, op: 'destroy', patch: '{}', base: state, server: state, subject: row.subject }, now);
    }
    for (const target of replacesOf(row)) {
      const server = params.server[target.id];
      // Not read on this run (added on the way). With what it looked like known,
      // the queue checks it again. Without that, it stays: a spare copy.
      if (server === undefined && !target.base) continue;
      // A message this device didn't keep: what the server says now is all there is to go by.
      const unchanged = server === undefined || (server !== null && (target.base ? !destroyConflicts(target.base, server) : isPlainDraft(ctx.db, target.jmap, server)));
      if (unchanged) {
        const state = JSON.stringify(target.base ?? stateOf(server as EmailObject));
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

/** The ghosts of a discarded draft looked up: copies that still look untouched go through the usual queue. */
function ghostsLooked(ctx: StoreContext, params: { jmap: string; messageIds: string[]; found: Array<{ id: string; base: RecordState }> }): void {
  ctx.db.transaction(() => {
    for (const messageId of params.messageIds) ctx.db.run('DELETE FROM draft_ghost WHERE jmap = ? AND message_id = ?', [params.jmap, messageId]);
    for (const copy of params.found) {
      const state = JSON.stringify(copy.base);
      savePatch(ctx.db, { jmap: params.jmap, record_id: copy.id, op: 'destroy', patch: '{}', base: state, server: state, subject: null }, ctx.now());
    }
  });
}

/** An old version in another login, to be removed through it once the new one here is up. */
function noteElsewhere(ctx: StoreContext, params: { localId: string; login: string; jmap?: string; id: string }): void {
  const waiting = ctx.db.get('SELECT 1 AS x FROM draft_pending WHERE local_id = ?', [params.localId]);
  ctx.db.run('INSERT INTO draft_elsewhere (local_id, login, jmap, record_id) VALUES (?, ?, ?, ?)', [waiting ? params.localId : null, params.login, params.jmap ?? null, params.id]);
}

function elsewhereReady(ctx: StoreContext): DraftElsewhere[] {
  return ctx.db.all<{ id: number; login: string; jmap: string | null; record_id: string }>('SELECT id, login, jmap, record_id FROM draft_elsewhere WHERE local_id IS NULL')
    .map((row) => ({ id: Number(row.id), login: row.login, jmap: row.jmap, recordId: row.record_id }));
}

function elsewhereDone(ctx: StoreContext, params: { id: number }): void {
  ctx.db.run('DELETE FROM draft_elsewhere WHERE id = ?', [params.id]);
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
  'drafts.noteElsewhere': noteElsewhere,
  'drafts.elsewhereReady': elsewhereReady,
  'drafts.elsewhereDone': elsewhereDone,
  'drafts.discard': discard,
  'drafts.resolveStandIns': (ctx, params: { ids: string[] }) => resolveStandIns(ctx.db, params.ids),
};
