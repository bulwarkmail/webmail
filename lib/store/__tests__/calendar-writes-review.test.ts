// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import type { CalendarEvent } from '@/lib/jmap/types';
import { DEFAULT_SCOPE } from '../area';
import { calendarArea } from '../calendar';
import { listUpcomingAlerts } from '../calendar/reminders';
import type { CalendarConflict } from '../calendar/writes';
import { AccountEngine } from '../engine/account-engine';
import { TransportError, type JmapResponse, type MethodCall, type StoreSession } from '../engine/transport';
import { wire, type Wire } from './helpers/client-wire';
import { CAL, CALENDAR_SESSION, FakeCalendarJmap, type StalwartVersion } from './helpers/fake-calendar';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const NOW = Date.UTC(2026, 10, 3, 12);
const WEEKLY = { '@type': 'RecurrenceRule', frequency: 'weekly' };
const K1 = '2026-11-17T10:00:00';
const K2 = '2026-11-24T10:00:00';

function setup(version: StalwartVersion = '1.0', session: StoreSession = CALENDAR_SESSION) {
  const server = new FakeCalendarJmap(version);
  const db = openMemoryStore();
  const engine = new AccountEngine({
    account: 'a@fake.test', db, session, transport: server, areas: [calendarArea], scope: DEFAULT_SCOPE, now: () => NOW, sleep: async () => {},
  });
  return { server, db, engine };
}
type Setup = ReturnType<typeof setup>;

async function write(s: Setup, args: Record<string, unknown>, jmap = JMAP_ACCOUNT) {
  const response = await s.engine.answer([['CalendarEvent/set', { accountId: jmap, ...args }, 'x']]);
  return response!.methodResponses[0][1];
}

async function read(s: Setup, id: string, properties?: string[]) {
  const response = await s.engine.answer([['CalendarEvent/get', { accountId: JMAP_ACCOUNT, ids: [id], ...(properties ? { properties } : {}) }, 'x']]);
  return response!.methodResponses[0][1].list[0] as Record<string, unknown> | undefined;
}

async function query(s: Setup, args: Record<string, unknown> = {}) {
  const response = await s.engine.answer([['CalendarEvent/query', { accountId: JMAP_ACCOUNT, ...args }, 'x']]);
  return response!.methodResponses[0][1].ids as string[];
}

const flush = (s: Pick<Setup, 'engine'>) => s.engine.areaCall('calendar.flush', undefined) as Promise<{ sent: number; conflicts: number; pending: number }>;
const conflicts = (s: Pick<Setup, 'engine'>) => s.engine.areaCall('calendar.conflicts', undefined) as Promise<CalendarConflict[]>;
const sets = (server: FakeCalendarJmap) => server.calls.filter(([name, args]) => name === 'CalendarEvent/set' && !(args.update && 'h333333' in (args.update as object)));
const pending = (s: Pick<Setup, 'db'>) => s.db.all<{ kind: string; patch: string; record_id: string; send_scheduling: number | null }>('SELECT kind, patch, record_id, send_scheduling FROM calendar_pending ORDER BY seq');
const NEW = { title: 'Fresh', calendarIds: { cal1: true }, start: '2026-11-20T09:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin' };

async function synced(version: StalwartVersion = '1.0', add?: (server: FakeCalendarJmap) => void) {
  const s = setup(version);
  s.server.addEvent({ id: 'e1', title: 'Meeting', description: 'Old' });
  add?.(s.server);
  await s.engine.requestSync();
  s.server.calls.length = 0;
  return s;
}

function failSets(s: Setup, decide: (args: Record<string, unknown>) => JmapResponse | Error | null) {
  const real = s.server.request.bind(s.server);
  s.server.request = async (calls: MethodCall[]) => {
    for (const [name, args] of calls) {
      if (name !== 'CalendarEvent/set' || (args.update && 'h333333' in (args.update as object))) continue;
      const outcome = decide(args);
      if (outcome instanceof Error) throw outcome;
      if (outcome) return outcome;
    }
    return real(calls);
  };
}

describe('an edit after a create whose answer got lost', () => {
  it('reaches the server as an update, without a second create', async () => {
    const s = await synced();
    const id = (await write(s, { create: { c: NEW } })).created.c.id as string;
    s.server.loseNextSetResponse = true;
    await flush(s);
    await write(s, { update: { [id]: { title: 'Edited after the attempt' } } });
    expect(await flush(s)).toMatchObject({ pending: 0 });
    expect(s.server.events.size).toBe(2);
    expect(sets(s.server).filter(([, args]) => args.create)).toHaveLength(1);
    const onServer = [...s.server.events.values()].find((event) => event.uid !== 'e1@example.org');
    expect(onServer?.title).toBe('Edited after the attempt');
    expect(await read(s, onServer!.id)).toMatchObject({ title: 'Edited after the attempt' });
  });

  it('also removes what the edit removed', async () => {
    const s = await synced();
    const id = (await write(s, { create: { c: { ...NEW, description: 'To go' } } })).created.c.id as string;
    s.server.loseNextSetResponse = true;
    await flush(s);
    await write(s, { update: { [id]: { description: null } } });
    await flush(s);
    const onServer = [...s.server.events.values()].find((event) => event.title === 'Fresh');
    expect(onServer?.description ?? null).toBeNull();
  });

  it('applies an import whose uid the server already has as an update', async () => {
    const s = await synced();
    await write(s, { create: { c: { ...NEW, uid: 'e1@example.org', title: 'Imported', description: 'Old' } } });
    await flush(s);
    expect(sets(s.server).filter(([, args]) => args.create)).toEqual([]);
    expect(s.server.events.size).toBe(1);
    expect(s.server.events.get('e1')).toMatchObject({ title: 'Imported', description: 'Old' });
    expect(await query(s)).toEqual(['e1']);
  });

  it('sends no update when the server already holds the same event', async () => {
    const s = await synced();
    const held = s.server.events.get('e1')!;
    await write(s, { create: { c: { uid: 'e1@example.org', title: held.title, calendarIds: held.calendarIds, start: held.start, duration: held.duration, timeZone: held.timeZone, '@type': 'Event' } } });
    await flush(s);
    expect(sets(s.server)).toEqual([]);
    expect(pending(s)).toEqual([]);
  });
});

describe('writes with different scheduling flags', () => {
  it('stay separate and go out in order', async () => {
    const s = await synced();
    await write(s, { update: { e1: { title: 'Quiet edit' } }, sendSchedulingMessages: false });
    await write(s, { update: { e1: { 'participants/me/participationStatus': 'accepted' } }, sendSchedulingMessages: true });
    expect(pending(s).map((row) => row.send_scheduling)).toEqual([0, 1]);
    expect(await read(s, 'e1')).toMatchObject({ title: 'Quiet edit', participants: { me: { participationStatus: 'accepted' } } });

    await flush(s);
    const sent = sets(s.server);
    expect(sent.map(([, args]) => args.sendSchedulingMessages)).toEqual([false, true]);
    expect((sent[0][1].update as Record<string, unknown>).e1).toEqual({ title: 'Quiet edit' });
    expect((sent[1][1].update as Record<string, unknown>).e1).toEqual({ 'participants/me/participationStatus': 'accepted' });
  });

  it('still merge when the flags are the same', async () => {
    const s = await synced();
    await write(s, { update: { e1: { title: 'One' } }, sendSchedulingMessages: true });
    await write(s, { update: { e1: { description: 'Two' } }, sendSchedulingMessages: true });
    expect(pending(s)).toHaveLength(1);
  });

  it('create and a later edit that notifies go out as two writes, the second under the real id', async () => {
    const s = await synced();
    const id = (await write(s, { create: { c: NEW }, sendSchedulingMessages: false })).created.c.id as string;
    await write(s, { update: { [id]: { title: 'Told everyone' } }, sendSchedulingMessages: true });
    expect(pending(s).map((row) => row.kind)).toEqual(['create', 'update']);
    await flush(s);
    const sent = sets(s.server);
    expect(sent).toHaveLength(2);
    expect(sent[0][1].sendSchedulingMessages).toBe(false);
    const real = Object.keys(sent[1][1].update as object)[0];
    expect(s.server.events.get(real)).toMatchObject({ title: 'Told everyone' });
    expect(sent[1][1].sendSchedulingMessages).toBe(true);
    expect(await flush(s)).toMatchObject({ pending: 0 });
  });

  it('a create deleted before it left takes its later rows with it', async () => {
    const s = await synced();
    const id = (await write(s, { create: { c: NEW }, sendSchedulingMessages: true })).created.c.id as string;
    await write(s, { update: { [id]: { title: 'Quiet' } }, sendSchedulingMessages: false });
    await write(s, { destroy: [id] });
    expect(pending(s)).toEqual([]);
    await flush(s);
    expect(sets(s.server)).toEqual([]);
  });

  it('a conflict on the first takes the ones built on it along', async () => {
    const s = await synced();
    await write(s, { update: { e1: { title: 'Mine' } }, sendSchedulingMessages: false });
    await write(s, { update: { e1: { description: 'Mine too' } }, sendSchedulingMessages: true });
    s.server.patchEvent('e1', { title: 'Theirs' });
    await flush(s);
    expect(sets(s.server)).toEqual([]);
    expect((await conflicts(s)).map((conflict) => conflict.local)).toEqual([{ title: 'Mine' }, { description: 'Mine too' }]);
    expect(await read(s, 'e1')).toMatchObject({ title: 'Theirs', description: 'Old' });
  });
});

describe('a whole recurrenceOverrides map from stale state', () => {
  const series = (server: FakeCalendarJmap) => server.addEvent({ id: 's', title: 'Weekly', start: '2026-11-03T10:00:00', recurrenceRule: WEEKLY });

  it('does not erase an override someone else added', async () => {
    const s = await synced('1.0', series);
    await write(s, { update: { s: { recurrenceOverrides: { [K1]: { title: 'Mine' } } } } });
    s.server.patchEvent('s', { recurrenceOverrides: { [K2]: { title: 'Theirs' } } });
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
    expect(s.server.events.get('s')?.recurrenceOverrides).toEqual({ [K1]: { title: 'Mine' }, [K2]: { title: 'Theirs' } });
  });

  it('goes out as a whole map only when the server has none', async () => {
    const s = await synced('1.0', series);
    await write(s, { update: { s: { recurrenceOverrides: { [K1]: { title: 'Mine' } } } } });
    await flush(s);
    expect((sets(s.server)[0][1].update as Record<string, unknown>).s).toEqual({ recurrenceOverrides: { [K1]: { title: 'Mine' } } });
    expect(s.server.events.get('s')?.recurrenceOverrides).toEqual({ [K1]: { title: 'Mine' } });
  });

  it('removes only the entries the sender knew and left out', async () => {
    const s = await synced('1.0', (server) => {
      series(server);
      server.patchEvent('s', { recurrenceOverrides: { [K1]: { title: 'Dropped' } } });
    });
    await write(s, { update: { s: { recurrenceOverrides: { [K2]: { title: 'Kept' } } } } });
    s.server.patchEvent('s', { [`recurrenceOverrides/2026-12-01T10:00:00`]: { title: 'Theirs' } });
    await flush(s);
    expect(s.server.events.get('s')?.recurrenceOverrides).toEqual({ [K2]: { title: 'Kept' }, '2026-12-01T10:00:00': { title: 'Theirs' } });
  });

  it('collides on the same entry', async () => {
    const s = await synced('1.0', series);
    await write(s, { update: { s: { recurrenceOverrides: { [K1]: { title: 'Mine' } } } } });
    s.server.patchEvent('s', { recurrenceOverrides: { [K1]: { title: 'Theirs' } } });
    await flush(s);
    expect((await conflicts(s))[0]).toMatchObject({ reason: 'changedOnServer' });
  });
});

describe('one bad write', () => {
  it('a 4xx refuses that write and the next one still goes', async () => {
    const s = await synced('1.0', (server) => server.addEvent({ id: 'e2', title: 'Other' }));
    await write(s, { update: { e1: { title: 'Bad' } } });
    await write(s, { update: { e2: { title: 'Good' } } });
    failSets(s, (args) => (args.update && 'e1' in (args.update as object) ? new TransportError('http', 'Bad request', 400) : null));
    expect(await flush(s)).toMatchObject({ sent: 1, conflicts: 1, pending: 0 });
    expect((await conflicts(s))[0]).toMatchObject({ recordId: 'e1', reason: 'refused' });
    expect(s.server.events.get('e2')?.title).toBe('Good');
    expect(await read(s, 'e1')).toMatchObject({ title: 'Meeting' });
  });

  it('401, 429 and a 5xx stay pending', async () => {
    for (const error of [new TransportError('auth', 'x', 401), new TransportError('rate', 'x', 429), new TransportError('http', 'x', 500)]) {
      const s = await synced();
      await write(s, { update: { e1: { title: 'Later' } } });
      failSets(s, () => error);
      expect(await flush(s)).toMatchObject({ conflicts: 0, pending: 1 });
      expect(await conflicts(s)).toEqual([]);
    }
  });

  it('an answer without a verdict, or a passing refusal, retries instead of deleting or finishing', async () => {
    const s = await synced();
    const id = (await write(s, { create: { c: NEW } })).created.c.id as string;
    await write(s, { update: { e1: { title: 'Later' } } });
    let round = 0;
    failSets(s, (args) => {
      if (round > 3) return null;
      if (args.create) {
        const notCreated = round === 1 ? { c: { type: 'serverFail' } } : round === 2 ? { c: { type: 'rateLimit' } } : undefined;
        return { methodResponses: [['CalendarEvent/set', notCreated ? { notCreated } : {}, 's']] };
      }
      return { methodResponses: [['CalendarEvent/set', {}, 's']] };
    });
    for (round = 1; round <= 3; round += 1) {
      await flush(s);
      expect(await conflicts(s)).toEqual([]);
      expect(pending(s)).toHaveLength(2);
      expect(await read(s, id)).toMatchObject({ title: 'Fresh' });
    }
    expect(await flush(s)).toMatchObject({ pending: 0 });
    expect(s.server.events.get('e1')?.title).toBe('Later');
    expect([...s.server.events.values()].filter((event) => event.title === 'Fresh')).toHaveLength(1);
  });
});

describe('a lost answer on an edit', () => {
  const series = (server: FakeCalendarJmap) => server.addEvent({
    id: 's',
    title: 'Weekly',
    description: 'Series',
    start: '2026-11-03T10:00:00',
    recurrenceRule: WEEKLY,
    participants: {
      me: { '@type': 'Participant', calendarAddress: 'mailto:a@example.org', participationStatus: 'needs-action', roles: { attendee: true } },
      boss: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.org', participationStatus: 'accepted', roles: { owner: true } },
    },
  });

  for (const version of ['1.0', '0.16'] as const) {
    it(`an occurrence answer that read back changed on ${version} is not a conflict, and isn't sent twice`, async () => {
      const s = await synced(version, series);
      const master = s.server.events.get('s') as unknown as { participants: Record<string, Record<string, unknown>> } & Record<string, unknown>;
      const entry = {
        title: 'Weekly',
        description: 'Series',
        start: K1,
        duration: 'PT1H',
        sequence: 0,
        participants: { ...master.participants, me: { ...master.participants.me, participationStatus: 'accepted' } },
      };
      await write(s, { update: { s: { recurrenceOverrides: { [K1]: entry } } }, sendSchedulingMessages: true });
      s.server.loseNextSetResponse = true;
      expect(await flush(s)).toMatchObject({ pending: 1 });
      expect(await flush(s)).toMatchObject({ conflicts: 0, pending: 0 });
      expect(await conflicts(s)).toEqual([]);
      expect(sets(s.server)).toHaveLength(1);
    });

    it(`a change to another override on ${version} is not a conflict on this one`, async () => {
      const s = await synced(version, (server) => {
        series(server);
        server.patchEvent('s', { recurrenceOverrides: { [K1]: { title: 'One' }, [K2]: { title: 'Two' } } });
      });
      await write(s, { update: { s: { [`recurrenceOverrides/${K1}`]: { title: 'Mine' } } } });
      s.server.patchEvent('s', { [`recurrenceOverrides/${K2}`]: { title: 'Theirs' } });
      await flush(s);
      expect(await conflicts(s)).toEqual([]);
      expect((s.server.events.get('s')?.recurrenceOverrides as Record<string, { title: string }>)[K1].title).toBe('Mine');
    });
  }

  it('an edit made after the lost one reads the lost value as ours, and goes out', async () => {
    const s = await synced();
    await write(s, { update: { e1: { title: 'First' } } });
    s.server.loseNextSetResponse = true;
    await flush(s);
    await write(s, { update: { e1: { title: 'Second' } } });
    await flush(s);
    expect(await conflicts(s)).toEqual([]);
    expect(s.server.events.get('e1')?.title).toBe('Second');
  });

  it('drops an RSVP whose value the server already holds, without sending', async () => {
    const s = await synced('1.0', (server) => server.addEvent({ id: 'r', participants: { me: { participationStatus: 'accepted' } } }));
    await write(s, { update: { r: { 'participants/me/participationStatus': 'accepted' } }, sendSchedulingMessages: true });
    await flush(s);
    expect(sets(s.server)).toEqual([]);
    expect(pending(s)).toEqual([]);
    expect(await conflicts(s)).toEqual([]);
  });

  it('drops it during sync too when someone answered the same from elsewhere', async () => {
    const s = await synced('1.0', (server) => server.addEvent({ id: 'r', participants: { me: { participationStatus: 'needs-action' } } }));
    await write(s, { update: { r: { 'participants/me/participationStatus': 'accepted' } }, sendSchedulingMessages: true });
    s.server.patchEvent('r', { 'participants/me/participationStatus': 'accepted' });
    await flush(s);
    expect(sets(s.server)).toEqual([]);
  });
});

describe('sync finding a created event', () => {
  it('adopts the stand-in by uid during the delta, without a flush', async () => {
    const s = await synced();
    const id = (await write(s, { create: { c: NEW } })).created.c.id as string;
    s.server.loseNextSetResponse = true;
    await flush(s);
    expect(await query(s)).toHaveLength(2);
    // Only the delta gets through: no lookup by uid, no writes.
    const real = s.server.request.bind(s.server);
    s.server.request = async (calls: MethodCall[]) => {
      if (calls.some(([name, args]) => (name === 'CalendarEvent/set' && !(args.update && 'h333333' in (args.update as object)))
        || (name === 'CalendarEvent/query' && (args.filter as { uid?: string } | undefined)?.uid))) {
        throw new TransportError('network', 'Failed to fetch');
      }
      return real(calls);
    };
    await s.engine.requestSync();
    const ids = await query(s);
    expect(ids).toHaveLength(2);
    expect(ids.filter((value) => value.startsWith('local-'))).toEqual([]);
    expect(pending(s)).toEqual([]);
    expect((await read(s, id))?.id).toBe(ids.find((value) => value !== 'e1'));
  });
});

describe('a full list', () => {
  it('keeps a live event the paging skipped, and drops only what is really gone', async () => {
    const s = setup();
    for (let i = 0; i < 620; i += 1) s.server.addEvent({ id: `e${String(i).padStart(3, '0')}` });
    await s.engine.requestSync();
    // The stored state can't be used, so this pass lists everything again.
    s.db.run("UPDATE sync_state SET state = 'not usable!' WHERE type = 'CalendarEvent'");
    let pages = 0;
    const real = s.server.request.bind(s.server);
    s.server.request = async (calls: MethodCall[]) => {
      const answer = await real(calls);
      if (calls.some(([name]) => name === 'CalendarEvent/query') && (pages += 1) === 1) {
        // A delete before the page boundary moves one event across it.
        s.server.removeEvent('e000');
      }
      return answer;
    };
    await s.engine.requestSync();
    const ids = new Set(s.db.all<{ id: string }>('SELECT id FROM calendar_event').map((row) => row.id));
    expect(ids.has('e000')).toBe(false);
    expect(ids.has('e500')).toBe(true);
    expect(ids.size).toBe(619);
  });
});

describe('flush around other accounts', () => {
  const session: StoreSession = {
    ...CALENDAR_SESSION,
    accounts: {
      ...CALENDAR_SESSION.accounts,
      shared: { name: 'shared', isPersonal: false, accountCapabilities: { [CAL]: {} } },
    },
  };

  it('does not touch the network for a never-synced account once stopped', async () => {
    const s = setup();
    await write(s, { create: { c: NEW } });
    s.engine.setOnline(false);
    const before = s.server.requests;
    await flush(s);
    expect(s.server.requests).toBe(before);
    expect(pending(s)).toHaveLength(1);
  });

  it('goes on with the next account after one answers accountNotFound', async () => {
    const s = setup('1.0', session);
    s.server.addEvent({ id: 'e1', title: 'Meeting' });
    await s.engine.requestSync();
    // The primary account comes first and fails, the shared one must still go.
    await write(s, { update: { e1: { title: 'Primary' } } });
    await write(s, { update: { e1: { title: 'Shared' } } }, 'shared');
    const real = s.server.request.bind(s.server);
    s.server.request = async (calls: MethodCall[]) => {
      if (calls[0][1].accountId === JMAP_ACCOUNT && calls[0][0] === 'CalendarEvent/changes') {
        return { methodResponses: [['error', { type: 'accountNotFound' }, calls[0][2]]] };
      }
      return real(calls);
    };
    await flush(s);
    expect(s.server.events.get('e1')?.title).toBe('Shared');
    expect(pending(s).map((row) => JSON.parse(row.patch))).toEqual([{ title: 'Primary' }]);
  });

  it('forgets an account the session no longer lists, and its reminders', async () => {
    const s = setup('1.0', session);
    s.server.addEvent({
      id: 'e1',
      start: '2026-11-10T10:00:00',
      alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } },
    });
    await s.engine.requestSync();
    const options = { from: Date.UTC(2026, 10, 10), to: Date.UTC(2026, 10, 11), timeZone: 'Europe/Berlin' };
    expect(listUpcomingAlerts(s.db, options).map((alert) => alert.jmap).sort()).toEqual([JMAP_ACCOUNT, 'shared'].sort());
    s.engine.setSession(CALENDAR_SESSION);
    await s.engine.requestSync();
    expect(s.db.all("SELECT 1 FROM calendar_event WHERE jmap = 'shared'")).toEqual([]);
    expect(s.db.all("SELECT 1 FROM object WHERE jmap = 'shared'")).toEqual([]);
    expect(listUpcomingAlerts(s.db, options).map((alert) => alert.jmap)).toEqual([JMAP_ACCOUNT]);
  });
});

describe('reminder keys', () => {
  it('stay the same when a stand-in becomes real', async () => {
    const s = await synced();
    await write(s, { create: { c: { ...NEW, alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } } } } });
    const options = { from: Date.UTC(2026, 10, 20), to: Date.UTC(2026, 10, 21), timeZone: 'Europe/Berlin' };
    const [before] = listUpcomingAlerts(s.db, options);
    await flush(s);
    const [after] = listUpcomingAlerts(s.db, options);
    expect(before.baseEventId).toMatch(/^local-/);
    expect(after.baseEventId).not.toMatch(/^local-/);
    expect(after.key).toBe(before.key);
  });

  it('differ between two accounts holding the same id', async () => {
    const s = setup('1.0', {
      ...CALENDAR_SESSION,
      accounts: { ...CALENDAR_SESSION.accounts, shared: { name: 'shared', isPersonal: false, accountCapabilities: { [CAL]: {} } } },
    });
    s.server.addEvent({ id: 'e1', start: '2026-11-10T10:00:00', alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } } });
    await s.engine.requestSync();
    expect(listUpcomingAlerts(s.db, { from: Date.UTC(2026, 10, 10), to: Date.UTC(2026, 10, 11), timeZone: 'Europe/Berlin' })).toHaveLength(2);
  });
});

describe('creates through the real client', () => {
  let w: Wire;
  afterEach(() => w?.restore());

  async function online() {
    w = wire(new FakeCalendarJmap('1.0'), [calendarArea], NOW);
    await w.engine.requestSync();
    return w.newClient();
  }
  const created = () => w.sent.flatMap(([name, args]) => (name === 'CalendarEvent/set' ? Object.values((args.create ?? {}) as Record<string, { uid?: string }>) : []));

  it('createCalendarEvent has a uid on its first send, and a lost answer does not duplicate', async () => {
    const client = await online();
    w.server.loseNextSetResponse = true;
    const event = await client.createCalendarEvent({ ...NEW } as Partial<CalendarEvent>);
    expect(created()[0].uid).toBeTruthy();
    expect(event.id).toMatch(/^local-/);
    expect(w.server.events.size).toBe(1);
    await flush(w);
    expect(w.server.events.size).toBe(1);
    expect(await conflicts(w)).toEqual([]);
    expect(pending(w)).toEqual([]);
  });

  it('batchCreateCalendarEvents does the same, which covers import', async () => {
    const client = await online();
    w.server.loseNextSetResponse = true;
    const result = await client.batchCreateCalendarEvents([{ ...NEW } as Partial<CalendarEvent>, { ...NEW, title: 'Two' } as Partial<CalendarEvent>]);
    expect(result.created).toHaveLength(2);
    expect(created().every((event) => event.uid)).toBe(true);
    expect(w.server.events.size).toBe(2);
    await flush(w);
    expect(w.server.events.size).toBe(2);
    expect(await conflicts(w)).toEqual([]);
  });

  it('createCalendarTask does the same', async () => {
    const client = await online();
    w.server.loseNextSetResponse = true;
    await client.createCalendarTask({ title: 'Task', calendarIds: { cal1: true }, due: '2026-12-01T10:00:00' });
    expect(created()[0].uid).toBeTruthy();
    await flush(w);
    expect(w.server.events.size).toBe(1);
  });

  it('keeps a uid the caller chose', async () => {
    const client = await online();
    await client.createCalendarEvent({ ...NEW, uid: 'chosen@example.org' } as Partial<CalendarEvent>);
    expect(created()[0].uid).toBe('chosen@example.org');
  });
});
