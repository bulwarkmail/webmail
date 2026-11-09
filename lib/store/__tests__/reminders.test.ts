// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCOPE } from '../area';
import { calendarArea } from '../calendar';
import { AccountEngine } from '../engine/account-engine';
import { remindersArea } from '../reminders';
import { FRESH_MS, MISSED_REACH_MS, type MissedBatch, type TickResult } from '../reminders/ledger';
import type { StorageAdapter } from '../storage';
import { CALENDAR_SESSION, FakeCalendarJmap, type StalwartVersion } from './helpers/fake-calendar';
import { openMemoryStore } from './helpers/node-adapter';

const MIN = 60_000;
/** 10:00 in Berlin on 2026-11-10, a Tuesday. The events' alert goes 15 minutes before. */
const START = Date.UTC(2026, 10, 10, 9);
const FIRE = START - 15 * MIN;
const ALERT = { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } };
const WEEKLY = { '@type': 'RecurrenceRule', frequency: 'weekly' };
const PARAMS = { timeZone: 'Europe/Berlin', tasks: true };

interface Rig {
  server: FakeCalendarJmap;
  db: StorageAdapter;
  engine: AccountEngine;
  now: number;
  /** What a tab, a window or the next start of the app asks. */
  tick(params?: Partial<typeof PARAMS> & { muted?: boolean }): Promise<TickResult>;
  call<T>(name: string, params?: unknown): Promise<T>;
  restart(): void;
}

function makeEngine(rig: Pick<Rig, 'server' | 'db' | 'now'>): AccountEngine {
  return new AccountEngine({
    account: 'a@fake.test',
    db: rig.db,
    session: CALENDAR_SESSION,
    transport: rig.server,
    areas: [calendarArea, remindersArea],
    scope: DEFAULT_SCOPE,
    now: () => rig.now,
    sleep: async () => {},
  });
}

function setup(version: StalwartVersion = '1.0', startAt = FIRE - 60 * MIN): Rig {
  const rig = {
    server: new FakeCalendarJmap(version),
    db: openMemoryStore(),
    now: startAt,
  } as Rig;
  rig.engine = makeEngine(rig);
  rig.call = <T,>(name: string, params?: unknown) => rig.engine.areaCall(name, params) as Promise<T>;
  rig.tick = (params = {}) => rig.call<TickResult>('reminders.tick', { ...PARAMS, ...params });
  rig.restart = () => {
    rig.engine = makeEngine(rig);
  };
  return rig;
}

/** Synced, with a first check done, so the store has been watching since before the alert. */
async function synced(rig: Rig): Promise<Rig> {
  await rig.engine.requestSync();
  await rig.tick();
  return rig;
}

function event(partial: Record<string, unknown> = {}) {
  return { id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT30M', alerts: { a: ALERT }, ...partial };
}

/** Comes back every minute or so, with no gap that would look like being away. */
async function walkTo(rig: Rig, to: number): Promise<TickResult['due']> {
  const due: TickResult['due'] = [];
  while (rig.now < to) {
    rig.now = Math.min(rig.now + MIN, to);
    due.push(...(await rig.tick()).due);
  }
  return due;
}

describe('firing', () => {
  it('fires from what is stored with the network gone', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await synced(rig);
    rig.engine.setOnline(false);
    rig.server.request = (() => {
      throw new Error('Nothing may reach the server for a reminder');
    }) as unknown as FakeCalendarJmap['request'];
    const due = await walkTo(rig, FIRE);
    expect(due.map((alert) => [alert.title, alert.fireTimeMs, alert.startMs])).toEqual([['Standup', FIRE, START]]);
  });

  it('does not fire early, and says when to ask next', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await synced(rig);
    rig.now = FIRE - 90_000;
    const before = await rig.tick();
    expect(before.due).toEqual([]);
    expect(before.nextAt).toBe(FIRE);
  });

  it('gives an alert to one caller only, across tabs and restarts', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await synced(rig);
    rig.now = FIRE - MIN;
    await rig.tick();
    rig.now = FIRE;
    const [first, second] = await Promise.all([rig.tick(), rig.tick()]);
    expect([first.due.length, second.due.length]).toEqual([1, 0]);
    rig.restart();
    rig.now = FIRE + MIN;
    expect((await rig.tick()).due).toEqual([]);
  });

  it('expands a series itself: every occurrence fires, under its own key', async () => {
    for (const version of ['1.0', '0.16'] as const) {
      const rig = setup(version);
      rig.server.addEvent(event({ start: '2026-10-06T10:00:00', recurrenceRule: WEEKLY }));
      await synced(rig);
      const first = await walkTo(rig, FIRE);
      const week = 7 * 24 * 60 * MIN;
      rig.now = FIRE + week - MIN;
      await rig.tick();
      await rig.tick();
      rig.now = FIRE + week;
      const second = (await rig.tick()).due;
      expect(first.map((alert) => alert.fireTimeMs)).toEqual([FIRE]);
      expect(second.map((alert) => alert.fireTimeMs)).toEqual([FIRE + week]);
      expect(second[0].baseEventId).toBe('e1');
      expect(second[0].key).not.toBe(first[0].key);
      expect(second[0].recurrenceId).toBeTruthy();
    }
  });

  it('keeps one key when a series gets an override, so nothing fires twice', async () => {
    const rig = setup();
    rig.server.addEvent(event({ start: '2026-10-06T10:00:00', recurrenceRule: WEEKLY }));
    await synced(rig);
    const [before] = await walkTo(rig, FIRE);
    // Another occurrence changes. On a server with synthetic ids this reshuffles them.
    rig.server.patchEvent('e1', { recurrenceOverrides: { '2026-11-17T10:00:00': { title: 'Other' } } });
    expect(before.key).toBe(`${before.jmap}:uid-1:a:${FIRE}`);
    await rig.engine.requestSync();
    rig.now = FIRE + MIN;
    expect((await rig.tick()).due).toEqual([]);
  });

  it('reads `acknowledged` on a series as covering what fired up to then', async () => {
    const rig = setup();
    const week = 7 * 24 * 60 * MIN;
    rig.server.addEvent(event({
      start: '2026-10-06T10:00:00',
      recurrenceRule: WEEKLY,
      alerts: { a: { ...ALERT, acknowledged: new Date(FIRE + 60_000).toISOString() } },
    }));
    await synced(rig);
    expect(await walkTo(rig, FIRE + 2 * MIN)).toEqual([]);
    rig.now = FIRE + week - MIN;
    await rig.tick();
    await rig.tick();
    rig.now = FIRE + week;
    expect((await rig.tick()).due.map((alert) => alert.fireTimeMs)).toEqual([FIRE + week]);
  });

  it('uses the calendar defaults while the event does, and leaves tasks out when asked', async () => {
    const rig = setup('0.16');
    rig.server.calendars.get('cal1')!.defaultAlertsWithTime = { d1: ALERT };
    rig.server.addEvent(event({ id: 'def', uid: 'def', useDefaultAlerts: true, alerts: null }));
    rig.server.addEvent({ id: 'task', uid: 'task', '@type': 'Task', title: 'Pay', start: undefined, due: '2026-11-10T09:00:00Z', alerts: { a: ALERT } });
    await rig.engine.requestSync();
    rig.now = FIRE - MIN;
    await rig.tick({ tasks: false });
    rig.now = FIRE;
    const due = (await rig.tick({ tasks: false })).due;
    expect(due.map((alert) => [alert.baseEventId, alert.alertId])).toEqual([['def', 'd1']]);
  });

  it('holds a join link only for an event that has one', async () => {
    const rig = setup();
    rig.server.addEvent(event({ virtualLocations: { v: { '@type': 'VirtualLocation', uri: 'https://meet.jit.si/standup' } } }));
    rig.server.addEvent(event({ id: 'e2', uid: 'uid-2', title: 'Lunch', locations: { l: { '@type': 'Location', name: 'Cafe' } } }));
    await synced(rig);
    const due = await walkTo(rig, FIRE);
    expect(Object.fromEntries(due.map((alert) => [alert.title, alert.joinUrl]))).toEqual({
      Standup: 'https://meet.jit.si/standup',
      Lunch: null,
    });
  });
});

describe('away', () => {
  async function awayWithThree(): Promise<Rig> {
    const rig = setup();
    rig.server.addEvent(event());
    rig.server.addEvent(event({ id: 'e2', uid: 'uid-2', title: 'Review', start: '2026-11-10T11:00:00' }));
    rig.server.addEvent(event({ id: 'e3', uid: 'uid-3', title: 'Lunch', start: '2026-11-10T12:00:00' }));
    await synced(rig);
    rig.now = FIRE - MIN;
    await rig.tick();
    return rig;
  }

  it('sends what came due while away to one summary, not a burst, and only once', async () => {
    const rig = await awayWithThree();
    rig.restart();
    rig.now = FIRE + 3 * 60 * MIN;
    const back = await rig.tick();
    expect(back.due).toEqual([]);
    expect(back.missed).toBe(3);
    const [one, two] = await Promise.all([
      rig.call<MissedBatch | null>('reminders.takeMissed', PARAMS),
      rig.call<MissedBatch | null>('reminders.takeMissed', PARAMS),
    ]);
    expect(one!.alerts.map((alert) => alert.title)).toEqual(['Standup', 'Review', 'Lunch']);
    expect(two).toBeNull();
    rig.restart();
    rig.now += MIN;
    expect(await rig.tick()).toMatchObject({ due: [], missed: 0 });
    expect(await rig.call('reminders.takeMissed', PARAMS)).toBeNull();
  });

  it('summarises the ones within ten minutes as well: a wake-up is no time for a burst', async () => {
    const rig = await awayWithThree();
    rig.now = START + 2 * 60 * MIN - 15 * MIN + 2 * MIN;
    expect(await rig.tick()).toMatchObject({ due: [], missed: 3 });
  });

  it('shows a single alert that just came due as a normal reminder', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await synced(rig);
    rig.now = FIRE - 2 * MIN;
    await rig.tick();
    // Over the limit for being away, and under ten minutes old.
    rig.now = FIRE + 5 * MIN;
    expect(await rig.tick()).toMatchObject({ due: [{ title: 'Standup' }], missed: 0 });
  });

  it('summarises a single alert that is long past', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await synced(rig);
    rig.now = FIRE - MIN;
    await rig.tick();
    rig.now = FIRE + FRESH_MS + MIN;
    expect(await rig.tick()).toMatchObject({ due: [], missed: 1 });
  });

  it('counts nothing as missed on the very first check, however old the calendar', async () => {
    const rig = setup('1.0', FIRE + 60 * MIN);
    rig.server.addEvent(event());
    await rig.engine.requestSync();
    expect(await rig.tick()).toMatchObject({ due: [], missed: 0 });
  });

  it('reaches back a week at most', async () => {
    const rig = await awayWithThree();
    rig.now = FIRE + MISSED_REACH_MS + 3 * 60 * MIN;
    expect((await rig.tick()).missed).toBe(0);
  });

  it('leaves out what was deleted while away', async () => {
    const rig = await awayWithThree();
    rig.now = FIRE + 3 * 60 * MIN;
    expect((await rig.tick()).missed).toBe(3);
    rig.server.removeEvent('e2');
    await rig.engine.requestSync();
    const batch = await rig.call<MissedBatch>('reminders.takeMissed', PARAMS);
    expect(batch.alerts.map((alert) => alert.title)).toEqual(['Standup', 'Lunch']);
  });

  it('puts a summary that could not be shown back, and reads a shown one again for a late click', async () => {
    const rig = await awayWithThree();
    rig.now = FIRE + 3 * 60 * MIN;
    await rig.tick();
    const refused = await rig.call<MissedBatch>('reminders.takeMissed', PARAMS);
    await rig.call('reminders.releaseMissed', { batch: refused.batch });
    expect((await rig.tick()).missed).toBe(3);
    const shown = await rig.call<MissedBatch>('reminders.takeMissed', PARAMS);
    expect(shown.alerts).toHaveLength(3);
    rig.restart();
    const read = await rig.call<unknown[]>('reminders.batch', { batch: shown.batch });
    expect(read).toHaveLength(3);
    await rig.call('reminders.dismiss', { keys: shown.alerts.map((alert) => alert.key) });
    expect(await rig.call('reminders.batch', { batch: shown.batch })).toEqual([]);
  });

  it('moves a fired alert nobody could be told about to the summary', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await synced(rig);
    const [fired] = await walkTo(rig, FIRE);
    await rig.call('reminders.hold', { keys: [fired.key] });
    rig.now += MIN;
    expect(await rig.tick()).toMatchObject({ due: [], missed: 1 });
  });

  it('keeps quiet while reminders are off, and nothing from that time is missed later', async () => {
    const rig = setup();
    rig.server.addEvent(event());
    await synced(rig);
    rig.now = FIRE - MIN;
    await rig.tick();
    rig.now = FIRE + 60 * MIN;
    expect(await rig.tick({ muted: true })).toMatchObject({ due: [], missed: 0, nextAt: null });
    rig.now += MIN;
    expect(await rig.tick()).toMatchObject({ due: [], missed: 0 });
  });
});

describe('snooze', () => {
  async function fired(version: StalwartVersion = '1.0') {
    const rig = setup(version);
    rig.server.addEvent(event());
    await synced(rig);
    const [alert] = await walkTo(rig, FIRE);
    return { rig, alert };
  }

  it('comes back after the minutes asked for, once, and survives a restart', async () => {
    const { rig, alert } = await fired();
    expect(await rig.call('reminders.snooze', { key: alert.key, minutes: 5 })).toBe(true);
    rig.now = FIRE + 2 * MIN;
    const during = await rig.tick();
    expect(during.due).toEqual([]);
    expect(during.nextAt).toBe(FIRE + 5 * MIN);

    rig.restart();
    rig.now = FIRE + 4 * MIN;
    expect((await rig.tick()).due).toEqual([]);
    rig.now = FIRE + 5 * MIN;
    const back = (await rig.tick()).due;
    expect(back.map((a) => [a.title, a.snoozedUntil])).toEqual([['Standup', FIRE + 5 * MIN]]);
    rig.now += MIN;
    expect((await rig.tick()).due).toEqual([]);
  });

  it('can be snoozed again', async () => {
    const { rig, alert } = await fired();
    await rig.call('reminders.snooze', { key: alert.key, minutes: 5 });
    rig.now = FIRE + 5 * MIN;
    expect((await rig.tick()).due).toHaveLength(1);
    await rig.call('reminders.snooze', { key: alert.key, minutes: 10 });
    rig.now = FIRE + 15 * MIN;
    const back = (await rig.tick()).due;
    expect(back[0].snoozedUntil).toBe(FIRE + 15 * MIN);
  });

  it('goes to the summary when it ran out while the app was quit', async () => {
    const { rig, alert } = await fired();
    await rig.call('reminders.snooze', { key: alert.key, minutes: 5 });
    rig.restart();
    rig.now = FIRE + 3 * 60 * MIN;
    expect(await rig.tick()).toMatchObject({ due: [], missed: 1 });
  });

  it('does not come back for an event deleted in the meantime', async () => {
    const { rig, alert } = await fired();
    await rig.call('reminders.snooze', { key: alert.key, minutes: 5 });
    rig.server.removeEvent('e1');
    await rig.engine.requestSync();
    rig.now = FIRE + 5 * MIN;
    expect(await rig.tick()).toMatchObject({ due: [], missed: 0 });
  });

  it('does not come back once dismissed in another window', async () => {
    const { rig, alert } = await fired();
    await rig.call('reminders.snooze', { key: alert.key, minutes: 5 });
    await rig.call('reminders.dismiss', { keys: [alert.key] });
    rig.now = FIRE + 5 * MIN;
    expect(await rig.tick()).toMatchObject({ due: [], nextAt: null });
  });

  it('refuses an unknown reminder and silly minutes', async () => {
    const { rig, alert } = await fired();
    expect(await rig.call('reminders.snooze', { key: 'nope', minutes: 5 })).toBe(false);
    expect(await rig.call('reminders.snooze', { key: alert.key, minutes: -1 })).toBe(false);
    expect(await rig.call('reminders.snooze', { key: alert.key, minutes: 99_999 })).toBe(false);
  });
});

it('keeps reminders off the server', async () => {
  const rig = setup();
  rig.server.addEvent(event());
  await synced(rig);
  const before = JSON.stringify(rig.server.events.get('e1'));
  const [alert] = await walkTo(rig, FIRE);
  await rig.call('reminders.snooze', { key: alert.key, minutes: 5 });
  await rig.call('reminders.dismiss', { keys: [alert.key] });
  await rig.engine.requestSync();
  expect(JSON.stringify(rig.server.events.get('e1'))).toBe(before);
});
