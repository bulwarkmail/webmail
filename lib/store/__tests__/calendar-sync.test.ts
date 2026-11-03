// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE, type StoreEvent } from '../area';
import { calendarArea } from '../calendar';
import { listUpcomingAlerts } from '../calendar/reminders';
import { AccountEngine } from '../engine/account-engine';
import { TransportError, type MethodCall } from '../engine/transport';
import type { CalendarConflict } from '../calendar/writes';
import { CAL, CALENDAR_SESSION, FakeCalendarJmap, type StalwartVersion } from './helpers/fake-calendar';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const NOW = Date.UTC(2026, 10, 3, 12);
const WEEKLY = { '@type': 'RecurrenceRule', frequency: 'weekly' };

function setup(version: StalwartVersion = '1.0', server = new FakeCalendarJmap(version)) {
  const db = openMemoryStore();
  const events: StoreEvent[] = [];
  const engine = new AccountEngine({
    account: 'a@fake.test',
    db,
    session: CALENDAR_SESSION,
    transport: server,
    areas: [calendarArea],
    scope: DEFAULT_SCOPE,
    emit: (event) => events.push(event),
    now: () => NOW,
    sleep: async () => {},
  });
  return { server, db, engine, events };
}

type Setup = ReturnType<typeof setup>;

async function call(s: Setup, name: string, args: Record<string, unknown>) {
  // A companion call: the engine answers null when nothing at all could be answered.
  const response = await s.engine.answer([
    [name, { accountId: JMAP_ACCOUNT, ...args }, 'x'],
    ['CalendarEventNotification/get', { accountId: JMAP_ACCOUNT, ids: [] }, 'y'],
  ]);
  return response!.methodResponses[0];
}

async function queryIds(s: Setup, args: Record<string, unknown>): Promise<string[]> {
  const [name, result] = await call(s, 'CalendarEvent/query', args);
  expect(name, JSON.stringify(result)).toBe('CalendarEvent/query');
  return result.ids;
}

async function getOne(s: Setup, id: string, properties?: string[], timeZone?: string): Promise<Record<string, unknown> | undefined> {
  const [, result] = await call(s, 'CalendarEvent/get', { ids: [id], ...(properties ? { properties } : {}), ...(timeZone ? { timeZone } : {}) });
  return result.list[0];
}

async function setEvent(s: Setup, args: Record<string, unknown>) {
  const [name, result] = await call(s, 'CalendarEvent/set', args);
  expect(name).toBe('CalendarEvent/set');
  return result;
}

const flush = (s: Setup) => s.engine.areaCall('calendar.flush', undefined) as Promise<{ sent: number; conflicts: number; pending: number }>;
const conflicts = (s: Setup) => s.engine.areaCall('calendar.conflicts', undefined) as Promise<CalendarConflict[]>;
const pendingRows = (s: Setup) => s.db.all<{ kind: string; patch: string; record_id: string }>('SELECT kind, patch, record_id FROM calendar_pending');
const setCalls = (server: FakeCalendarJmap): MethodCall[] => server.calls.filter(([name]) => name === 'CalendarEvent/set')
  .filter(([, args]) => !(args.update && 'h333333' in (args.update as object)));

describe('calendar sync', () => {
  it('keeps a recurring event as its master across sync, with its overrides', async () => {
    const s = setup();
    s.server.addEvent({
      id: 'series',
      recurrenceRule: WEEKLY,
      start: '2026-01-05T10:00:00',
      recurrenceOverrides: { '2026-11-09T10:00:00': { title: 'Moved' }, '2026-11-16T10:00:00': { excluded: true } },
    });
    await s.engine.requestSync();
    expect(s.db.all('SELECT id FROM calendar_event').map((row) => row.id)).toEqual(['series']);
    const stored = await getOne(s, 'series');
    expect(stored?.recurrenceRule).toEqual(WEEKLY);
    expect(stored?.recurrenceOverrides).toEqual({ '2026-11-09T10:00:00': { title: 'Moved' }, '2026-11-16T10:00:00': { excluded: true } });
  });

  it('asks for overrides without the utc properties, which 1.0 refuses next to them', async () => {
    const s = setup('1.0');
    s.server.addEvent({ id: 'series', recurrenceRule: WEEKLY, recurrenceOverrides: { '2026-11-17T10:00:00': { title: 'x' } } });
    await s.engine.requestSync();
    const events = s.server.calls.filter(([name]) => name === 'CalendarEvent/get');
    const withOverrides = events.filter(([, args]) => (args.properties as string[]).includes('recurrenceOverrides'));
    expect(withOverrides.length).toBeGreaterThan(0);
    for (const [, args] of withOverrides) expect(args.properties).not.toContain('utcStart');
    expect(await getOne(s, 'series')).toMatchObject({ recurrenceOverrides: { '2026-11-17T10:00:00': { title: 'x' } } });
  });

  it('never runs an expanded query or stores a synthetic id', async () => {
    const s = setup('0.16');
    s.server.addEvent({ id: 'series', recurrenceRule: WEEKLY });
    s.server.addEvent({ id: 'single' });
    await s.engine.requestSync();
    expect(s.server.calls.filter(([, args]) => args.expandRecurrences)).toEqual([]);
    expect(s.db.all('SELECT id FROM calendar_event ORDER BY id').map((row) => row.id)).toEqual(['series', 'single']);
  });

  it('pages past 500 objects', async () => {
    const s = setup();
    for (let i = 0; i < 1234; i += 1) s.server.addEvent();
    await s.engine.requestSync();
    expect(Number(s.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM calendar_event')?.n)).toBe(1234);
    expect(s.server.calls.filter(([name]) => name === 'CalendarEvent/query').length).toBe(3);
  });

  it('takes an edit of one occurrence from /changes as an update of the master', async () => {
    const s = setup('1.0');
    s.server.addEvent({ id: 'series', recurrenceRule: WEEKLY, start: '2026-11-02T10:00:00' });
    await s.engine.requestSync();
    // Someone edits one occurrence through its synthetic id.
    const [, expanded] = (await s.server.request([['CalendarEvent/query', {
      accountId: JMAP_ACCOUNT, filter: { after: '2026-11-08T00:00:00', before: '2026-11-10T00:00:00' }, expandRecurrences: true,
    }, 'q']])).methodResponses[0];
    expect(expanded.canCalculateChanges).toBe(false);
    await s.server.request([['CalendarEvent/set', { accountId: JMAP_ACCOUNT, update: { [expanded.ids[0]]: { title: 'One off' } } }, 'u']]);
    await s.engine.requestSync();
    expect(s.db.all('SELECT id FROM calendar_event').map((row) => row.id)).toEqual(['series']);
    expect(await getOne(s, 'series')).toMatchObject({
      recurrenceOverrides: { '2026-11-09T10:00:00': { title: 'One off' } },
    });
  });

  it('keeps old single events out and old series and tasks in, whatever their start', async () => {
    const s = setup();
    s.server.addEvent({ id: 'ancient', start: '2020-01-01T10:00:00' });
    s.server.addEvent({ id: 'recent', start: '2025-06-01T10:00:00' });
    s.server.addEvent({ id: 'future', start: '2040-01-01T10:00:00' });
    s.server.addEvent({ id: 'old-series', start: '2015-01-01T10:00:00', recurrenceRule: WEEKLY });
    s.server.addEvent({ id: 'old-task', '@type': 'Task', start: undefined, due: '2015-01-01T10:00:00' });
    await s.engine.requestSync();
    expect(s.db.all('SELECT id FROM calendar_event ORDER BY id').map((row) => row.id))
      .toEqual(['future', 'old-series', 'old-task', 'recent']);
  });

  it('starts over when the log is gone, and drops what the server no longer has', async () => {
    const s = setup();
    s.server.addEvent({ id: 'stays' });
    s.server.addEvent({ id: 'goes' });
    await s.engine.requestSync();
    s.server.events.delete('goes');
    s.server.eventLog.push('destroyed', 'goes');
    s.server.eventLog.truncatedBelow = s.server.eventLog.log.length;
    await s.engine.requestSync();
    expect(s.db.all('SELECT id FROM calendar_event').map((row) => row.id)).toEqual(['stays']);
  });

  it('keeps ids of two JMAP accounts apart', async () => {
    const s = setup();
    s.db.run(
      "INSERT INTO calendar_event (jmap, id, json) VALUES ('other', 'same', ?)",
      [JSON.stringify({ id: 'same', title: 'Theirs', start: '2026-11-10T10:00:00' })],
    );
    s.server.addEvent({ id: 'same', title: 'Mine' });
    await s.engine.requestSync();
    expect((await getOne(s, 'same'))?.title).toBe('Mine');
    const row = s.db.get<{ json: string }>("SELECT json FROM calendar_event WHERE jmap = 'other' AND id = 'same'");
    expect(JSON.parse(row!.json).title).toBe('Theirs');
  });

  it('stores calendars and participant identities and answers them with the real state', async () => {
    const s = setup();
    await s.engine.requestSync();
    const [, calendars] = await call(s, 'Calendar/get', { properties: ['id', 'name'] });
    expect(calendars.list).toEqual([{ id: 'cal1', name: 'Personal' }]);
    expect(calendars.state).toBe('cs1');
    const [, identities] = await call(s, 'ParticipantIdentity/get', {});
    expect(identities.list[0].calendarAddress).toBe('mailto:a@example.org');
  });

  it('refuses to read before anything was kept, instead of saying there is nothing', async () => {
    const s = setup();
    const [name, result] = await call(s, 'CalendarEvent/query', {});
    expect(name).toBe('error');
    expect(result.type).toBe('serverUnavailable');
    expect((await call(s, 'Calendar/get', {}))[0]).toBe('error');
  });
});

describe('queries from the store', () => {
  async function seeded() {
    const s = setup();
    s.server.addEvent({ id: 'late', title: 'Late meeting', start: '2026-11-10T23:30:00', duration: 'PT1H', timeZone: 'Europe/Berlin' });
    s.server.addEvent({
      id: 'lunch',
      title: 'Lünch with Bob',
      description: 'Bring the slides',
      start: '2026-11-11T12:00:00',
      calendarIds: { cal2: true },
      locations: { l: { '@type': 'Location', name: 'Room Seven' } },
      organizerCalendarAddress: 'mailto:owner@example.org',
      participants: {
        p1: { '@type': 'Participant', name: 'Bob', calendarAddress: 'mailto:bob@example.org', roles: { attendee: true }, participationStatus: 'accepted' },
        p2: { '@type': 'Participant', name: 'Olga', calendarAddress: 'mailto:olga@example.org', roles: { owner: true }, participationStatus: 'declined' },
      },
    });
    s.server.addEvent({ id: 'series', title: 'Weekly', start: '2026-01-05T10:00:00', recurrenceRule: WEEKLY });
    s.server.addEvent({ id: 'ended', title: 'Ended', start: '2026-01-05T10:00:00', recurrenceRule: { ...WEEKLY, count: 2 } });
    s.server.addEvent({ id: 'task', '@type': 'Task', title: 'Task', start: undefined, due: '2026-11-12T10:00:00' });
    await s.engine.requestSync();
    return s;
  }

  const ids = async (s: Setup, filter: unknown, extra: Record<string, unknown> = {}) => (await queryIds(s, { filter, ...extra })).sort();

  it('answers each filter the client can send', async () => {
    const s = await seeded();
    expect(await ids(s, { inCalendar: 'cal2' })).toEqual(['lunch']);
    expect(await ids(s, { inCalendars: ['cal2', 'nope'] })).toEqual(['lunch']);
    expect(await ids(s, { title: 'lunch' })).toEqual(['lunch']);
    expect(await ids(s, { description: 'slides' })).toEqual(['lunch']);
    expect(await ids(s, { location: 'seven' })).toEqual(['lunch']);
    expect(await ids(s, { owner: 'olga' })).toEqual(['lunch']);
    expect(await ids(s, { owner: 'bob' })).toEqual([]);
    expect(await ids(s, { attendee: 'bob' })).toEqual(['lunch']);
    expect(await ids(s, { attendee: 'olga' })).toEqual([]);
    expect(await ids(s, { participationStatus: 'declined' })).toEqual(['lunch']);
    expect(await ids(s, { attendee: 'bob', participationStatus: 'declined' })).toEqual([]);
    expect(await ids(s, { uid: 'lunch@example.org' })).toEqual(['lunch']);
    expect(await ids(s, { uid: 'LUNCH@example.org' })).toEqual([]);
    expect(await ids(s, { types: ['Task'] })).toEqual(['task']);
    expect(await ids(s, { text: 'BOB' })).toEqual(['lunch']);
    expect(await ids(s, { text: 'lunch bob' })).toEqual(['lunch']);
    expect(await ids(s, { text: 'lunch nothing' })).toEqual([]);
  });

  it('answers operators', async () => {
    const s = await seeded();
    expect(await ids(s, { operator: 'OR', conditions: [{ uid: 'late@example.org' }, { uid: 'task@example.org' }] })).toEqual(['late', 'task']);
    expect(await ids(s, { operator: 'AND', conditions: [{ text: 'bob' }, { inCalendar: 'cal2' }] })).toEqual(['lunch']);
    expect(await ids(s, { operator: 'NOT', conditions: [{ title: 'weekly' }, { title: 'ended' }, { title: 'late' }, { types: ['Task'] }] })).toEqual(['lunch']);
  });

  it('gives a per-call error for a filter it does not know', async () => {
    const s = await seeded();
    const [name, result] = await call(s, 'CalendarEvent/query', { filter: { nonsense: 1 } });
    expect(name).toBe('error');
    expect(result.type).toBe('unsupportedFilter');
  });

  it('reads bounds as wall clock in the request zone', async () => {
    const s = await seeded();
    // 23:30 in Berlin on the 10th is 17:30 in New York, and 22:30 UTC.
    const day10 = { after: '2026-11-10T00:00:00', before: '2026-11-11T00:00:00' };
    expect(await ids(s, day10, { timeZone: 'Europe/Berlin' })).toContain('late');
    const night = { after: '2026-11-10T22:45:00', before: '2026-11-10T23:00:00' };
    expect(await ids(s, night, { timeZone: 'Europe/Berlin' })).not.toContain('late');
    expect(await ids(s, night)).toContain('late');
    // A Z says nothing: Stalwart drops it and reads the wall clock.
    expect(await ids(s, { after: '2026-11-10T22:45:00Z', before: '2026-11-10T23:00:00Z' }, { timeZone: 'Europe/Berlin' })).not.toContain('late');
    expect(await ids(s, { after: '2026-11-10T17:00:00', before: '2026-11-10T18:00:00' }, { timeZone: 'America/New_York' })).toContain('late');
  });

  it('matches a series by any occurrence, once, and not when it has none in range', async () => {
    const s = await seeded();
    const later = { after: '2026-11-16T00:00:00', before: '2026-11-17T00:00:00' };
    expect(await ids(s, later)).toEqual(['series']);
    const bare = { operator: 'AND', conditions: [{ after: later.after }, { before: later.before }] };
    expect(await ids(s, bare)).toEqual(['series']);
    // `ended` has two occurrences in January and none after.
    expect(await ids(s, { after: '2026-01-05T00:00:00', before: '2026-01-06T00:00:00' })).toEqual(['ended', 'series']);
    expect(await ids(s, { after: '2026-02-02T00:00:00', before: '2026-02-03T00:00:00' })).toEqual(['series']);
  });

  it('sorts, pages and counts', async () => {
    const s = await seeded();
    const sort = [{ property: 'start', isAscending: false }];
    const [, first] = await call(s, 'CalendarEvent/query', { filter: { types: ['Event'] }, sort, limit: 2, calculateTotal: true });
    expect(first.ids).toEqual(['lunch', 'late']);
    expect(first.total).toBe(4);
    const [, second] = await call(s, 'CalendarEvent/query', { filter: { types: ['Event'] }, sort, limit: 2, position: 2 });
    expect(second.ids.sort()).toEqual(['ended', 'series']);
    expect(first.canCalculateChanges).toBe(false);
  });

  it('returns utcStart for the request zone, and reads a floating event in it', async () => {
    const s = setup();
    s.server.addEvent({ id: 'floating', start: '2026-11-10T10:00:00', timeZone: null, duration: 'PT1H' });
    s.server.addEvent({ id: 'zoned', start: '2026-11-10T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT1H' });
    await s.engine.requestSync();
    expect(await getOne(s, 'floating', ['utcStart', 'utcEnd'], 'America/New_York')).toEqual({
      id: 'floating', utcStart: '2026-11-10T15:00:00Z', utcEnd: '2026-11-10T16:00:00Z',
    });
    expect((await getOne(s, 'zoned', ['utcStart'], 'America/New_York'))?.utcStart).toBe('2026-11-10T09:00:00Z');
  });

  it('answers the task list like the client reads it', async () => {
    const s = await seeded();
    const list = await ids(s, undefined, { limit: 1000 });
    expect(list).toContain('task');
    const task = await getOne(s, 'task', ['id', '@type', 'due', 'progress', 'title']);
    expect(task).toMatchObject({ '@type': 'Task', due: '2026-11-12T10:00:00', title: 'Task' });
  });

  it('answers notifications with nothing rather than failing', async () => {
    const s = await seeded();
    const response = await s.engine.answer([
      ['CalendarEventNotification/query', { accountId: JMAP_ACCOUNT, sort: [] }, '0'],
      ['CalendarEventNotification/get', { accountId: JMAP_ACCOUNT, '#ids': { resultOf: '0', name: 'CalendarEventNotification/query', path: '/ids' } }, '1'],
    ]);
    expect(response!.methodResponses[1][1].list).toEqual([]);
  });

  it('refuses an expanded query without both bounds, as both servers do', async () => {
    const s = await seeded();
    const [name, result] = await call(s, 'CalendarEvent/query', { filter: { after: '2026-11-16T00:00:00' }, expandRecurrences: true });
    expect(name).toBe('error');
    expect(result.type).toBe('invalidArguments');
  });
});

describe('writes while offline', () => {
  async function synced(version: StalwartVersion = '1.0') {
    const s = setup(version);
    s.server.addEvent({
      id: 'e1',
      title: 'Meeting',
      participants: {
        me: { '@type': 'Participant', calendarAddress: 'mailto:a@example.org', participationStatus: 'needs-action', roles: { attendee: true } },
        bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.org', participationStatus: 'accepted', roles: { attendee: true } },
      },
    });
    await s.engine.requestSync();
    s.server.calls.length = 0;
    return s;
  }

  it('merges edits of one event into one patch, and shows them at once', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'First' } } });
    await setEvent(s, { update: { e1: { description: 'Added' } } });
    await setEvent(s, { update: { e1: { title: 'Second' } } });
    expect(pendingRows(s)).toHaveLength(1);
    expect(await getOne(s, 'e1')).toMatchObject({ title: 'Second', description: 'Added' });

    await flush(s);
    const sent = setCalls(s.server);
    expect(sent).toHaveLength(1);
    expect((sent[0][1].update as Record<string, unknown>).e1).toEqual({ title: 'Second', description: 'Added' });
    expect(s.server.events.get('e1')).toMatchObject({ title: 'Second', description: 'Added' });
    expect(pendingRows(s)).toEqual([]);
  });

  it('merges a pointer into a value set whole, and a whole value over pointers beneath it', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { locations: { a: { name: 'One' } } } } });
    await setEvent(s, { update: { e1: { 'locations/b': { name: 'Two' } } } });
    expect(JSON.parse(pendingRows(s)[0].patch)).toEqual({ locations: { a: { name: 'One' }, b: { name: 'Two' } } });

    const other = await synced();
    await setEvent(other, { update: { e1: { 'participants/me/participationStatus': 'accepted' } } });
    await setEvent(other, { update: { e1: { participants: { only: { name: 'Solo' } } } } });
    expect(JSON.parse(pendingRows(other)[0].patch)).toEqual({ participants: { only: { name: 'Solo' } } });
  });

  it('queues an RSVP as a participant patch and sends it with scheduling on', async () => {
    const s = await synced();
    const answer = await setEvent(s, {
      update: { e1: { 'participants/me/participationStatus': 'accepted' } },
      sendSchedulingMessages: true,
    });
    expect(answer.updated).toEqual({ e1: null });
    expect(s.server.events.get('e1')?.participants).toMatchObject({ me: { participationStatus: 'needs-action' } });
    const shown = await getOne(s, 'e1') as { participants: Record<string, { participationStatus: string }> };
    expect(shown.participants.me.participationStatus).toBe('accepted');
    expect(shown.participants.bob.participationStatus).toBe('accepted');

    await flush(s);
    const [, args] = setCalls(s.server)[0];
    expect(args.sendSchedulingMessages).toBe(true);
    expect(args.update).toEqual({ e1: { 'participants/me/participationStatus': 'accepted' } });
    expect(s.server.events.get('e1')?.participants).toMatchObject({ me: { participationStatus: 'accepted' }, bob: { participationStatus: 'accepted' } });
  });

  it('keeps scheduling on when a later edit does not ask for it', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { 'participants/me/participationStatus': 'accepted' } }, sendSchedulingMessages: true });
    await setEvent(s, { update: { e1: { description: 'Note' } }, sendSchedulingMessages: false });
    await flush(s);
    expect(setCalls(s.server)[0][1].sendSchedulingMessages).toBe(true);
  });

  it('survives a sync while pending: the server copy moves on underneath, the edit stays on top', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Mine' } } });
    s.server.patchEvent('e1', { description: 'Theirs' });
    // The delta gets through, the write doesn't.
    const realRequest = s.server.request.bind(s.server);
    let refuseWrites = true;
    s.server.request = async (calls: MethodCall[]) => {
      if (refuseWrites && calls.some(([name, args]) => name === 'CalendarEvent/set' && args.update && 'e1' in (args.update as object))) {
        throw new TransportError('network', 'Failed to fetch');
      }
      return realRequest(calls);
    };
    await s.engine.requestSync();
    expect(pendingRows(s)).toHaveLength(1);
    expect(s.server.events.get('e1')).toMatchObject({ title: 'Meeting', description: 'Theirs' });
    expect(await getOne(s, 'e1')).toMatchObject({ title: 'Mine', description: 'Theirs' });

    refuseWrites = false;
    await s.engine.requestSync();
    expect(await conflicts(s)).toEqual([]);
    expect(s.server.events.get('e1')).toMatchObject({ title: 'Mine', description: 'Theirs' });
    expect(await getOne(s, 'e1')).toMatchObject({ title: 'Mine', description: 'Theirs' });
  });

  it('sends an edit that came in during a send, and takes its own first write for its own', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'One' } } });
    const realRequest = s.server.request.bind(s.server);
    let once = true;
    s.server.request = async (calls: MethodCall[]) => {
      const response = await realRequest(calls);
      if (once && calls.some(([name]) => name === 'CalendarEvent/set')) {
        once = false;
        await setEvent(s, { update: { e1: { title: 'Two', description: 'During' } } });
      }
      return response;
    };
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
    expect(s.server.events.get('e1')).toMatchObject({ title: 'Two', description: 'During' });
    expect(pendingRows(s)).toEqual([]);
  });

  it('does not take an edit whose answer got lost for a conflict when it comes back through sync', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Sent once' } } });
    s.server.loseNextSetResponse = true;
    expect(await flush(s)).toMatchObject({ sent: 0, pending: 1 });
    expect(s.server.events.get('e1')?.title).toBe('Sent once');
    expect(await flush(s)).toMatchObject({ sent: 1, pending: 0 });
    expect(await conflicts(s)).toEqual([]);
  });

  it('gives out a stand-in id on create that later edits and deletes can use', async () => {
    const s = await synced();
    const result = await setEvent(s, { create: { 'new-event': { title: 'Fresh', calendarIds: { cal1: true }, start: '2026-11-20T09:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin' } } });
    const id = result.created['new-event'].id as string;
    expect(await getOne(s, id, ['title', 'utcStart', 'uid'])).toMatchObject({ title: 'Fresh', utcStart: '2026-11-20T08:00:00Z' });
    expect(await queryIds(s, { filter: { after: '2026-11-20T00:00:00', before: '2026-11-21T00:00:00' } })).toEqual([id]);

    await setEvent(s, { update: { [id]: { title: 'Fresher', 'locations/a': { name: 'Here' } } } });
    expect(pendingRows(s)).toHaveLength(1);
    expect(pendingRows(s)[0].kind).toBe('create');
    expect(await getOne(s, id)).toMatchObject({ title: 'Fresher', locations: { a: { name: 'Here' } } });

    await flush(s);
    const creates = setCalls(s.server).filter(([, args]) => args.create);
    expect(creates).toHaveLength(1);
    expect(s.server.events.size).toBe(2);
    const onServer = [...s.server.events.values()].find((event) => event.title === 'Fresher');
    expect(onServer?.locations).toEqual({ a: { name: 'Here' } });
    expect(await getOne(s, id)).toMatchObject({ id: onServer?.id, title: 'Fresher' });
    expect(s.db.get('SELECT 1 AS x FROM calendar_event WHERE id = ?', [id])).toBeUndefined();
  });

  it('sends nothing for a create deleted again before it left', async () => {
    const s = await synced();
    const result = await setEvent(s, { create: { c: { title: 'Gone', start: '2026-11-20T09:00:00', calendarIds: { cal1: true } } } });
    const id = result.created.c.id as string;
    const gone = await setEvent(s, { destroy: [id] });
    expect(gone.destroyed).toEqual([id]);
    expect(await getOne(s, id)).toBeUndefined();
    await flush(s);
    expect(setCalls(s.server)).toEqual([]);
    expect(s.server.events.size).toBe(1);
  });

  it('sends an edit then delete as just the delete, and hides it meanwhile', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Doomed' } } });
    await setEvent(s, { destroy: ['e1'] });
    expect(pendingRows(s)[0].kind).toBe('destroy');
    expect(await getOne(s, 'e1')).toBeUndefined();
    expect(await queryIds(s, {})).toEqual([]);
    await flush(s);
    expect(setCalls(s.server).map(([, args]) => args.destroy)).toEqual([['e1']]);
    expect(s.server.events.has('e1')).toBe(false);
    expect(s.db.get('SELECT 1 AS x FROM calendar_event WHERE id = ?', ['e1'])).toBeUndefined();
  });

  it('takes a delete of an event already gone as done', async () => {
    const s = await synced();
    await setEvent(s, { destroy: ['e1'] });
    s.server.removeEvent('e1');
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
    expect(pendingRows(s)).toEqual([]);
  });

  it('keeps writes across a run without a network and sends them after', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Later' } } });
    s.server.offline = true;
    const offline = await flush(s);
    expect(offline).toMatchObject({ sent: 0, pending: 1 });
    expect(await getOne(s, 'e1')).toMatchObject({ title: 'Later' });
    s.server.offline = false;
    expect(await flush(s)).toMatchObject({ sent: 1, pending: 0 });
    expect(s.server.events.get('e1')?.title).toBe('Later');
  });

  it('flushes during a normal sync pass too', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'By sync' } } });
    await s.engine.requestSync();
    expect(s.server.events.get('e1')?.title).toBe('By sync');
    expect(pendingRows(s)).toEqual([]);
  });

  it('tells the page something changed', async () => {
    const s = await synced();
    s.events.length = 0;
    await setEvent(s, { update: { e1: { title: 'x' } } });
    expect(s.events).toContainEqual({ type: 'changed', account: 'a@fake.test', collections: ['CalendarEvent'] });
  });
});

describe('a create and a lost response', () => {
  const NEW = { title: 'Once', calendarIds: { cal1: true }, start: '2026-11-20T09:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin' };

  async function queued() {
    const s = setup();
    await s.engine.requestSync();
    s.server.calls.length = 0;
    const result = await setEvent(s, { create: { c: NEW } });
    return { s, id: result.created.c.id as string, uid: result.created.c.uid as string };
  }

  it('gives the event a uid of its own before it goes out', async () => {
    const { s, uid } = await queued();
    expect(uid).toBeTruthy();
    await flush(s);
    expect([...s.server.events.values()][0].uid).toBe(uid);
  });

  it('keeps a uid the client chose', async () => {
    const s = setup();
    await s.engine.requestSync();
    const result = await setEvent(s, { create: { c: { ...NEW, uid: 'mine@example.org' } } });
    expect(result.created.c.uid).toBe('mine@example.org');
  });

  it('finds the event by uid instead of creating it again', async () => {
    const { s, id, uid } = await queued();
    s.server.loseNextSetResponse = true;
    expect(await flush(s)).toMatchObject({ sent: 0, pending: 1 });
    expect(s.server.events.size).toBe(1);

    expect(await flush(s)).toMatchObject({ sent: 1, pending: 0 });
    expect(s.server.events.size).toBe(1);
    expect(setCalls(s.server).filter(([, args]) => args.create)).toHaveLength(1);
    expect(s.server.calls.some(([name, args]) => name === 'CalendarEvent/query' && (args.filter as { uid?: string })?.uid === uid)).toBe(true);
    const real = [...s.server.events.keys()][0];
    expect(await queryIds(s, {})).toEqual([real]);
    expect(await getOne(s, id)).toMatchObject({ id: real });
    expect(await conflicts(s)).toEqual([]);
  });

  it('shows one event when a sync finds the created event before the flush does', async () => {
    const { s } = await queued();
    s.server.loseNextSetResponse = true;
    await flush(s);
    await s.engine.requestSync();
    expect((await queryIds(s, {}))).toHaveLength(1);
    expect(s.server.events.size).toBe(1);
  });

  it('creates it after all when the request never reached the server', async () => {
    const { s } = await queued();
    // The attempt is marked, the network drops before it arrives.
    const realRequest = s.server.request.bind(s.server);
    let dropped = false;
    s.server.request = async (calls: MethodCall[]) => {
      if (!dropped && calls.some(([name, args]) => name === 'CalendarEvent/set' && args.create)) {
        dropped = true;
        throw new TransportError('network', 'Failed to fetch');
      }
      return realRequest(calls);
    };
    await flush(s);
    expect(s.server.events.size).toBe(0);
    expect(await flush(s)).toMatchObject({ sent: 1, pending: 0 });
    expect(s.server.events.size).toBe(1);
  });

  it('treats the uid refusal as "it exists already", should the mark have been lost', async () => {
    const { s, uid } = await queued();
    s.db.run('UPDATE calendar_pending SET attempted = 0');
    s.server.addEvent({ ...NEW, uid, id: 'already' });
    await flush(s);
    expect(s.server.events.size).toBe(1);
    expect(await conflicts(s)).toEqual([]);
    expect(await queryIds(s, {})).toEqual(['already']);
  });

  it('follows a create with its delete when it went out before the delete came', async () => {
    const { s, id } = await queued();
    s.server.loseNextSetResponse = true;
    await flush(s);
    expect(s.server.events.size).toBe(1);
    await setEvent(s, { destroy: [id] });
    expect(await queryIds(s, {})).toEqual([]);
    await flush(s);
    expect(s.server.events.size).toBe(0);
    expect(pendingRows(s)).toEqual([]);
  });

  it('applies a write that came in during the send as a write of its own', async () => {
    const { s, id } = await queued();
    const realRequest = s.server.request.bind(s.server);
    s.server.request = async (calls: MethodCall[]) => {
      const response = await realRequest(calls);
      if (calls.some(([name, args]) => name === 'CalendarEvent/set' && args.create)) {
        await setEvent(s, { update: { [id]: { title: 'Changed meanwhile' } } });
      }
      return response;
    };
    await flush(s);
    expect([...s.server.events.values()][0].title).toBe('Changed meanwhile');
    expect(pendingRows(s)).toEqual([]);
  });
});

describe('conflicts', () => {
  async function synced(version: StalwartVersion = '1.0') {
    const s = setup(version);
    s.server.addEvent({ id: 'e1', title: 'Meeting', recurrenceRule: WEEKLY });
    await s.engine.requestSync();
    s.server.calls.length = 0;
    return s;
  }

  it('lists a patch on a value the server changed too, and does not send it', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Mine' } } });
    s.server.patchEvent('e1', { title: 'Theirs' });
    const result = await flush(s);
    expect(setCalls(s.server)).toEqual([]);
    expect(result).toMatchObject({ sent: 0, pending: 0 });
    const [conflict] = await conflicts(s);
    expect(conflict).toMatchObject({ recordId: 'e1', kind: 'update', reason: 'changedOnServer', local: { title: 'Mine' } });
    expect(conflict.server).toMatchObject({ title: 'Theirs' });
    expect(s.server.events.get('e1')?.title).toBe('Theirs');
    expect(await getOne(s, 'e1')).toMatchObject({ title: 'Theirs' });
  });

  it('lets an edit through when the server changed something else', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Mine' } } });
    s.server.patchEvent('e1', { description: 'Theirs' });
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
    expect(s.server.events.get('e1')).toMatchObject({ title: 'Mine', description: 'Theirs' });
  });

  it('does not take the same value on both sides for a conflict', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Same' } } });
    s.server.patchEvent('e1', { title: 'Same' });
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
  });

  it('lets an RSVP through when the organizer changed the title', async () => {
    const s = setup();
    s.server.addEvent({ id: 'e1', participants: { me: { participationStatus: 'needs-action' } } });
    await s.engine.requestSync();
    await setEvent(s, { update: { e1: { 'participants/me/participationStatus': 'accepted' } } });
    s.server.patchEvent('e1', { title: 'New title' });
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
    expect(s.server.events.get('e1')).toMatchObject({ title: 'New title', participants: { me: { participationStatus: 'accepted' } } });
  });

  it('lists a patch the server refuses, with its reason, and goes on with the others', async () => {
    const s = await synced();
    s.server.addEvent({ id: 'e2', title: 'Other' });
    await s.engine.requestSync();
    await setEvent(s, { update: { e1: { title: 'Refused' } } });
    await setEvent(s, { update: { e2: { title: 'Fine' } } });
    s.server.refuse.e1 = { type: 'forbidden', description: 'No rights' };
    const result = await flush(s);
    expect(result).toMatchObject({ sent: 1, conflicts: 1, pending: 0 });
    const [conflict] = await conflicts(s);
    expect(conflict).toMatchObject({ recordId: 'e1', reason: 'refused', errorType: 'forbidden', description: 'No rights', local: { title: 'Refused' } });
    expect(await getOne(s, 'e1')).toMatchObject({ title: 'Meeting' });
    expect(s.server.events.get('e2')?.title).toBe('Fine');
  });

  it('lists an edit of an event the server deleted, and drops the event', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Too late' } } });
    s.server.removeEvent('e1');
    await flush(s);
    const [conflict] = await conflicts(s);
    expect(conflict).toMatchObject({ reason: 'destroyedOnServer', local: { title: 'Too late' }, server: null });
    expect(await getOne(s, 'e1')).toBeUndefined();
  });

  it('lists a delete of an event the server changed, and brings the event back', async () => {
    const s = await synced();
    await setEvent(s, { destroy: ['e1'] });
    s.server.patchEvent('e1', { title: 'Still wanted' });
    await flush(s);
    expect(s.server.events.has('e1')).toBe(true);
    expect((await conflicts(s))[0]).toMatchObject({ kind: 'destroy', reason: 'changedOnServer' });
    expect(await getOne(s, 'e1')).toMatchObject({ title: 'Still wanted' });
  });

  it('lists a create the server refuses and takes the stand-in away', async () => {
    const s = await synced();
    const result = await setEvent(s, { create: { c: { title: 'Bad', calendarIds: { nope: true }, start: '2026-11-20T09:00:00' } } });
    s.server.refuse.c = { type: 'invalidProperties', description: 'calendarIds', properties: ['calendarIds'] };
    await flush(s);
    const [conflict] = await conflicts(s);
    expect(conflict).toMatchObject({ kind: 'create', reason: 'refused', local: { title: 'Bad' } });
    expect(await getOne(s, result.created.c.id)).toBeUndefined();
    expect(pendingRows(s)).toEqual([]);
  });

  it('retries without series keys when 1.0 refuses them inside an override, instead of a conflict', async () => {
    const s = setup('1.0');
    s.server.addEvent({ id: 'e1', recurrenceRule: WEEKLY, privacy: 'private' });
    await s.engine.requestSync();
    s.server.calls.length = 0;
    await setEvent(s, { update: { e1: { recurrenceOverrides: { '2026-11-17T10:00:00': { title: 'One', privacy: 'private' } } } } });
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
    expect(setCalls(s.server)).toHaveLength(2);
    expect(s.server.events.get('e1')?.recurrenceOverrides).toEqual({ '2026-11-17T10:00:00': { title: 'One' } });
  });

  it('keeps a write for later when the server has a bad moment', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Soon' } } });
    const realRequest = s.server.request.bind(s.server);
    let failed = false;
    s.server.request = async (calls: MethodCall[]) => {
      if (!failed && calls.some(([name]) => name === 'CalendarEvent/set')) {
        failed = true;
        return { methodResponses: [['error', { type: 'serverFail' }, 's']] };
      }
      return realRequest(calls);
    };
    expect(await flush(s)).toMatchObject({ sent: 0, conflicts: 0, pending: 1 });
    expect(await conflicts(s)).toEqual([]);
    expect(await flush(s)).toMatchObject({ sent: 1, pending: 0 });
  });

  it('lists a method error that means the write will not work', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'x' } } });
    const realRequest = s.server.request.bind(s.server);
    s.server.request = async (calls: MethodCall[]) => {
      if (calls.some(([name]) => name === 'CalendarEvent/set')) return { methodResponses: [['error', { type: 'accountReadOnly' }, 's']] };
      return realRequest(calls);
    };
    expect(await flush(s)).toMatchObject({ conflicts: 1, pending: 0 });
    expect((await conflicts(s))[0].errorType).toBe('accountReadOnly');
  });

  it('can dismiss a conflict', async () => {
    const s = await synced();
    await setEvent(s, { update: { e1: { title: 'Mine' } } });
    s.server.patchEvent('e1', { title: 'Theirs' });
    await flush(s);
    const [conflict] = await conflicts(s);
    await s.engine.areaCall('calendar.dismissConflict', { id: conflict.id });
    expect(await conflicts(s)).toEqual([]);
  });

  it('keeps a pending edit through a resync, and lists it when the event is gone', async () => {
    const s = await synced();
    s.server.addEvent({ id: 'e2', title: 'Stays' });
    await s.engine.requestSync();
    await setEvent(s, { update: { e1: { title: 'Mine' } } });
    await setEvent(s, { update: { e2: { title: 'Mine too' } } });
    s.server.events.delete('e1');
    s.server.eventLog.push('destroyed', 'e1');
    s.server.eventLog.truncatedBelow = s.server.eventLog.log.length;
    await s.engine.requestSync();
    const [conflict] = await conflicts(s);
    expect(conflict).toMatchObject({ recordId: 'e1', reason: 'destroyedOnServer' });
    expect(s.server.events.get('e2')?.title).toBe('Mine too');
  });
});

describe('the synthetic-id probe', () => {
  const probe = { update: { h333333: {} } };

  it('tells a client what the server said at the last sync', async () => {
    for (const version of ['1.0', '0.16'] as const) {
      const s = setup(version);
      await s.engine.requestSync();
      expect((await setEvent(s, probe)).notUpdated.h333333.type).toBe('notFound');
    }
    const old = setup('0.16.19');
    await old.engine.requestSync();
    const refusal = (await setEvent(old, probe)).notUpdated.h333333;
    expect(refusal.type).toBe('invalidProperties');
    expect(refusal.description).toMatch(/synthetic ids is not yet supported/);
  });

  it('says not supported before any sync, because client-side expansion works on every server', async () => {
    const s = setup();
    const refusal = (await setEvent(s, probe)).notUpdated.h333333;
    expect(refusal.type).toBe('invalidProperties');
  });

  it('queues nothing for the probe', async () => {
    const s = setup();
    await s.engine.requestSync();
    await setEvent(s, probe);
    expect(pendingRows(s)).toEqual([]);
  });

  it('runs the probe on the sync request, and follows a server that was upgraded', async () => {
    const s = setup('0.16.19');
    await s.engine.requestSync();
    expect(s.server.requests).toBeGreaterThan(0);
    expect((await setEvent(s, probe)).notUpdated.h333333.type).toBe('invalidProperties');
    Object.defineProperty(s.server, 'version', { value: '1.0' });
    await s.engine.requestSync();
    expect((await setEvent(s, probe)).notUpdated.h333333.type).toBe('notFound');
  });
});

describe('occurrence writes for ids the store does not hold', () => {
  it('refuses them the way an old server does, so the client writes on the base event', async () => {
    const s = setup();
    s.server.addEvent({ id: 'series', recurrenceRule: WEEKLY });
    await s.engine.requestSync();
    const update = await setEvent(s, { update: { h20261110series: { title: 'x' } } });
    expect(update.notUpdated.h20261110series.description).toMatch(/synthetic ids?\b.*\bnot (?:yet )?supported/i);
    const destroy = await setEvent(s, { destroy: ['h20261110series'] });
    expect(destroy.notDestroyed.h20261110series.description).toMatch(/synthetic ids?\b.*\bnot (?:yet )?supported/i);
    expect(pendingRows(s)).toEqual([]);
  });
});

describe('reminders from stored events', () => {
  const ALERT = { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } };
  const FROM = Date.UTC(2026, 10, 10);
  const TO = Date.UTC(2026, 10, 11);
  const OPTIONS = { from: FROM, to: TO, timeZone: 'Europe/Berlin' };

  it('lists an occurrence of a series, keyed by the master, with the time from its own zone', async () => {
    const s = setup();
    s.server.addEvent({ id: 'series', start: '2026-01-06T10:00:00', recurrenceRule: WEEKLY, alerts: { a: ALERT } });
    await s.engine.requestSync();
    const alerts = listUpcomingAlerts(s.db, OPTIONS);
    expect(alerts).toHaveLength(1);
    const fire = Date.UTC(2026, 10, 10, 8, 45);
    expect(alerts[0]).toMatchObject({
      baseEventId: 'series', alertId: 'a', fireTimeMs: fire, recurrenceId: '2026-11-10T10:00:00', key: `series:a:${fire}`, kind: 'event', jmap: JMAP_ACCOUNT,
    });
  });

  it('follows a moved occurrence and skips an excluded one', async () => {
    const s = setup();
    s.server.addEvent({
      id: 'moved',
      start: '2026-01-06T10:00:00',
      recurrenceRule: WEEKLY,
      alerts: { a: ALERT },
      recurrenceOverrides: { '2026-11-10T10:00:00': { start: '2026-11-10T15:00:00' } },
    });
    s.server.addEvent({
      id: 'excluded',
      start: '2026-01-06T10:00:00',
      recurrenceRule: WEEKLY,
      alerts: { a: ALERT },
      recurrenceOverrides: { '2026-11-10T10:00:00': { excluded: true } },
    });
    await s.engine.requestSync();
    const alerts = listUpcomingAlerts(s.db, OPTIONS);
    expect(alerts.map((alert) => [alert.baseEventId, alert.fireTimeMs])).toEqual([['moved', Date.UTC(2026, 10, 10, 13, 45)]]);
  });

  it('finds an alert days before its occurrence, and a fixed-time alert of a series', async () => {
    const s = setup();
    s.server.addEvent({
      id: 'days',
      start: '2026-11-13T10:00:00',
      alerts: { a: { ...ALERT, trigger: { '@type': 'OffsetTrigger', offset: '-P3D' } } },
    });
    s.server.addEvent({
      id: 'days-series',
      start: '2026-01-06T10:00:00',
      recurrenceRule: { frequency: 'yearly', byMonth: ['11'], byMonthDay: [13] },
      alerts: { a: { ...ALERT, trigger: { '@type': 'OffsetTrigger', offset: '-P3D' } } },
    });
    s.server.addEvent({
      id: 'fixed',
      start: '2026-01-06T10:00:00',
      recurrenceRule: WEEKLY,
      alerts: { a: { ...ALERT, trigger: { '@type': 'AbsoluteTrigger', when: '2026-11-10T06:00:00Z' } } },
    });
    await s.engine.requestSync();
    const alerts = listUpcomingAlerts(s.db, OPTIONS);
    expect(alerts.map((alert) => alert.baseEventId).sort()).toEqual(['days', 'days-series', 'fixed']);
    expect(alerts.filter((alert) => alert.baseEventId === 'fixed')).toHaveLength(1);
  });

  it('uses the calendar defaults while the event does, and reads a floating event in the given zone', async () => {
    const s = setup();
    s.server.addEvent({ id: 'def', start: '2026-11-10T10:00:00', timeZone: null, useDefaultAlerts: true });
    await s.engine.requestSync();
    const [alert] = listUpcomingAlerts(s.db, OPTIONS);
    expect(alert).toMatchObject({ baseEventId: 'def', alertId: 'd1', calendarName: 'Personal', fireTimeMs: Date.UTC(2026, 10, 10, 8, 45) });
    expect(listUpcomingAlerts(s.db, { ...OPTIONS, timeZone: 'UTC' })[0].fireTimeMs).toBe(Date.UTC(2026, 10, 10, 9, 45));
  });

  it('leaves out what should not fire, and what is outside the window', async () => {
    const s = setup();
    s.server.addEvent({ id: 'email', alerts: { a: { ...ALERT, action: 'email' } } });
    s.server.addEvent({ id: 'seen', alerts: { a: { ...ALERT, acknowledged: '2026-11-01T00:00:00Z' } } });
    s.server.addEvent({ id: 'off', status: 'cancelled', alerts: { a: ALERT } });
    s.server.addEvent({ id: 'later', start: '2026-12-10T10:00:00', alerts: { a: ALERT } });
    s.server.addEvent({ id: 'task-done', '@type': 'Task', start: undefined, due: '2026-11-10T10:00:00', progress: 'completed', alerts: { a: ALERT } });
    await s.engine.requestSync();
    expect(listUpcomingAlerts(s.db, OPTIONS)).toEqual([]);
  });

  it('lists a task, and an edit or a delete made offline', async () => {
    const s = setup();
    s.server.addEvent({ id: 'task', '@type': 'Task', start: undefined, due: '2026-11-10T10:00:00Z', alerts: { a: ALERT } });
    s.server.addEvent({ id: 'moved', start: '2026-12-10T10:00:00', alerts: { a: ALERT } });
    s.server.addEvent({ id: 'dropped', start: '2026-11-10T11:00:00', alerts: { a: ALERT } });
    await s.engine.requestSync();
    await setEvent(s, { update: { moved: { start: '2026-11-10T09:00:00' } } });
    await setEvent(s, { destroy: ['dropped'] });
    expect(listUpcomingAlerts(s.db, OPTIONS).map((alert) => [alert.baseEventId, alert.kind])).toEqual([['moved', 'event'], ['task', 'task']]);
  });
});

it('uses only capabilities the session lists', async () => {
  const s = setup();
  s.server.addEvent();
  const usings: string[][] = [];
  const realRequest = s.server.request.bind(s.server) as (calls: MethodCall[]) => ReturnType<FakeCalendarJmap['request']>;
  s.server.request = ((calls: MethodCall[], using: string[]) => {
    usings.push(using);
    return realRequest(calls);
  }) as FakeCalendarJmap['request'];
  await s.engine.requestSync();
  for (const using of usings) expect(using).toEqual(['urn:ietf:params:jmap:core', CAL]);
});
