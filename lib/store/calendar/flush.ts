/**
 * Sends pending calendar writes, one write per request, so a lost response leaves
 * one write's outcome open and not a batch's. An event's writes go in order.
 *
 * A row is marked before it goes out. A create so marked first looks for its uid
 * on the server, because repeating it could duplicate the event. A marked edit
 * whose values read back from the server is done, and one that's repeated writes
 * the same values. A delete sent twice finds nothing the second time.
 *
 * A write that can't work goes to the conflict list and the others still go out.
 * Anything that may pass stays pending: an answer with no verdict for it, a set
 * error such as serverFail or rateLimit, and for the whole run a network failure,
 * 401, 429 or 5xx.
 */

import { jmapError } from '@/lib/jmap/jmap-error';
import type { CalendarEvent } from '@/lib/jmap/types';
import { isOverrideSeriesKeyRejection, withoutOverrideSeriesKeys } from '@/lib/recurrence-instances';
import type { SyncContext } from '../area';
import { JmapMethodError, responseFor, TransportError } from '../engine/transport';
import { holdsPatch, patchForServer } from './patches';
import { calendarUsing, EVENT_PROPERTIES, eventRow, type CalendarObject } from './records';
import { adoptStandIn, finishWrite, markSent, pendingBySeq, recordConflict, type PendingRow } from './writes';

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

function passes(refusal: SetError | undefined): boolean {
  return !refusal || PASSING_ERRORS.has(refusal.type ?? '');
}

/** A 4xx other than 401 and 429, which the transport reports as their own kinds: this request won't work. */
function isRefusedRequest(error: unknown): boolean {
  return error instanceof TransportError && error.kind === 'http' && (error.status ?? 0) >= 400 && (error.status ?? 0) < 500;
}

type Outcome = 'sent' | 'conflict' | 'again' | 'retry';

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

function conflict(ctx: SyncContext, row: PendingRow, reason: 'refused' | 'destroyedOnServer', error: SetError): Outcome {
  ctx.db.transaction(() => recordConflict(ctx, row, reason, error));
  return 'conflict';
}

async function sendCreate(ctx: SyncContext, row: PendingRow): Promise<Outcome> {
  const payload = JSON.parse(row.patch) as Record<string, unknown>;
  let realId = row.attempted ? await findByUid(ctx, row.jmap, row.uid) : null;
  if (!realId) {
    markSent(ctx, row, payload);
    let result = await sendSet(ctx, row, { create: { c: payload } });
    if (isSeriesKeyRefusal(result.notCreated?.c)) {
      result = await sendSet(ctx, row, { create: { c: withoutOverrideSeriesKeys(payload as Partial<CalendarEvent>) } });
    }
    realId = result.created?.c?.id ?? null;
    const refusal = result.notCreated?.c;
    if (!realId) {
      // Both Stalwarts refuse a second event with one uid. Nothing of ours went
      // in then, so what the server holds is compared as a whole.
      if (refusal?.type === 'invalidProperties' && refusal.properties?.includes('uid')) {
        ctx.db.transaction(() => ctx.db.run('UPDATE calendar_pending SET sent = NULL WHERE seq = ?', [row.seq]));
        realId = await findByUid(ctx, row.jmap, row.uid);
      }
      if (!realId) return passes(refusal) ? 'retry' : conflict(ctx, row, 'refused', refusal as SetError);
    }
  }
  const event = await fetchEvent(ctx, row.jmap, realId) ?? ({ ...payload, id: realId } as CalendarObject);
  const left = ctx.db.transaction(() => adoptStandIn(ctx, row, event));
  return left ? 'again' : 'sent';
}

async function sendUpdate(ctx: SyncContext, row: PendingRow): Promise<Outcome> {
  const id = row.record_id;
  const stored = eventRow(ctx.db, row.jmap, id);
  const server = JSON.parse(stored?.server_json ?? stored?.json ?? '{}') as Record<string, unknown>;
  const queued = JSON.parse(row.patch) as Record<string, unknown>;
  let patch = patchForServer(queued, server);
  // Nothing to change, and an answer sent twice would mail the organizer twice.
  if (holdsPatch(server, queued) || Object.keys(patch).length === 0) {
    return ctx.db.transaction(() => finishWrite(ctx, row, {})) ? 'again' : 'sent';
  }
  markSent(ctx, row, patch);
  let result = await sendSet(ctx, row, { update: { [id]: patch } });
  if (isSeriesKeyRefusal(result.notUpdated?.[id])) {
    patch = withoutOverrideSeriesKeys(patch as Partial<CalendarEvent>) as Record<string, unknown>;
    result = await sendSet(ctx, row, { update: { [id]: patch } });
  }
  const refusal = result.notUpdated?.[id];
  if (refusal && !passes(refusal)) return conflict(ctx, row, refusal.type === 'notFound' ? 'destroyedOnServer' : 'refused', refusal);
  if (refusal || !result.updated || !(id in result.updated)) return 'retry';
  return ctx.db.transaction(() => finishWrite(ctx, row, patch)) ? 'again' : 'sent';
}

async function sendDestroy(ctx: SyncContext, row: PendingRow): Promise<Outcome> {
  // A create turned delete: only the server knows whether the create got there.
  const id = row.uid ? await findByUid(ctx, row.jmap, row.uid) : row.record_id;
  const finish = (): Outcome => ctx.db.transaction(() => {
    ctx.db.run('DELETE FROM calendar_pending WHERE seq = ?', [row.seq]);
    ctx.db.run('DELETE FROM calendar_event WHERE jmap = ? AND id = ?', [row.jmap, row.record_id]);
    ctx.emit({ type: 'changed', account: ctx.account, collections: ['CalendarEvent'] });
    return 'sent' as const;
  });
  if (!id) return finish();
  const result = await sendSet(ctx, row, { destroy: [id] });
  const refusal = result.notDestroyed?.[id];
  if (refusal?.type === 'notFound' || result.destroyed?.includes(id)) return finish();
  return passes(refusal) ? 'retry' : conflict(ctx, row, 'refused', refusal as SetError);
}

function conflictCount(ctx: SyncContext): number {
  return Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendar_conflict')?.n ?? 0);
}

/**
 * Sends what's pending for one JMAP account. Network failures and a server's bad
 * moment are thrown, with the rest still pending.
 */
export async function sendPending(ctx: SyncContext, jmap: string): Promise<FlushTally> {
  const tally: FlushTally = { sent: 0, conflicts: 0 };
  const finished = new Set<number>();
  // An event whose write has to wait: its later writes wait with it.
  const waiting = new Set<string>();
  for (;;) {
    if (ctx.stopped()) return tally;
    const row = ctx.db.all<PendingRow>('SELECT * FROM calendar_pending WHERE jmap = ? ORDER BY seq', [jmap])
      .find((candidate) => !finished.has(Number(candidate.seq)) && !waiting.has(candidate.record_id));
    if (!row) return tally;
    const conflictsBefore = conflictCount(ctx);
    let outcome: Outcome;
    try {
      if (row.kind === 'create') outcome = await sendCreate(ctx, row);
      else if (row.kind === 'update') outcome = await sendUpdate(ctx, row);
      else outcome = await sendDestroy(ctx, row);
    } catch (error) {
      const current = pendingBySeq(ctx.db, row.seq) ?? row;
      if (isRefusedRequest(error)) {
        outcome = conflict(ctx, current, 'refused', { type: 'http', description: (error as Error).message });
      } else if (error instanceof JmapMethodError && !isPassingError(error)) {
        outcome = conflict(ctx, current, 'refused', { type: error.type, description: error.message });
      } else {
        throw error;
      }
    }
    if (outcome === 'again') continue;
    if (outcome === 'retry') {
      waiting.add(row.record_id);
      continue;
    }
    finished.add(Number(row.seq));
    if (outcome === 'sent') tally.sent += 1;
    else tally.conflicts += conflictCount(ctx) - conflictsBefore;
  }
}
