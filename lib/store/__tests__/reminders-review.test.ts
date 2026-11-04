// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { calendarArea } from '../calendar';
import { listUpcomingAlerts } from '../calendar/reminders';
import { instantOf } from '../calendar/records';
import { AccountEngine } from '../engine/account-engine';
import { remindersArea } from '../reminders';
import { AWAY_MS, type MissedBatch, type TickResult } from '../reminders/ledger';
import { CALENDAR_SESSION, FakeCalendarJmap } from './helpers/fake-calendar';
import { JMAP_ACCOUNT } from './helpers/fake-jmap';
import { openMemoryStore } from './helpers/node-adapter';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const START = Date.UTC(2026, 10, 10, 9);
const FIRE = START - 15 * MIN;
const ALERT = { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } };
const WEEKLY = { '@type': 'RecurrenceRule', frequency: 'weekly' };
const ZONE = 'Europe/Berlin';
const PARAMS = { timeZone: ZONE, tasks: true };

function setup(startAt = FIRE - 60 * MIN) {
  const server = new FakeCalendarJmap('1.0');
  const db = openMemoryStore();
  const rig = { server, db, now: startAt };
  const make = () => new AccountEngine({
    account: 'a@fake.test',
    db,
    session: CALENDAR_SESSION,
    transport: server,
    areas: [calendarArea, remindersArea],
    scope: DEFAULT_SCOPE,
    now: () => rig.now,
    sleep: async () => {},
  });
  let engine = make();
  return Object.assign(rig, {
    get engine() {
      return engine;
    },
    restart: () => {
      engine = make();
    },
    call: <T,>(name: string, params?: unknown) => engine.areaCall(name, params) as Promise<T>,
    tick: (params: Record<string, unknown> = {}) => engine.areaCall('reminders.tick', { ...PARAMS, ...params }) as Promise<TickResult>,
  });
}

type Rig = ReturnType<typeof setup>;

function event(partial: Record<string, unknown> = {}) {
  return { id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', timeZone: ZONE, duration: 'PT30M', alerts: { a: ALERT }, ...partial };
}

async function syncedAndWatching(rig: Rig): Promise<void> {
  await rig.engine.requestSync();
  await rig.tick();
}

/** The last check just before the alert, so nothing counts as away. */
async function justBefore(rig: Rig): Promise<void> {
  rig.now = FIRE - MIN;
  await rig.tick();
}

describe('one bad event', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['an offset out of all range', { alerts: { a: { ...ALERT, trigger: { '@type': 'OffsetTrigger', offset: 'P999999999D' } } } }],
    ['a huge negative offset on a series', { recurrenceRule: WEEKLY, start: '2026-10-06T10:00:00', alerts: { a: { ...ALERT, trigger: { '@type': 'OffsetTrigger', offset: '-P999999999W' } } } }],
    ['an alert without a trigger', { alerts: { a: { '@type': 'Alert', action: 'display' } } }],
    ['a null alert', { alerts: { a: null } }],
    ['a null alert on a series', { recurrenceRule: WEEKLY, start: '2026-10-06T10:00:00', alerts: { a: null } }],
    ['a start that is no date', { start: 'yesterday-ish' }],
  ];

  for (const [name, partial] of BAD) {
    it(`doesn't stop the others: ${name}`, async () => {
      const rig = setup();
      rig.server.addEvent(event({ id: 'bad', uid: 'bad', title: 'Bad', ...partial }));
      rig.server.addEvent(event());
      await syncedAndWatching(rig);
      await justBefore(rig);
      rig.now = FIRE;
      expect((await rig.tick()).due.map((alert) => alert.title)).toEqual(['Standup']);
    });
  }

  it("doesn't stop the others: a row that can't be read at all", async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await syncedAndWatching(rig);
    rig.db.run('INSERT INTO calendar_event (jmap, id, uid, json) VALUES (?, ?, ?, ?)', ['a-other', 'broken', 'broken', '{not json']);
    await justBefore(rig);
    rig.now = FIRE;
    expect((await rig.tick()).due.map((alert) => alert.title)).toEqual(['Standup']);
  });

  it('keeps the good alert of an event with a bad one', async () => {
    const rig = setup();
    rig.server.addEvent(event({ alerts: { bad: null, huge: { ...ALERT, trigger: { '@type': 'OffsetTrigger', offset: '-P999999999W' } }, a: ALERT } }));
    await syncedAndWatching(rig);
    await justBefore(rig);
    rig.now = FIRE;
    expect((await rig.tick()).due.map((alert) => alert.alertId)).toEqual(['a']);
  });
});

describe('Join', () => {
  const OPTIONS = { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE };

  async function joinOf(uri: string, extra: Record<string, unknown> = {}) {
    const rig = setup();
    rig.server.addEvent(event({ virtualLocations: { v: { '@type': 'VirtualLocation', uri } }, ...extra }));
    await rig.engine.requestSync();
    const [alert] = listUpcomingAlerts(rig.db, OPTIONS);
    return alert;
  }

  for (const uri of ['ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'smb://evil.example/share', 'msteams:/l/meetup-join/x', 'https://meet.google.com@evil.example/abc-defg-hij', 'javascript:alert(1)']) {
    it(`offers none for ${uri}`, async () => {
      expect((await joinOf(uri)).joinUrl).toBeNull();
    });
  }

  it('names the host of a link it does not know, not of one it does', async () => {
    expect(await joinOf('https://calls.example.org/room')).toMatchObject({ joinUrl: 'https://calls.example.org/room', joinHost: 'calls.example.org' });
    expect(await joinOf('https://meet.jit.si/standup')).toMatchObject({ joinUrl: 'https://meet.jit.si/standup', joinHost: null });
    expect(await joinOf('https://meet.google.com/abc-defg-hij')).toMatchObject({ joinHost: null });
  });
});

describe('shared calendars', () => {
  function addOtherCopy(rig: Rig, jmap: string, json: Record<string, unknown>) {
    rig.db.run('INSERT INTO calendar_event (jmap, id, uid, json) VALUES (?, ?, ?, ?)', [jmap, json.id as string, json.uid as string, JSON.stringify({ calendarIds: { cal1: true }, '@type': 'Event', ...json })]);
  }

  it('leaves out a calendar the user has not subscribed to', async () => {
    const rig = setup();
    rig.server.calendars.get('cal1')!.isSubscribed = false;
    rig.server.addEvent(event());
    await rig.engine.requestSync();
    expect(listUpcomingAlerts(rig.db, { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE })).toEqual([]);
  });

  it('still reads a calendar that says nothing about it', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await rig.engine.requestSync();
    expect(listUpcomingAlerts(rig.db, { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE })).toHaveLength(1);
  });

  it('rings once for a meeting in two accounts, from the own account', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await rig.engine.requestSync();
    addOtherCopy(rig, 'a-shared', event({ id: 'other', alerts: { other: ALERT } }));
    const alerts = listUpcomingAlerts(rig.db, { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE, prefer: JMAP_ACCOUNT });
    expect(alerts.map((alert) => alert.jmap)).toEqual([JMAP_ACCOUNT]);
    const other = listUpcomingAlerts(rig.db, { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE, prefer: 'a-shared' });
    expect(other.map((alert) => alert.jmap)).toEqual(['a-shared']);
  });

  it('prefers the account the session names as primary when it fires', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await syncedAndWatching(rig);
    addOtherCopy(rig, 'a-shared', event({ id: 'other' }));
    await justBefore(rig);
    rig.now = FIRE;
    expect((await rig.tick()).due.map((alert) => alert.jmap)).toEqual([JMAP_ACCOUNT]);
  });
});

describe('an edit that keeps the time', () => {
  it('does not fire again when only the alert id changed', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await syncedAndWatching(rig);
    await justBefore(rig);
    rig.now = FIRE;
    expect((await rig.tick()).due).toHaveLength(1);
    rig.server.patchEvent('e1', { alerts: { renamed: ALERT } });
    await rig.engine.requestSync();
    rig.now = FIRE + MIN;
    expect((await rig.tick()).due).toEqual([]);
  });

  it('keeps the snooze, and brings it back once', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await syncedAndWatching(rig);
    await justBefore(rig);
    rig.now = FIRE;
    const [fired] = (await rig.tick()).due;
    await rig.call('reminders.snooze', { key: fired.key, minutes: 5 });
    rig.server.patchEvent('e1', { alerts: { renamed: ALERT } });
    await rig.engine.requestSync();
    rig.now = FIRE + 5 * MIN;
    expect((await rig.tick()).due.map((alert) => alert.alertId)).toEqual(['renamed']);
    rig.now += MIN;
    expect((await rig.tick()).due).toEqual([]);
  });

  it('a move while snoozed: the old time is forgotten, the new one rings', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await syncedAndWatching(rig);
    await justBefore(rig);
    rig.now = FIRE;
    const [fired] = (await rig.tick()).due;
    await rig.call('reminders.snooze', { key: fired.key, minutes: 5 });
    rig.server.patchEvent('e1', { start: '2026-11-10T10:30:00' });
    await rig.engine.requestSync();
    rig.now = FIRE + 5 * MIN;
    expect((await rig.tick()).due).toEqual([]);
    rig.now = FIRE + 10 * MIN;
    await rig.tick();
    rig.now = FIRE + 15 * MIN;
    await rig.tick();
    rig.now = FIRE + 20 * MIN;
    await rig.tick();
    rig.now = FIRE + 25 * MIN;
    await rig.tick();
    rig.now = FIRE + 30 * MIN;
    const moved = (await rig.tick()).due;
    expect(moved.map((alert) => alert.fireTimeMs)).toEqual([FIRE + 30 * MIN]);
  });
});

describe('zones', () => {
  it('reads an all-day series in the Time zone setting, in any zone', async () => {
    for (const zone of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
      const rig = setup();
      rig.server.addEvent(event({
        start: '2026-10-06T00:00:00',
        showWithoutTime: true,
        timeZone: null,
        duration: 'P1D',
        recurrenceRule: WEEKLY,
        alerts: { a: { ...ALERT, trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' } } },
      }));
      await rig.engine.requestSync();
      const startOfDay = instantOf('2026-11-10T00:00:00', zone)!;
      const alerts = listUpcomingAlerts(rig.db, { from: startOfDay - 2 * 60 * MIN, to: startOfDay + MIN, timeZone: zone });
      expect(alerts.map((alert) => alert.fireTimeMs)).toEqual([startOfDay - 60 * MIN]);
      expect(alerts[0].startMs).toBe(startOfDay);
    }
  });
});

describe('a fixed-time alert on a series', () => {
  it('rings as before', async () => {
    const rig = setup();
    rig.server.addEvent(event({
      start: '2026-10-06T10:00:00',
      recurrenceRule: WEEKLY,
      alerts: { a: { ...ALERT, trigger: { '@type': 'AbsoluteTrigger', when: new Date(FIRE).toISOString() } } },
    }));
    await rig.engine.requestSync();
    expect(listUpcomingAlerts(rig.db, { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE })).toHaveLength(1);
  });

  it('stays quiet when the occurrence it was for was excluded', async () => {
    const rig = setup();
    rig.server.addEvent(event({
      start: '2026-10-06T10:00:00',
      recurrenceRule: WEEKLY,
      alerts: { a: { ...ALERT, trigger: { '@type': 'AbsoluteTrigger', when: new Date(FIRE).toISOString() } } },
      recurrenceOverrides: { '2026-11-10T10:00:00': { excluded: true } },
    }));
    await rig.engine.requestSync();
    expect(listUpcomingAlerts(rig.db, { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE })).toEqual([]);
  });
});

describe('the edge of being away', () => {
  async function twoAlerts(gapMs: number): Promise<TickResult> {
    const rig = setup();
    rig.server.addEvent(event());
    rig.server.addEvent(event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    await rig.engine.requestSync();
    rig.now = FIRE - 1000;
    await rig.tick();
    rig.now = FIRE - 1000 + gapMs;
    return rig.tick();
  }

  it('a gap of exactly the limit is no absence', async () => {
    expect(await twoAlerts(AWAY_MS)).toMatchObject({ missed: 0, due: [{ title: 'Standup' }, { title: 'Review' }] });
  });

  it('a gap a moment longer is', async () => {
    expect(await twoAlerts(AWAY_MS + 1)).toMatchObject({ missed: 2, due: [] });
  });

  it('a single alert past the limit is a late reminder, not a summary', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await rig.engine.requestSync();
    rig.now = FIRE - 1000;
    await rig.tick();
    rig.now = FIRE - 1000 + AWAY_MS + 1;
    expect(await rig.tick()).toMatchObject({ missed: 0, due: [{ title: 'Standup' }] });
  });
});

describe('pruning', () => {
  it('forgets what is past the reach, and keeps what still waits', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    rig.server.addEvent(event({ id: 'e2', uid: 'uid-2', title: 'Snoozed' }));
    rig.server.addEvent(event({ id: 'e3', uid: 'uid-3', title: 'Held' }));
    await syncedAndWatching(rig);
    await justBefore(rig);
    rig.now = FIRE;
    const fired = (await rig.tick()).due;
    const byTitle = Object.fromEntries(fired.map((alert) => [alert.title, alert.key]));
    await rig.call('reminders.snooze', { key: byTitle.Snoozed, minutes: 60 });
    await rig.call('reminders.hold', { keys: [byTitle.Held] });
    const rows = () => rig.db.all<{ key: string }>('SELECT key FROM reminder').map((row) => row.key).sort();
    expect(rows()).toHaveLength(3);
    rig.now = FIRE + 9 * DAY;
    await rig.tick();
    expect(rows()).toEqual([byTitle.Snoozed, byTitle.Held].sort());
  });
});

describe('bounded keys', () => {
  it('stays short with a very long uid, and tells two long ones apart', async () => {
    const rig = setup();
    const long = 'u'.repeat(5000);
    rig.server.addEvent(event({ uid: `${long}1` }));
    rig.server.addEvent(event({ id: 'e2', uid: `${long}2` }));
    await rig.engine.requestSync();
    const alerts = listUpcomingAlerts(rig.db, { from: FIRE - MIN, to: FIRE + MIN, timeZone: ZONE });
    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((alert) => alert.key)).size).toBe(2);
    for (const alert of alerts) expect(alert.key.length).toBeLessThan(300);
  });
});

describe('a summary on loan', () => {
  async function missedTwo(rig: Rig): Promise<MissedBatch> {
    rig.server.addEvent(event());
    rig.server.addEvent(event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    await syncedAndWatching(rig);
    await justBefore(rig);
    rig.now = FIRE + 60 * MIN;
    await rig.tick();
    return rig.call<MissedBatch>('reminders.takeMissed', PARAMS);
  }

  it('comes back when whoever took it never said it was shown: a crash, a reload', async () => {
    const rig = setup();
    const batch = await missedTwo(rig);
    expect(batch.alerts).toHaveLength(2);
    rig.now += MIN;
    expect((await rig.tick()).missed).toBe(0);
    rig.now += 5 * MIN;
    expect((await rig.tick()).missed).toBe(2);
  });

  it('stays while the window showing it keeps saying so', async () => {
    const rig = setup();
    const batch = await missedTwo(rig);
    for (let i = 0; i < 6; i += 1) {
      rig.now += MIN;
      await rig.call('reminders.renewMissed', { batch: batch.batch });
      expect((await rig.tick()).missed).toBe(0);
    }
    expect(await rig.call('reminders.batch', { batch: batch.batch })).toHaveLength(2);
  });

  it('is done once a native notification showed it, and can still open later', async () => {
    const rig = setup();
    const batch = await missedTwo(rig);
    await rig.call('reminders.settleMissed', { batch: batch.batch });
    rig.now += 60 * MIN;
    expect((await rig.tick()).missed).toBe(0);
    expect(await rig.call('reminders.batch', { batch: batch.batch })).toHaveLength(2);
  });

  it('does not come back once dismissed', async () => {
    const rig = setup();
    const batch = await missedTwo(rig);
    await rig.call('reminders.dismiss', { keys: batch.alerts.map((alert) => alert.key) });
    rig.now += 60 * MIN;
    expect((await rig.tick()).missed).toBe(0);
  });
});

describe('muted', () => {
  it('asks for no summary of what already waited', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    rig.server.addEvent(event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    await syncedAndWatching(rig);
    await justBefore(rig);
    rig.now = FIRE + 60 * MIN;
    expect((await rig.tick()).missed).toBe(2);
    rig.now += MIN;
    expect((await rig.tick({ muted: true })).missed).toBe(0);
  });
});
