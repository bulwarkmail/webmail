/**
 * Sends pending calendar writes, one event per request, so a lost response
 * leaves one event's outcome open and not a batch's.
 *
 * Only a create can go wrong by being repeated. It's marked `attempted` in its
 * own transaction before it goes out, and carries a uid the device chose. A
 * create with that mark first looks for its uid on the server. An edit sent
 * twice writes the same values twice, and a delete sent twice finds nothing the
 * second time.
 */

import { jmapError } from '@/lib/jmap/jmap-error';
import { isOverrideSeriesKeyRejection, stableJson, withoutOverrideSeriesKeys } from '@/lib/recurrence-instances';
import type { CalendarEvent } from '@/lib/jmap/types';
import { applyPatchObject } from '@/lib/jmap/patch-object';
import type { SyncContext } from '../area';
import { JmapMethodError, responseFor } from '../engine/transport';
import { calendarUsing, currentGen, deleteEventRow, EVENT_PROPERTIES, eventRow, valueAtPointer, writeEvent, type CalendarObject } from './records';
import { recordConflict, type PendingRow } from './writes';

export interface FlushTally {
  sent: number;
  conflicts: number;
}

interface SetError {
  type?: string;
  description?: string;
  properties?: string[];
}

interface SetResult {
  created?: Record<string, { id: string }> | null;
  updated?: Record<string, unknown> | null;
  destroyed?: string[] | null;
  notCreated?: Record<string, SetError> | null;
  notUpdated?: Record<string, SetError> | null;
  notDestroyed?: Record<string, SetError> | null;
}

// The server had a bad moment, nothing is wrong with this write: try again later.
const PASSING_ERRORS = new Set(['serverFail', 'serverPartialFail', 'serverUnavailable', 'rateLimit', 'tooManyRequests']);

export function isPassingError(error: unknown): boolean {
  return error instanceof JmapMethodError && PASSING_ERRORS.has(error.type);
}

type Outcome = 'sent' | 'conflict' | 'again';

async function sendSet(ctx: SyncContext, row: PendingRow, args: Record<string, unknown>): Promise<SetResult> {
  const response = await ctx.transport.request([['CalendarEvent/set', {
    accountId: row.jmap,
    ...(row.send_scheduling === null ? {} : { sendSchedulingMessages: row.send_scheduling === 1 }),
    ...args,
  }, 's']], calendarUsing(ctx.session));
  return responseFor(response, 's')[1] as SetResult;
}

/** Stalwart 1.0 refuses what 0.16 expects inside an override. The client normally learns that from the refusal. */
function isSeriesKeyRefusal(error: SetError | undefined): boolean {
  return Boolean(error) && isOverrideSeriesKeyRejection(jmapError(error?.description ?? '', error));
}

async function findByUid(ctx: SyncContext, jmap: string, uid: string | null): Promise<string | null> {
  if (!uid) return null;
  const response = await ctx.transport.request([['CalendarEvent/query', { accountId: jmap, filter: { uid }, limit: 1 }, 'u']], calendarUsing(ctx.session));
  const ids = responseFor(response, 'u')[1].ids as string[];
  return ids[0] ?? null;
}

async function fetchEvent(ctx: SyncContext, jmap: string, id: string): Promise<CalendarObject | null> {
  const response = await ctx.transport.request([['CalendarEvent/get', { accountId: jmap, ids: [id], properties: EVENT_PROPERTIES }, 'g']], calendarUsing(ctx.session));
  return (responseFor(response, 'g')[1].list as CalendarObject[])[0] ?? null;
}

/** The stand-in becomes the real event. What came in while the create was on its way goes on as a write of its own. */
function finishCreate(ctx: SyncContext, row: PendingRow, sent: Record<string, unknown>, realId: string, event: CalendarObject): Outcome {
  const { db } = ctx;
  return db.transaction(() => {
    const current = db.get<PendingRow>('SELECT * FROM calendar_pending WHERE seq = ?', [row.seq]);
    const gen = currentGen(db, row.jmap);
    deleteEventRow(db, row.jmap, row.record_id);
    db.run(
      'INSERT OR REPLACE INTO calendar_id_map (jmap, local_id, server_id) VALUES (?, ?, ?)',
      [row.jmap, row.record_id, realId],
    );
    ctx.emit({ type: 'changed', account: ctx.account, collections: ['CalendarEvent'] });
    if (current?.kind === 'destroy') {
      writeEvent(db, row.jmap, { shown: event, server: event, hidden: true, gen });
      db.run('UPDATE calendar_pending SET record_id = ?, uid = NULL, attempted = 0 WHERE seq = ?', [realId, row.seq]);
      return 'again';
    }
    if (current && current.rev !== row.rev) {
      const now = JSON.parse(current.patch) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(sent), ...Object.keys(now)])) {
        if (stableJson(sent[key]) !== stableJson(now[key])) patch[key] = now[key] ?? null;
      }
      const base = Object.fromEntries(Object.keys(patch).map((key) => [key, valueAtPointer(event, key) ?? null]));
      db.run(
        `UPDATE calendar_pending SET kind = 'update', record_id = ?, patch = ?, base = ?, uid = NULL, attempted = 0 WHERE seq = ?`,
        [realId, JSON.stringify(patch), JSON.stringify(base), row.seq],
      );
      writeEvent(db, row.jmap, { shown: applyPatchObject(event, patch), server: event, gen });
      return 'again';
    }
    db.run('DELETE FROM calendar_pending WHERE seq = ?', [row.seq]);
    writeEvent(db, row.jmap, { shown: event, gen });
    return 'sent';
  });
}

async function sendCreate(ctx: SyncContext, row: PendingRow): Promise<Outcome> {
  const payload = JSON.parse(row.patch) as Record<string, unknown>;
  let realId = row.attempted ? await findByUid(ctx, row.jmap, row.uid) : null;
  if (!realId) {
    ctx.db.transaction(() => ctx.db.run('UPDATE calendar_pending SET attempted = 1 WHERE seq = ?', [row.seq]));
    let result = await sendSet(ctx, row, { create: { c: payload } });
    if (isSeriesKeyRefusal(result.notCreated?.c)) {
      const without = withoutOverrideSeriesKeys(payload as Partial<CalendarEvent>);
      result = await sendSet(ctx, row, { create: { c: without } });
    }
    realId = result.created?.c?.id ?? null;
    const refusal = result.notCreated?.c;
    // Both Stalwarts refuse a second event with one uid, which also covers a
    // create that got through when the device didn't know it had tried.
    if (!realId && refusal?.type === 'invalidProperties' && refusal.properties?.includes('uid')) {
      realId = await findByUid(ctx, row.jmap, row.uid);
    }
    if (!realId) {
      ctx.db.transaction(() => recordConflict(ctx, row, 'refused', refusal ?? { type: 'serverFail' }));
      return 'conflict';
    }
  }
  const event = await fetchEvent(ctx, row.jmap, realId) ?? ({ ...payload, id: realId } as CalendarObject);
  return finishCreate(ctx, row, payload, realId, event);
}

function finishUpdate(ctx: SyncContext, row: PendingRow, sent: Record<string, unknown>): Outcome {
  const { db } = ctx;
  return db.transaction(() => {
    const current = db.get<PendingRow>('SELECT * FROM calendar_pending WHERE seq = ?', [row.seq]);
    const event = eventRow(db, row.jmap, row.record_id);
    ctx.emit({ type: 'changed', account: ctx.account, collections: ['CalendarEvent'] });
    if (!current || !event) return 'sent';
    if (current.rev === row.rev) {
      db.run('DELETE FROM calendar_pending WHERE seq = ?', [row.seq]);
      writeEvent(db, row.jmap, { shown: JSON.parse(event.json) as CalendarObject, gen: event.gen });
      return 'sent';
    }
    // A newer write came in during the send. What went out is the server's now,
    // so the next sync must not take it for someone else's change.
    const server = applyPatchObject(JSON.parse(event.server_json ?? event.json) as CalendarObject, sent);
    const base = JSON.parse(current.base) as Record<string, unknown>;
    for (const key of Object.keys(sent)) if (key in base) base[key] = sent[key];
    db.run('UPDATE calendar_pending SET base = ? WHERE seq = ?', [JSON.stringify(base), row.seq]);
    writeEvent(db, row.jmap, { shown: JSON.parse(event.json) as CalendarObject, server, hidden: Boolean(event.hidden), gen: event.gen });
    return 'again';
  });
}

async function sendUpdate(ctx: SyncContext, row: PendingRow): Promise<Outcome> {
  let patch = JSON.parse(row.patch) as Record<string, unknown>;
  const id = row.record_id;
  let result = await sendSet(ctx, row, { update: { [id]: patch } });
  if (isSeriesKeyRefusal(result.notUpdated?.[id])) {
    patch = withoutOverrideSeriesKeys(patch as Partial<CalendarEvent>) as Record<string, unknown>;
    result = await sendSet(ctx, row, { update: { [id]: patch } });
  }
  const refusal = result.notUpdated?.[id];
  if (refusal) {
    ctx.db.transaction(() => recordConflict(ctx, row, refusal.type === 'notFound' ? 'destroyedOnServer' : 'refused', refusal));
    return 'conflict';
  }
  return finishUpdate(ctx, row, patch);
}

async function sendDestroy(ctx: SyncContext, row: PendingRow): Promise<Outcome> {
  // A create turned delete while its create was out: find out what the server has.
  const id = row.uid ? await findByUid(ctx, row.jmap, row.uid) : row.record_id;
  const finish = () => ctx.db.transaction(() => {
    ctx.db.run('DELETE FROM calendar_pending WHERE seq = ?', [row.seq]);
    deleteEventRow(ctx.db, row.jmap, row.record_id);
    ctx.emit({ type: 'changed', account: ctx.account, collections: ['CalendarEvent'] });
  });
  if (!id) {
    finish();
    return 'sent';
  }
  const result = await sendSet(ctx, row, { destroy: [id] });
  const refusal = result.notDestroyed?.[id];
  if (refusal && refusal.type !== 'notFound') {
    ctx.db.transaction(() => recordConflict(ctx, row, 'refused', refusal));
    return 'conflict';
  }
  finish();
  return 'sent';
}

/**
 * Sends what's pending for one JMAP account. Network failures and a server's
 * bad moment are thrown, with the rest still pending. Any other method error
 * means this write won't work as it is, so it goes to the conflict list and the
 * others still go out.
 */
export async function sendPending(ctx: SyncContext, jmap: string): Promise<FlushTally> {
  const tally: FlushTally = { sent: 0, conflicts: 0 };
  const finished = new Set<number>();
  for (;;) {
    if (ctx.stopped()) return tally;
    const row = ctx.db.all<PendingRow>('SELECT * FROM calendar_pending WHERE jmap = ? ORDER BY seq', [jmap])
      .find((candidate) => !finished.has(Number(candidate.seq)));
    if (!row) return tally;
    let outcome: Outcome;
    try {
      if (row.kind === 'create') outcome = await sendCreate(ctx, row);
      else if (row.kind === 'update') outcome = await sendUpdate(ctx, row);
      else outcome = await sendDestroy(ctx, row);
    } catch (error) {
      if (!(error instanceof JmapMethodError) || isPassingError(error)) throw error;
      ctx.db.transaction(() => recordConflict(ctx, row, 'refused', { type: error.type, description: error.message }));
      outcome = 'conflict';
    }
    if (outcome === 'again') continue;
    finished.add(Number(row.seq));
    if (outcome === 'sent') tally.sent += 1;
    else tally.conflicts += 1;
  }
}
