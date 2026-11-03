/**
 * Calendar calls answered from the store.
 *
 * Series, not occurrences, in both client modes. A client in synthetic-id mode
 * sends `expandRecurrences: true` and gets the masters, with their overrides
 * (see projectEvent). hydrateRecurrenceInstances leaves those alone, and
 * expandRecurringEvents in the calendar store makes the occurrences, the same as
 * for a client in the other mode. Occurrence writes then arrive as overrides on
 * the master, which is what a stand-in id and the pending queue can work with.
 */

import type { CalendarEventFilter } from '@/lib/jmap/types';
import { SYNTHETIC_ID_PROBE } from '@/lib/recurrence-instances';
import { MethodError, type MethodContext, type MethodHandler, type MethodResult } from '../area';
import { listObjects } from '../engine/core-schema';
import type { SqlValue, StorageAdapter } from '../storage';
import { boundsOf, matchesFilter, sortEvents, type EventComparator } from './filter';
import { CALENDARS_CAPABILITY, instantOf, projectEvent, type CalendarObject } from './records';
import { syntheticIdVerdict } from './sync';
import { queueCreate, queueDestroy, queueUpdate, resolveId } from './writes';

function jmapOf(ctx: MethodContext, args: Record<string, unknown>): string {
  return (args.accountId as string | undefined) ?? ctx.session.primaryAccounts[CALENDARS_CAPABILITY] ?? ctx.defaultJmap;
}

function stateOf(db: StorageAdapter, jmap: string, type: string): string | undefined {
  return db.get<{ state: string | null }>('SELECT state FROM sync_state WHERE jmap = ? AND type = ?', [jmap, type])?.state ?? undefined;
}

/** An account never synced has no answer yet. An empty one would read as "no events". */
function assertSynced(db: StorageAdapter, jmap: string, type: string): void {
  const row = db.get<{ state: string | null; phase: string | null }>('SELECT state, phase FROM sync_state WHERE jmap = ? AND type = ?', [jmap, type]);
  if (!row?.state && !row?.phase) throw new MethodError('serverUnavailable', `${type} hasn't been kept on this device yet`);
}

// An event's start_ms reads a floating event in UTC, and a request's bounds are
// in its own zone: up to 14 hours apart. This only narrows, the filter decides.
const ZONE_SLACK_MS = 15 * 3_600_000;

function candidates(db: StorageAdapter, jmap: string, filter: CalendarEventFilter, zone: string): CalendarObject[] {
  const where = ['jmap = ?', 'hidden = 0'];
  const params: SqlValue[] = [jmap];
  if (typeof filter.uid === 'string' && !filter.operator) {
    where.push('uid = ?');
    params.push(filter.uid);
  }
  const { after, before } = boundsOf(filter);
  const afterMs = after ? instantOf(after, zone) : null;
  const beforeMs = before ? instantOf(before, zone) : null;
  if (afterMs !== null || beforeMs !== null) {
    where.push(`(is_series = 1 OR start_ms IS NULL OR (start_ms < ? AND end_ms >= ?))`);
    params.push(beforeMs === null ? Number.MAX_SAFE_INTEGER : beforeMs + ZONE_SLACK_MS);
    params.push(afterMs === null ? Number.MIN_SAFE_INTEGER : afterMs - ZONE_SLACK_MS);
  }
  return db.all<{ json: string }>(`SELECT json FROM calendar_event WHERE ${where.join(' AND ')}`, params)
    .map((row) => JSON.parse(row.json) as CalendarObject);
}

const calendarGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  assertSynced(ctx.db, jmap, 'Calendar');
  const ids = args.ids as string[] | null | undefined;
  const properties = args.properties as string[] | undefined;
  const all = listObjects<{ id: string } & Record<string, unknown>>(ctx.db, jmap, 'Calendar');
  const chosen = ids ? all.filter((calendar) => ids.includes(calendar.id)) : all;
  const state = stateOf(ctx.db, jmap, 'Calendar');
  return {
    accountId: jmap,
    ...(state ? { state } : {}),
    list: chosen.map((calendar) => (properties
      ? Object.fromEntries(['id', ...properties].filter((name) => name in calendar).map((name) => [name, calendar[name]]))
      : calendar)),
    notFound: ids ? ids.filter((id) => !all.some((calendar) => calendar.id === id)) : [],
  };
};

const eventQuery: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  assertSynced(ctx.db, jmap, 'CalendarEvent');
  const filter = (args.filter ?? {}) as CalendarEventFilter;
  const zone = typeof args.timeZone === 'string' && args.timeZone ? args.timeZone : 'UTC';
  const { after, before } = boundsOf(filter);
  if (args.expandRecurrences && !(after && before)) {
    throw new MethodError('invalidArguments', 'expandRecurrences needs both after and before');
  }
  const matching = candidates(ctx.db, jmap, filter, zone).filter((object) => matchesFilter(object, filter, zone));
  const sorted = sortEvents(matching, (args.sort ?? []) as EventComparator[], zone);
  const position = Math.max(0, Number(args.position ?? 0) || 0);
  const limit = Number(args.limit);
  const ids = sorted.map((object) => object.id);
  return {
    accountId: jmap,
    // No queryState: the client doesn't read it, and the store has no real one.
    canCalculateChanges: false,
    position,
    ids: ids.slice(position, limit > 0 ? position + limit : undefined),
    ...(args.calculateTotal ? { total: ids.length } : {}),
  };
};

const eventGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const requested = args.ids as string[] | null | undefined;
  // A page's first calendar list carries `ids: []` to check a time zone, also before any sync.
  if (!(Array.isArray(requested) && requested.length === 0)) assertSynced(ctx.db, jmap, 'CalendarEvent');
  const properties = (args.properties as string[] | undefined) ?? null;
  const zone = typeof args.timeZone === 'string' && args.timeZone ? args.timeZone : 'UTC';
  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  if (requested) {
    for (const id of requested) {
      const row = ctx.db.get<{ json: string }>('SELECT json FROM calendar_event WHERE jmap = ? AND id = ? AND hidden = 0', [jmap, resolveId(ctx.db, jmap, id)]);
      if (row) list.push(projectEvent(JSON.parse(row.json) as CalendarObject, properties, zone));
      else notFound.push(id);
    }
  } else {
    const rows = ctx.db.all<{ json: string }>('SELECT json FROM calendar_event WHERE jmap = ? AND hidden = 0', [jmap]);
    for (const row of rows) list.push(projectEvent(JSON.parse(row.json) as CalendarObject, properties, zone));
  }
  const state = stateOf(ctx.db, jmap, 'CalendarEvent');
  return { accountId: jmap, ...(state ? { state } : {}), list, notFound };
};

// What a server without synthetic-id writes says. It's the answer here too, for
// an id the store doesn't hold, which is an occurrence still on screen from
// before the connection went: the client catches this (updateOccurrence,
// destroyOccurrence in stores/calendar-store.ts) and writes the change as an
// override on the base event, which the store does hold.
function syntheticRefusal(verb: 'Updating' | 'Deleting'): { type: string; description: string; properties: string[] } {
  return { type: 'invalidProperties', description: `${verb} synthetic ids is not yet supported.`, properties: ['id'] };
}

const eventSet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const send = typeof args.sendSchedulingMessages === 'boolean' ? args.sendSchedulingMessages : undefined;
  const created: Record<string, { id: string; uid: string }> = {};
  const updated: Record<string, null> = {};
  const destroyed: string[] = [];
  const notUpdated: Record<string, unknown> = {};
  const notDestroyed: Record<string, unknown> = {};
  let wrote = false;
  ctx.db.transaction(() => {
    for (const [key, event] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
      created[key] = queueCreate(ctx, jmap, event, send);
      wrote = true;
    }
    for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
      if (id === SYNTHETIC_ID_PROBE) {
        // A client that started offline asks here. Tell it what the server said
        // at the last sync, so it behaves the same when the server is back. With
        // no answer yet: client-side expansion, which works on every server.
        notUpdated[id] = syntheticIdVerdict(ctx, jmap) === true ? { type: 'notFound' } : syntheticRefusal('Updating');
        continue;
      }
      if (queueUpdate(ctx, jmap, resolveId(ctx.db, jmap, id), patch, send)) {
        updated[id] = null;
        wrote = true;
      } else {
        notUpdated[id] = syntheticRefusal('Updating');
      }
    }
    for (const id of (args.destroy ?? []) as string[]) {
      if (queueDestroy(ctx, jmap, resolveId(ctx.db, jmap, id), send)) {
        destroyed.push(id);
        wrote = true;
      } else {
        notDestroyed[id] = syntheticRefusal('Deleting');
      }
    }
  });
  if (wrote) ctx.emit({ type: 'changed', account: ctx.account, collections: ['CalendarEvent'] });
  const result: MethodResult = { accountId: jmap };
  if (Object.keys(created).length > 0) result.created = created;
  if (Object.keys(updated).length > 0) result.updated = updated;
  if (destroyed.length > 0) result.destroyed = destroyed;
  if (Object.keys(notUpdated).length > 0) result.notUpdated = notUpdated;
  if (Object.keys(notDestroyed).length > 0) result.notDestroyed = notDestroyed;
  return result;
};

const identityGet: MethodHandler = (ctx, args) => {
  const jmap = jmapOf(ctx, args);
  const list = listObjects(ctx.db, jmap, 'ParticipantIdentity');
  if (list.length === 0) throw new MethodError('serverUnavailable', 'No participant identities kept yet');
  return { accountId: jmap, list, notFound: [] };
};

export const CALENDAR_METHODS: Readonly<Record<string, MethodHandler>> = {
  'Calendar/get': calendarGet,
  'CalendarEvent/query': eventQuery,
  'CalendarEvent/get': eventGet,
  'CalendarEvent/set': eventSet,
  'ParticipantIdentity/get': identityGet,
  // Notifications about others' changes wait for the server.
  'CalendarEventNotification/query': (ctx, args) => ({ accountId: jmapOf(ctx, args), canCalculateChanges: false, position: 0, ids: [] }),
  'CalendarEventNotification/get': (ctx, args) => ({ accountId: jmapOf(ctx, args), list: [], notFound: [] }),
};
