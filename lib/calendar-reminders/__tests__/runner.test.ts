import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_SESSION, FakeCalendarJmap } from '@/lib/store/__tests__/helpers/fake-calendar';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import type { MissedBatch, ReminderAlert } from '@/lib/store/reminders/ledger';
import { HIDDEN_GRACE_MS } from '../claims';
import { createReminderRunner, SUMMARY_WAIT_MS, type ReminderRunner, type ReminderRunnerEnv } from '../runner';

const MIN = 60_000;
const ACCOUNT = 'acc';
const START = Date.UTC(2026, 10, 10, 9);
const FIRE = START - 15 * MIN;
const ALERT = { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } };

function event(partial: Record<string, unknown> = {}) {
  return { id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', timeZone: 'Europe/Berlin', duration: 'PT30M', alerts: { a: ALERT }, ...partial };
}

interface Tab {
  runner: ReminderRunner;
  due: ReminderAlert[];
  firedAt: number[];
  missed: MissedBatch[];
  source: boolean[];
  env: ReminderRunnerEnv;
  hidden: boolean;
  offline: boolean;
  muted: boolean;
}

let store: InProcessStore;
let server: FakeCalendarJmap;
const tabs: Tab[] = [];

function tab(options: Partial<Pick<Tab, 'hidden' | 'offline'>> = {}): Tab {
  const made = { due: [], firedAt: [], missed: [], source: [], hidden: false, offline: false, muted: false, ...options } as unknown as Tab;
  made.env = {
    accounts: () => [ACCOUNT],
    store: () => store,
    params: () => ({ timeZone: 'Europe/Berlin', tasks: true, muted: made.muted }),
    hidden: () => made.hidden,
    offline: () => made.offline,
    onDue: (_account, alerts) => {
      made.due.push(...alerts);
      made.firedAt.push(...alerts.map(() => Date.now()));
    },
    onMissed: async (account) => {
      const batch = await store.area<MissedBatch | null>(account, 'reminders.takeMissed', { timeZone: 'Europe/Berlin' });
      if (batch) made.missed.push(batch);
    },
    onSource: (_account, driven) => {
      made.source.push(driven);
    },
  };
  made.runner = createReminderRunner(made.env);
  tabs.push(made);
  return made;
}

async function syncedStore(...events: Record<string, unknown>[]): Promise<void> {
  for (const partial of events) server.addEvent(partial);
  await store.sync(ACCOUNT);
}

beforeEach(() => {
  vi.useFakeTimers({ now: FIRE - 30 * MIN, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  server = new FakeCalendarJmap('1.0');
  store = new InProcessStore(server, CALENDAR_SESSION);
});

afterEach(() => {
  for (const made of tabs.splice(0)) made.runner.stop();
  vi.useRealTimers();
});

describe('firing from the store', () => {
  it('fires at the moment it is due, with the network gone', async () => {
    await syncedStore(event());
    await store.setOnline(false);
    server.request = (() => {
      throw new Error('A reminder needs no server');
    }) as unknown as FakeCalendarJmap['request'];
    const one = tab();
    one.runner.start();
    await vi.advanceTimersByTimeAsync(FIRE - Date.now() - 1000);
    expect(one.due).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(one.due.map((alert) => alert.title)).toEqual(['Standup']);
    expect(one.firedAt).toEqual([FIRE]);
  });

  it('takes over from the old path once the store has synced, and gives it back when the store fails', async () => {
    const one = tab();
    one.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(one.source.at(-1)).toBe(false);
    await syncedStore(event());
    one.runner.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(one.source.at(-1)).toBe(true);
    store.failArea = () => true;
    one.runner.poke();
    await vi.advanceTimersByTimeAsync(0);
    expect(one.source.at(-1)).toBe(false);
  });

  it('fires in one tab only, when both ask at the same moment', async () => {
    await syncedStore(event());
    const [one, two] = [tab(), tab()];
    one.runner.start();
    two.runner.start();
    await vi.advanceTimersByTimeAsync(FIRE - Date.now() + MIN);
    expect(one.due.length + two.due.length).toBe(1);
  });

  it('leaves it to the tab in view when another is hidden', async () => {
    await syncedStore(event());
    const hidden = tab({ hidden: true });
    const visible = tab();
    hidden.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    visible.runner.start();
    await vi.advanceTimersByTimeAsync(FIRE - Date.now() + HIDDEN_GRACE_MS + MIN);
    expect(visible.due).toHaveLength(1);
    expect(hidden.due).toHaveLength(0);
  });

  it('still fires when only a hidden tab is left', async () => {
    await syncedStore(event());
    const hidden = tab({ hidden: true });
    hidden.runner.start();
    await vi.advanceTimersByTimeAsync(FIRE - Date.now() + HIDDEN_GRACE_MS);
    expect(hidden.due).toHaveLength(1);
  });

  it('notices an event that just arrived, and a snooze just set', async () => {
    await syncedStore();
    const one = tab();
    one.runner.start();
    await vi.advanceTimersByTimeAsync(FIRE - Date.now() - 2 * MIN);
    await syncedStore(event());
    one.runner.poke();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(one.firedAt).toEqual([FIRE]);

    await store.area(ACCOUNT, 'reminders.snooze', { key: one.due[0].key, minutes: 5 });
    one.runner.poke();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(one.firedAt).toEqual([FIRE, FIRE + 5 * MIN]);
  });

  it('brings a snoozed reminder back after a restart', async () => {
    await syncedStore(event());
    const before = tab();
    before.runner.start();
    await vi.advanceTimersByTimeAsync(FIRE - Date.now());
    await store.area(ACCOUNT, 'reminders.snooze', { key: before.due[0].key, minutes: 10 });
    before.runner.stop();
    await vi.advanceTimersByTimeAsync(MIN);

    const after = tab();
    after.runner.start();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(before.due).toHaveLength(1);
    expect(after.firedAt).toEqual([FIRE + 10 * MIN]);
    expect(after.due[0].snoozedUntil).toBe(FIRE + 10 * MIN);
  });

  it('stays quiet while reminders are off', async () => {
    await syncedStore(event());
    const one = tab();
    one.muted = true;
    one.runner.start();
    await vi.advanceTimersByTimeAsync(FIRE - Date.now() + MIN);
    expect(one.due).toEqual([]);
  });
});

describe('after being away', () => {
  async function awayFromBothAlerts(): Promise<Tab> {
    await syncedStore(event(), event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    const before = tab();
    before.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    before.runner.stop();
    vi.setSystemTime(FIRE + 60 * MIN);
    return before;
  }

  it('waits a moment for the first sync, then summarises once, not as a burst', async () => {
    await awayFromBothAlerts();
    const one = tab();
    one.runner.start();
    await vi.advanceTimersByTimeAsync(SUMMARY_WAIT_MS - 1000);
    expect(one.missed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(one.due).toEqual([]);
    expect(one.missed.map((batch) => batch.alerts.map((alert) => alert.title))).toEqual([['Standup', 'Review']]);

    await vi.advanceTimersByTimeAsync(30 * MIN);
    one.runner.wake();
    await vi.advanceTimersByTimeAsync(SUMMARY_WAIT_MS);
    expect(one.missed).toHaveLength(1);
  });

  it('does not wait once the sync is done, and has nothing to wait for offline', async () => {
    await awayFromBothAlerts();
    const synced = tab();
    synced.runner.start();
    await vi.advanceTimersByTimeAsync(100);
    synced.runner.synced(ACCOUNT);
    await vi.advanceTimersByTimeAsync(0);
    expect(synced.missed).toHaveLength(1);
  });

  it('gives the summary at once with no network', async () => {
    await awayFromBothAlerts();
    const offline = tab({ offline: true });
    offline.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(offline.missed).toHaveLength(1);
  });

  it('gives the summary to one window of two, and neither again after a restart', async () => {
    await awayFromBothAlerts();
    const [one, two] = [tab({ offline: true }), tab({ offline: true })];
    one.runner.start();
    two.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(one.missed.length + two.missed.length).toBe(1);
    one.runner.stop();
    two.runner.stop();
    await vi.advanceTimersByTimeAsync(MIN);
    const next = tab({ offline: true });
    next.runner.start();
    await vi.advanceTimersByTimeAsync(SUMMARY_WAIT_MS);
    expect(next.missed).toEqual([]);
  });

  it('sees a jump of the clock without being told, as after a sleep', async () => {
    await syncedStore(event(), event({ id: 'e2', uid: 'uid-2', title: 'Review' }));
    const one = tab();
    one.runner.start();
    await vi.advanceTimersByTimeAsync(MIN);
    // Asleep: timers stood still and the clock did not.
    vi.setSystemTime(FIRE + 60 * MIN);
    await vi.advanceTimersByTimeAsync(MIN + SUMMARY_WAIT_MS);
    expect(one.due).toEqual([]);
    expect(one.missed.map((batch) => batch.alerts.length)).toEqual([1 + 1]);
  });

  it('tries a summary again that could not be shown', async () => {
    await awayFromBothAlerts();
    const one = tab({ offline: true });
    let refuse = true;
    const plain = one.env.onMissed;
    one.env.onMissed = async (account) => {
      if (!refuse) return plain(account);
      const batch = await store.area<MissedBatch>(account, 'reminders.takeMissed', { timeZone: 'Europe/Berlin' });
      await store.area(account, 'reminders.releaseMissed', { batch: batch.batch });
    };
    one.runner.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(one.missed).toEqual([]);
    refuse = false;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(one.missed).toHaveLength(1);
  });
});
