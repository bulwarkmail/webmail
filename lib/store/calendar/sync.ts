/**
 * Calendar sync for one JMAP account: calendars, the last participant
 * identities, then every event and task.
 *
 * Masters only. CalendarEvent/changes lists nothing else on either Stalwart, an
 * instance edit shows up as `updated: [master]`, and 1.0's expanded queries
 * can't give changes and refuse long ranges. Occurrences are made when read.
 */

import { isTaskLikeObject } from '@/lib/calendar-component-detection';
import { SYNTHETIC_ID_PROBE } from '@/lib/recurrence-instances';
import type { StoreContext, SyncContext, Syncer } from '../area';
import { runChangesLoop } from '../engine/changes';
import { metaGet, metaSet, putObject } from '../engine/core-schema';
import { JmapMethodError, responseFor, TransportError } from '../engine/transport';
import type { StorageAdapter } from '../storage';
import { isPassingError, sendPending, type FlushTally } from './flush';
import {
  CALENDAR_PROPERTIES,
  CALENDARS_CAPABILITY,
  calendarUsing,
  currentGen,
  EVENT_PROPERTIES,
  eventRow,
  instantsOf,
  isSeries,
  type CalendarObject,
} from './records';
import { applyServerDestroy, applyServerEvent, isStandIn, pendingFor } from './writes';

const PAGE = 500;
/** How far back single events are kept. A series stays whatever its start, a task whatever its date. */
const PAST_WINDOW_MS = 2 * 366 * 86_400_000;

function syntheticIdsKey(jmap: string): string {
  return `calendar.syntheticIds.${jmap}`;
}

/**
 * What this account's server said to the synthetic-id probe at the last sync.
 * Null before it ever answered. A client that probed online holds its verdict
 * for life and never asks again; only one started offline asks the store.
 */
export function syntheticIdVerdict(ctx: StoreContext, jmap: string): boolean | null {
  const value = metaGet(ctx.db, syntheticIdsKey(jmap));
  return value === null ? null : value === '1';
}

// A shared account probed on suspicion that grants no calendar access (the
// client treats these the same way).
function isAccessDenial(error: unknown): boolean {
  return error instanceof JmapMethodError
    && (error.type === 'forbidden' || error.type === 'accountNotFound' || error.type === 'accountNotSupportedByMethod');
}

/** False when the account grants no calendar access. */
async function syncCalendars(ctx: SyncContext, jmap: string): Promise<boolean> {
  const response = await ctx.transport.request([
    ['Calendar/get', { accountId: jmap, ids: null, properties: CALENDAR_PROPERTIES }, 'c'],
    ['CalendarEvent/set', { accountId: jmap, update: { [SYNTHETIC_ID_PROBE]: {} } }, 'p'],
    ['ParticipantIdentity/get', { accountId: jmap }, 'i'],
  ], calendarUsing(ctx.session));
  let result: { list: Array<{ id: string }>; state: unknown };
  try {
    result = responseFor(response, 'c')[1];
  } catch (error) {
    if (isAccessDenial(error)) return false;
    throw error;
  }
  const probe = response.methodResponses.find(([, , id]) => id === 'p');
  const identities = response.methodResponses.find(([, , id]) => id === 'i');
  const before = ctx.syncState(jmap, 'Calendar').state;
  ctx.db.transaction(() => {
    ctx.db.run("DELETE FROM object WHERE jmap = ? AND type = 'Calendar'", [jmap]);
    for (const calendar of result.list) putObject(ctx.db, jmap, 'Calendar', calendar.id, calendar);
    ctx.setSyncState(jmap, 'Calendar', { state: String(result.state) });
    if (probe?.[0] === 'CalendarEvent/set') {
      const failure = probe[1]?.notUpdated?.[SYNTHETIC_ID_PROBE] as { type?: string } | undefined;
      metaSet(ctx.db, syntheticIdsKey(jmap), failure?.type === 'notFound' ? '1' : '0');
    }
    // Only ever read as "the last value". 0.16 has no usable /changes for it.
    if (identities?.[0] === 'ParticipantIdentity/get') {
      ctx.db.run("DELETE FROM object WHERE jmap = ? AND type = 'ParticipantIdentity'", [jmap]);
      for (const identity of identities[1].list as Array<{ id: string }>) putObject(ctx.db, jmap, 'ParticipantIdentity', identity.id, identity);
    }
  });
  if (before !== String(result.state)) ctx.emit({ type: 'changed', account: ctx.account, collections: ['Calendar'] });
  return true;
}

function inWindow(ctx: SyncContext, event: CalendarObject): boolean {
  if (isSeries(event) || isTaskLikeObject(event)) return true;
  const { end } = instantsOf(event, 'UTC');
  return end === null || end >= ctx.now() - PAST_WINDOW_MS;
}

interface ListCursor { position: number; gen: number; captured: string }

async function startFullList(ctx: SyncContext, jmap: string): Promise<ListCursor> {
  const response = await ctx.transport.request([['CalendarEvent/get', { accountId: jmap, ids: [], properties: ['id'] }, 's']], calendarUsing(ctx.session));
  const captured = String(responseFor(response, 's')[1].state);
  const cursor: ListCursor = { position: 0, gen: currentGen(ctx.db, jmap) + 1, captured };
  ctx.db.transaction(() => ctx.setSyncState(jmap, 'CalendarEvent', { state: null, phase: 'list', cursor: { ...cursor } }));
  return cursor;
}

function storeEvent(ctx: SyncContext, jmap: string, event: CalendarObject, gen: number): void {
  // An old event changing doesn't pull it back into the window.
  if (!inWindow(ctx, event) && !eventRow(ctx.db, jmap, event.id) && !pendingFor(ctx.db, jmap, event.id)) return;
  applyServerEvent(ctx, jmap, event, gen);
}

/** Pages through every object: the query has no filter for tasks, and old series must stay. False when stopped. */
async function runFullList(ctx: SyncContext, jmap: string, start: ListCursor): Promise<boolean> {
  const cursor = { ...start };
  for (;;) {
    if (ctx.stopped()) return false;
    const response = await ctx.transport.request([
      ['CalendarEvent/query', { accountId: jmap, position: cursor.position, limit: PAGE }, 'q'],
      ['CalendarEvent/get', {
        accountId: jmap,
        '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
        properties: EVENT_PROPERTIES,
      }, 'g'],
    ], calendarUsing(ctx.session));
    const ids = responseFor(response, 'q')[1].ids as string[];
    const list = responseFor(response, 'g')[1].list as CalendarObject[];
    const done = ids.length < PAGE;
    cursor.position += ids.length;
    ctx.db.transaction(() => {
      for (const event of list) storeEvent(ctx, jmap, event, cursor.gen);
      if (done) {
        // Whatever this pass didn't see is gone from the server.
        const stale = ctx.db.all<{ id: string }>('SELECT id FROM calendar_event WHERE jmap = ? AND gen < ?', [jmap, cursor.gen]);
        for (const { id } of stale) if (!isStandIn(id)) applyServerDestroy(ctx, jmap, id);
        ctx.setSyncState(jmap, 'CalendarEvent', { state: cursor.captured, phase: null, cursor: null });
      } else {
        ctx.setSyncState(jmap, 'CalendarEvent', { cursor: { ...cursor } });
      }
    });
    ctx.emit({ type: 'progress', account: ctx.account, area: 'calendar', phase: 'list', done: cursor.position, total: null });
    if (done) {
      ctx.emit({ type: 'changed', account: ctx.account, collections: ['CalendarEvent'] });
      return true;
    }
  }
}

async function syncDelta(ctx: SyncContext, jmap: string, since: string, target: string | null): Promise<'done' | 'resync' | 'stopped'> {
  const outcome = await runChangesLoop({
    transport: ctx.transport,
    type: 'CalendarEvent',
    jmap,
    using: calendarUsing(ctx.session),
    since,
    target,
    stopped: ctx.stopped,
    apply: async (page) => {
      const ids = [...page.created, ...page.updated];
      const fetched: CalendarObject[] = [];
      for (let i = 0; i < ids.length; i += PAGE) {
        const response = await ctx.transport.request([['CalendarEvent/get', {
          accountId: jmap,
          ids: ids.slice(i, i + PAGE),
          properties: EVENT_PROPERTIES,
        }, 'g']], calendarUsing(ctx.session));
        fetched.push(...responseFor(response, 'g')[1].list as CalendarObject[]);
      }
      ctx.db.transaction(() => {
        const gen = currentGen(ctx.db, jmap);
        for (const event of fetched) storeEvent(ctx, jmap, event, gen);
        for (const id of page.destroyed) applyServerDestroy(ctx, jmap, id);
        ctx.setSyncState(jmap, 'CalendarEvent', { state: page.newState });
      });
      if (ids.length + page.destroyed.length > 0) ctx.emit({ type: 'changed', account: ctx.account, collections: ['CalendarEvent'] });
    },
  });
  if (outcome.outcome === 'resync') return 'resync';
  return outcome.outcome === 'stopped' ? 'stopped' : 'done';
}

/** False when stopped before catching up. */
async function syncEvents(ctx: SyncContext, jmap: string): Promise<boolean> {
  const sync = ctx.syncState(jmap, 'CalendarEvent');
  let cursor = sync.phase === 'list' ? sync.cursor as unknown as ListCursor : null;
  if (!cursor && !sync.state) cursor = await startFullList(ctx, jmap);
  if (!cursor && sync.state) {
    const outcome = await syncDelta(ctx, jmap, sync.state, sync.target);
    if (outcome === 'stopped') return false;
    if (outcome === 'resync') cursor = await startFullList(ctx, jmap);
  }
  if (cursor) {
    if (!(await runFullList(ctx, jmap, cursor))) return false;
    // What changed while paging.
    const after = ctx.syncState(jmap, 'CalendarEvent');
    if (after.state && (await syncDelta(ctx, jmap, after.state, after.target)) === 'stopped') return false;
  }
  return true;
}

/** Single events that aged out of the window. The window moves on without any change on the server. */
function pruneOld(ctx: SyncContext, jmap: string): void {
  ctx.db.run(
    `DELETE FROM calendar_event WHERE jmap = ? AND is_series = 0 AND is_task = 0 AND end_ms IS NOT NULL AND end_ms < ?
       AND NOT EXISTS (SELECT 1 FROM calendar_pending p WHERE p.jmap = calendar_event.jmap AND p.record_id = calendar_event.id)`,
    [jmap, ctx.now() - PAST_WINDOW_MS],
  );
}

// A sync and a flush must not interleave. Our own write coming back through
// /changes while it's still pending would read as someone else's change.
const queues = new WeakMap<StorageAdapter, Promise<unknown>>();

function oneAtATime<T>(db: StorageAdapter, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(db) ?? Promise.resolve()).catch(() => {}).then(work);
  queues.set(db, next);
  return next;
}

async function syncAndSend(ctx: SyncContext, jmap: string): Promise<FlushTally> {
  const none: FlushTally = { sent: 0, conflicts: 0 };
  if (!(await syncEvents(ctx, jmap)) || ctx.stopped()) return none;
  const tally = await sendPending(ctx, jmap);
  if (tally.sent > 0 && !ctx.stopped()) await syncEvents(ctx, jmap);
  return tally;
}

export const calendarSyncer: Syncer = {
  name: 'calendar',
  capability: CALENDARS_CAPABILITY,
  async run(ctx, jmap) {
    if (!(await syncCalendars(ctx, jmap)) || ctx.stopped()) return;
    await oneAtATime(ctx.db, () => syncAndSend(ctx, jmap));
    pruneOld(ctx, jmap);
  },
};

export interface FlushResult extends FlushTally {
  /** Writes still waiting: the network went away, or the server had a bad moment. */
  pending: number;
}

/**
 * `calendar.flush`: catches up with the server, so a write that collides with
 * a change there is found, then sends every pending write. Doesn't throw for a
 * lost connection: what wasn't sent stays pending.
 */
export function flushCalendar(ctx: SyncContext): Promise<FlushResult> {
  return oneAtATime(ctx.db, async () => {
    const accounts = ctx.db.all<{ jmap: string }>('SELECT DISTINCT jmap FROM calendar_pending').map((row) => row.jmap);
    const total: FlushTally = { sent: 0, conflicts: 0 };
    try {
      for (const jmap of accounts) {
        const tally = await syncAndSend(ctx, jmap);
        total.sent += tally.sent;
        total.conflicts += tally.conflicts;
      }
    } catch (error) {
      if (!(error instanceof TransportError) && !isPassingError(error)) throw error;
    }
    const pending = Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendar_pending')?.n ?? 0);
    return { ...total, pending };
  });
}
