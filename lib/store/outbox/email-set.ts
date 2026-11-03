/**
 * Email/set answered from the store: changes wait in outbox_patch, merged per
 * record, and show at once. Deleting for good and emptying a folder wait the
 * same way. Answers carry no state: a made-up one would reach the server later.
 */

import { MethodError, type MethodContext, type MethodHandler, type RecordOverlay } from '../area';
import { metaGet, metaSet } from '../engine/core-schema';
import { deleteEmail, upsertEmail, type EmailObject } from '../mail/records';
import type { StorageAdapter } from '../storage';
import { applyPatch, mergePatches, normalizePatch, patchProblem, stateOf, type Patch, type RecordState } from './patches';

export interface PatchRow {
  jmap: string;
  type: string;
  record_id: string;
  op: 'update' | 'destroy';
  patch: string;
  base: string | null;
  server: string | null;
  subject: string | null;
  seq: number;
  queued_at: number;
}

const EMAIL = 'Email';

/** The next place in the order changes and sends were made. */
export function nextSeq(db: StorageAdapter): number {
  const next = Number(metaGet(db, 'outbox_seq') ?? 0) + 1;
  metaSet(db, 'outbox_seq', String(next));
  return next;
}

function pendingRow(db: StorageAdapter, jmap: string, id: string): PatchRow | undefined {
  return db.get<PatchRow>('SELECT * FROM outbox_patch WHERE jmap = ? AND type = ? AND record_id = ?', [jmap, EMAIL, id]);
}

function savePatch(db: StorageAdapter, row: Omit<PatchRow, 'seq' | 'queued_at' | 'type'>, now: number): void {
  db.run(
    `INSERT INTO outbox_patch (jmap, type, record_id, op, patch, base, server, subject, seq, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (jmap, type, record_id) DO UPDATE SET op = excluded.op, patch = excluded.patch, seq = excluded.seq`,
    [row.jmap, EMAIL, row.record_id, row.op, row.patch, row.base, row.server, row.subject, nextSeq(db), now],
  );
}

function localEmail(db: StorageAdapter, jmap: string, id: string): { email: EmailObject; gen: number } | null {
  const row = db.get<{ json: string; gen: number }>('SELECT json, gen FROM email WHERE jmap = ? AND id = ?', [jmap, id]);
  return row ? { email: JSON.parse(row.json) as EmailObject, gen: Number(row.gen) } : null;
}

function subjectOf(email: EmailObject | undefined): string | null {
  return typeof email?.subject === 'string' ? email.subject : null;
}

/** Queues one change and shows it. The error for `notUpdated`, or null. */
export function queueUpdate(db: StorageAdapter, jmap: string, id: string, rawPatch: Patch, now: number): { type: string; description?: string } | null {
  const problem = patchProblem(rawPatch);
  if (problem) return problem;
  const patch = normalizePatch(rawPatch);
  const existing = pendingRow(db, jmap, id);
  if (existing?.op === 'destroy') return { type: 'notFound' };
  const local = localEmail(db, jmap, id);
  const after = applyPatch(local?.email ?? ({} as EmailObject), patch);
  // JMAP has no message outside every folder. Deleting is a destroy.
  if ((local || 'mailboxIds' in patch) && Object.keys(after.mailboxIds ?? {}).length === 0) {
    return { type: 'invalidProperties', description: 'A message has to stay in a folder' };
  }
  const state = local ? JSON.stringify(stateOf(local.email)) : null;
  savePatch(db, {
    jmap,
    record_id: id,
    op: 'update',
    patch: JSON.stringify(existing ? mergePatches(JSON.parse(existing.patch) as Patch, patch) : patch),
    base: state,
    server: state,
    subject: subjectOf(local?.email),
  }, now);
  if (local) upsertEmail(db, jmap, after as EmailObject, local.gen);
  return null;
}

/** Queues a delete and shows it. */
export function queueDestroy(db: StorageAdapter, jmap: string, id: string, now: number): void {
  const local = localEmail(db, jmap, id);
  const state = local ? JSON.stringify(stateOf(local.email)) : null;
  savePatch(db, { jmap, record_id: id, op: 'destroy', patch: '{}', base: state, server: state, subject: subjectOf(local?.email) }, now);
  // savePatch keeps base and server of a row already there; only the op changes.
  if (local) deleteEmail(db, jmap, id);
}

/**
 * SEAM for the drafts agent: Email/set create is theirs. Until it lands every
 * create is refused per message, so createDraft throws and the composer shows
 * its "draft not saved" state, as it does today.
 */
function createEmails(_ctx: MethodContext, _jmap: string, create: Record<string, unknown>): Record<string, { type: string; description: string }> {
  return Object.fromEntries(Object.keys(create).map((id) => [id, { type: 'serverUnavailable', description: 'Saving a draft needs the server' }]));
}

export const emailSet: MethodHandler = (ctx, args) => {
  const jmap = (args.accountId as string | undefined) ?? ctx.defaultJmap;
  if (args.destroy !== undefined && args.destroy !== null && !Array.isArray(args.destroy)) {
    throw new MethodError('invalidArguments', 'destroy has to be a list');
  }
  const result: Record<string, unknown> = { accountId: jmap };
  ctx.db.transaction(() => {
    if (args.create && Object.keys(args.create as object).length > 0) {
      result.created = {};
      result.notCreated = createEmails(ctx, jmap, args.create as Record<string, unknown>);
    }
    if (args.update) {
      const updated: Record<string, null> = {};
      const notUpdated: Record<string, unknown> = {};
      for (const [id, patch] of Object.entries(args.update as Record<string, Patch>)) {
        const problem = queueUpdate(ctx.db, jmap, id, patch, ctx.now());
        if (problem) notUpdated[id] = problem;
        else updated[id] = null;
      }
      result.updated = updated;
      if (Object.keys(notUpdated).length > 0) result.notUpdated = notUpdated;
    }
    if (Array.isArray(args.destroy)) {
      for (const id of args.destroy as string[]) queueDestroy(ctx.db, jmap, id, ctx.now());
      result.destroyed = args.destroy;
    }
  });
  ctx.emit({ type: 'changed', account: ctx.account, collections: ['Email', 'Mailbox', 'Thread'] });
  return result;
};

/** What waiting changes do to the folder counts: from the server's copy to what the change makes of it. */
function countDeltas(db: StorageAdapter, jmap: string): Map<string, { total: number; unread: number }> {
  const rows = db.all<{ op: string; patch: string; server: string | null }>('SELECT op, patch, server FROM outbox_patch WHERE jmap = ? AND type = ?', [jmap, EMAIL]);
  const deltas = new Map<string, { total: number; unread: number }>();
  const bump = (box: string, total: number, unread: number) => {
    const delta = deltas.get(box) ?? { total: 0, unread: 0 };
    delta.total += total;
    delta.unread += unread;
    deltas.set(box, delta);
  };
  for (const row of rows) {
    if (!row.server) continue;
    const before = JSON.parse(row.server) as RecordState;
    const wasUnread = before.keywords?.$seen ? 0 : 1;
    const boxesBefore = Object.keys(before.mailboxIds ?? {}).filter((box) => before.mailboxIds?.[box]);
    if (row.op === 'destroy') {
      for (const box of boxesBefore) bump(box, -1, -wasUnread);
      continue;
    }
    const after = applyPatch(before, JSON.parse(row.patch) as Patch);
    const isUnread = after.keywords?.$seen ? 0 : 1;
    const boxesAfter = Object.keys(after.mailboxIds ?? {});
    for (const box of boxesBefore) if (!after.mailboxIds?.[box]) bump(box, -1, -wasUnread);
    for (const box of boxesAfter) {
      if (!before.mailboxIds?.[box]) bump(box, 1, isUnread);
      else if (wasUnread !== isUnread) bump(box, 0, isUnread - wasUnread);
    }
  }
  return deltas;
}

/**
 * Sync must not lose a change that waits: what the server sends goes under it.
 * A record waiting to be deleted stays away. The folder counts stay the
 * server's, with what waits added when they're read, so a sync can't count a
 * change twice or forget it.
 */
export const outboxOverlay: RecordOverlay = (ctx, jmap, type, records) => {
  if (!ctx.db.get('SELECT 1 AS x FROM outbox_patch WHERE jmap = ? LIMIT 1', [jmap])) return records;
  switch (type) {
    case EMAIL: {
      const out: Array<{ id: string }> = [];
      for (const record of records) {
        const row = pendingRow(ctx.db, jmap, record.id);
        if (!row) {
          out.push(record);
          continue;
        }
        const email = record as EmailObject;
        ctx.db.run('UPDATE outbox_patch SET server = ?, subject = COALESCE(subject, ?) WHERE jmap = ? AND type = ? AND record_id = ?', [
          JSON.stringify(stateOf(email)), subjectOf(email), jmap, EMAIL, record.id,
        ]);
        if (row.op === 'update') out.push(applyPatch(email, JSON.parse(row.patch) as Patch) as EmailObject);
      }
      return out;
    }
    case 'Thread': {
      const gone = new Set(ctx.db.all<{ record_id: string }>(
        "SELECT record_id FROM outbox_patch WHERE jmap = ? AND type = ? AND op = 'destroy'",
        [jmap, EMAIL],
      ).map((row) => String(row.record_id)));
      return (records as Array<{ id: string; emailIds: string[] }>).map((thread) => ({
        ...thread,
        emailIds: thread.emailIds.filter((id) => !gone.has(id)),
      }));
    }
    case 'Mailbox': {
      const deltas = countDeltas(ctx.db, jmap);
      if (deltas.size === 0) return records;
      return (records as Array<{ id: string; totalEmails?: unknown; unreadEmails?: unknown }>).map((box) => {
        const delta = deltas.get(box.id);
        if (!delta) return box;
        const count = (value: unknown, by: number) => (typeof value === 'number' ? Math.max(0, value + by) : value);
        // Messages only: how the conversations change can't be told from here.
        return { ...box, totalEmails: count(box.totalEmails, delta.total), unreadEmails: count(box.unreadEmails, delta.unread) };
      });
    }
    default:
      return records;
  }
};
