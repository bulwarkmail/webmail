import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMissedReminders } from '@/lib/calendar-reminders/state';
import { CALENDAR_SESSION, FakeCalendarJmap } from '@/lib/store/__tests__/helpers/fake-calendar';
import { InProcessStore } from '@/lib/store/__tests__/helpers/in-process-store';
import { setStoreBackend } from '@/lib/store/client/api';
import type { ReminderAlert, TickResult } from '@/lib/store/reminders/ledger';
import { setAppLockCheck } from '../app-lock-state';
import {
  buildMissedNotification,
  buildReminderNotification,
  handleReminderCommand,
  joinMeeting,
  missedBody,
  notifyWithoutStore,
  type ReminderLabels,
} from '../reminder-notifications';
import type { BulwarkDesktopBridge } from '../types';

const ACCOUNT = 'alice@one';
const accounts = [{ id: ACCOUNT, cookieSlot: 3, serverUrl: 'https://one.example', username: 'alice@example.org' }];
let activeAccountId: string | null = ACCOUNT;
vi.mock('@/stores/account-store', () => ({ useAccountStore: { getState: () => ({ accounts }) } }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: { getState: () => ({ activeAccountId }), subscribe: () => () => {} } }));
vi.mock('@/stores/policy-store', () => ({ usePolicyStore: { getState: () => ({ loaded: true }), subscribe: () => () => {} } }));

const policy = vi.hoisted(() => ({ pushWithoutContent: false }));
vi.mock('@/lib/device-policy', () => ({ devicesForAccount: () => ({ pushWithoutContent: policy.pushWithoutContent }) }));

const MIN = 60_000;
const START = Date.UTC(2026, 10, 10, 9);
const FIRE = START - 15 * MIN;

const labels: ReminderLabels = {
  generic: 'GENERIC',
  when: () => 'In 15 min · Personal',
  untitled: 'UNTITLED',
  snooze: (minutes) => `Snooze ${minutes} min`,
  snoozeShort: (minutes) => `${minutes} min`,
  open: 'Open',
  join: 'Join',
  joinHost: (host) => `Join (${host})`,
  missedTitle: (count) => `${count} missed`,
  missedMore: (count) => `and ${count} more`,
};

function alert(partial: Partial<ReminderAlert> = {}): ReminderAlert {
  return {
    key: `j1:uid-1:a:${FIRE}`, jmap: 'j1', uid: 'uid-1', kind: 'event', baseEventId: 'e1', recurrenceId: null, alertId: 'a', fireTimeMs: FIRE,
    title: 'Secret board meeting', start: '2026-11-10T10:00:00', startMs: START, joinUrl: null, joinHost: null, timeZone: 'Europe/Berlin', calendarId: 'cal1', calendarName: 'Personal',
    ...partial,
  };
}

const focus = vi.fn();
const openExternal = vi.fn();
const notify = vi.fn(async () => ({ shown: true, playSound: false }));

function setPlatform(platform: string) {
  window.bulwarkDesktop = { version: 1, platform, windows: { focus }, shell: { openExternal }, os: { notify } } as unknown as BulwarkDesktopBridge;
}

let store: InProcessStore;
let server: FakeCalendarJmap;
const env = { leaveFor: vi.fn(), push: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  policy.pushWithoutContent = false;
  activeAccountId = ACCOUNT;
  setAppLockCheck(null);
  setPlatform('win32');
  useMissedReminders.getState().close();
  server = new FakeCalendarJmap('1.0');
  store = new InProcessStore(server, CALENDAR_SESSION);
  setStoreBackend(store);
});

afterEach(() => {
  setStoreBackend(null);
  window.bulwarkDesktop = undefined;
  setAppLockCheck(null);
  vi.useRealTimers();
});

async function contextFor(reminder: ReminderAlert): Promise<string> {
  return (await buildReminderNotification(ACCOUNT, reminder, labels, false)).context;
}

describe('what a reminder says', () => {
  it('offers Join only when the event has a link', async () => {
    const without = await buildReminderNotification(ACCOUNT, alert(), labels, false);
    expect(without.actions!.map((action) => action.id)).toEqual(['open', 'snooze-5', 'snooze-10', 'snooze-15']);
    const withLink = await buildReminderNotification(ACCOUNT, alert({ joinUrl: 'https://meet.jit.si/x' }), labels, false);
    expect(withLink.actions!.map((action) => action.id)).toEqual(['join', 'open', 'snooze-5', 'snooze-10', 'snooze-15']);
    expect(withLink.actions![0].label).toBe('Join');
    const foreign = await buildReminderNotification(ACCOUNT, alert({ joinUrl: 'https://calls.example.org/x', joinHost: 'calls.example.org' }), labels, false);
    expect(foreign.actions![0].label).toBe('Join (calls.example.org)');
  });

  it('uses short snooze labels where five buttons share a row', async () => {
    const windows = await buildReminderNotification(ACCOUNT, alert(), labels, false);
    expect(windows.actions!.find((action) => action.id === 'snooze-5')!.label).toBe('5 min');
    setPlatform('darwin');
    const mac = await buildReminderNotification(ACCOUNT, alert(), labels, false);
    expect(mac.actions!.find((action) => action.id === 'snooze-5')!.label).toBe('Snooze 5 min');
  });

  it('sends nothing of the event while the app is locked: no title, no time, no key, no buttons', async () => {
    setAppLockCheck(() => true);
    const locked = await buildReminderNotification(ACCOUNT, alert({ joinUrl: 'https://meet.jit.si/x' }), labels, true);
    expect(locked).toMatchObject({ title: 'GENERIC', body: '', context: '', kind: 'reminder' });
    expect(locked.actions).toBeUndefined();
    expect(JSON.stringify(locked)).not.toContain('Secret');
    expect(JSON.stringify(locked)).not.toContain('uid-1');
  });

  it('keeps the title off when the organisation says so, the buttons stay', async () => {
    policy.pushWithoutContent = true;
    const hidden = await buildReminderNotification(ACCOUNT, alert(), labels, false);
    expect(hidden).toMatchObject({ title: 'GENERIC', body: '' });
    expect(hidden.actions).toHaveLength(4);
  });

  it('gets a new id when it comes back from a snooze, since main drops a repeat', async () => {
    const first = await buildReminderNotification(ACCOUNT, alert(), labels, false);
    const back = await buildReminderNotification(ACCOUNT, alert({ snoozedUntil: FIRE + 5 * MIN }), labels, false);
    expect(back.id).not.toBe(first.id);
  });

  it('falls back on a neutral title for an event without one', async () => {
    expect((await buildReminderNotification(ACCOUNT, alert({ title: '' }), labels, false)).title).toBe('UNTITLED');
  });

  it('keeps titles out of a summary when locked or forbidden, and names three at most', async () => {
    const alerts = ['A', 'B', 'C', 'D', 'E'].map((title) => alert({ title, key: title }));
    expect(missedBody(alerts, labels)).toBe('A, B, C, and 2 more');
    const open = await buildMissedNotification(ACCOUNT, { batch: 7, alerts }, labels);
    expect(open).toMatchObject({ title: '5 missed', body: 'A, B, C, and 2 more' });
    setAppLockCheck(() => true);
    expect((await buildMissedNotification(ACCOUNT, { batch: 7, alerts }, labels)).body).toBe('');
  });

  it('without a store says what it can, and nothing when locked', () => {
    notifyWithoutStore({ key: 'e1:a:1', fireTimeMs: 1, title: 'Dentist', body: 'In 5 min', sound: true }, { generic: 'GENERIC' }, ACCOUNT);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([expect.objectContaining({ id: 'reminder:e1:a:1', title: 'Dentist', body: 'In 5 min', context: '{"cal":true}', sound: true })]);
    setAppLockCheck(() => true);
    notifyWithoutStore({ key: 'e1:a:1', fireTimeMs: 1, title: 'Dentist', body: 'In 5 min', sound: true }, { generic: 'GENERIC' }, ACCOUNT);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]).toEqual([expect.objectContaining({ title: 'GENERIC', body: '' })]);
    expect(JSON.stringify(notify.mock.calls[1])).not.toContain('Dentist');
    expect(JSON.stringify(notify.mock.calls[1])).not.toContain('e1');
  });
});

describe('sizes', () => {
  it('keeps the context under what main will take, with the longest key the store makes', async () => {
    const key = `${'j'.repeat(40)}:#abc:9999:${'a'.repeat(64)}:${FIRE}`;
    const { context } = await buildReminderNotification(ACCOUNT, alert({ key, uid: 'u'.repeat(5000) }), labels, false);
    expect(context.length).toBeLessThan(1024);
    expect(JSON.parse(context).r).toBe(key);
  });
});

describe('Join is only ever a web link', () => {
  for (const url of ['ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'smb://evil.example/share', 'https://meet.google.com@evil.example/x', 'javascript:alert(1)', 'not a link']) {
    it(`opens nothing for ${url}, in the app`, async () => {
      expect(await joinMeeting(url)).toBe(false);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it(`opens nothing for ${url}, in a browser`, async () => {
      window.bulwarkDesktop = undefined;
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      expect(await joinMeeting(url)).toBe(false);
      expect(open).not.toHaveBeenCalled();
      open.mockRestore();
    });
  }

  it('opens a web link, in the app and in a browser', async () => {
    expect(await joinMeeting('https://meet.jit.si/x')).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://meet.jit.si/x');
    window.bulwarkDesktop = undefined;
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    expect(await joinMeeting('https://meet.jit.si/y')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://meet.jit.si/y', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('leaves the reminder standing when Join from a toast opened nothing', async () => {
    vi.useFakeTimers({ now: FIRE - MIN, toFake: ['Date'] });
    server.addEvent({ id: 'e1', uid: 'uid-1', title: 'Standup', virtualLocations: { v: { '@type': 'VirtualLocation', uri: 'https://meet.jit.si/standup' } }, start: '2026-11-10T10:00:00', timeZone: 'Europe/Berlin', alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } } });
    await store.sync(ACCOUNT);
    const params = { timeZone: 'Europe/Berlin', tasks: true };
    await store.area(ACCOUNT, 'reminders.tick', params);
    vi.setSystemTime(FIRE);
    const [reminder] = (await store.area<TickResult>(ACCOUNT, 'reminders.tick', params)).due;
    const { uiHooks } = await import('@/lib/plugin-hooks');
    const stop = uiHooks.onBeforeExternalLink.register('t', () => false);
    const area = vi.spyOn(store, 'area');
    await handleReminderCommand('join', await contextFor(reminder), env);
    stop.dispose();
    expect(openExternal).not.toHaveBeenCalled();
    expect(area.mock.calls.filter(([, name]) => name === 'reminders.dismiss')).toEqual([]);
    // The window comes up, since the button did nothing else.
    expect(focus).toHaveBeenCalled();
  });
});

describe('what its buttons do', () => {
  /** A reminder really on record in the store. */
  async function fired(partial: Record<string, unknown> = {}): Promise<ReminderAlert> {
    vi.useFakeTimers({ now: FIRE - MIN, toFake: ['Date'] });
    server.addEvent({ id: 'e1', uid: 'uid-1', title: 'Standup', start: '2026-11-10T10:00:00', timeZone: 'Europe/Berlin', alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } }, ...partial });
    await store.sync(ACCOUNT);
    const params = { timeZone: 'Europe/Berlin', tasks: true };
    await store.area(ACCOUNT, 'reminders.tick', params);
    vi.setSystemTime(FIRE);
    return (await store.area<TickResult>(ACCOUNT, 'reminders.tick', params)).due[0];
  }

  it('snoozes from the store with the window left hidden', async () => {
    const reminder = await fired();
    expect(await handleReminderCommand('snooze-10', await contextFor(reminder), env)).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(env.leaveFor).not.toHaveBeenCalled();
    const params = { timeZone: 'Europe/Berlin', tasks: true };
    vi.setSystemTime(FIRE + 9 * MIN);
    expect((await store.area<TickResult>(ACCOUNT, 'reminders.tick', params)).due).toEqual([]);
    vi.setSystemTime(FIRE + 10 * MIN);
    expect((await store.area<TickResult>(ACCOUNT, 'reminders.tick', params)).due).toHaveLength(1);
  });

  it('refuses a snooze length no button offers', async () => {
    const reminder = await fired();
    await handleReminderCommand('snooze-999', await contextFor(reminder), env);
    expect(focus).toHaveBeenCalled();
    const params = { timeZone: 'Europe/Berlin', tasks: true };
    vi.setSystemTime(FIRE + 16 * MIN);
    expect((await store.area<TickResult>(ACCOUNT, 'reminders.tick', params)).due).toEqual([]);
  });

  it('joins through the OS from what the store holds, with the window left hidden', async () => {
    const reminder = await fired({ virtualLocations: { v: { '@type': 'VirtualLocation', uri: 'https://meet.jit.si/standup' } } });
    await handleReminderCommand('join', await contextFor(reminder), env);
    expect(openExternal).toHaveBeenCalledWith('https://meet.jit.si/standup');
    expect(focus).not.toHaveBeenCalled();
  });

  it('opens the event in the account on screen', async () => {
    const reminder = await fired();
    await handleReminderCommand('open', await contextFor(reminder), env);
    expect(focus).toHaveBeenCalled();
    expect(env.leaveFor).toHaveBeenCalledWith('/calendar');
    expect(env.push).toHaveBeenCalledWith('/calendar/event/e1?calendar=cal1');
  });

  it('opens only the calendar for an account that is not on screen', async () => {
    const reminder = await fired();
    const context = await contextFor(reminder);
    activeAccountId = 'someone-else';
    await handleReminderCommand('open', context, env);
    expect(env.leaveFor).toHaveBeenCalledWith('/calendar');
    expect(env.push).not.toHaveBeenCalled();
  });

  it('touches nothing when the slot has gone to another login since', async () => {
    const reminder = await fired();
    const context = JSON.parse(await contextFor(reminder)) as { login: string };
    context.login = 'not-this-login';
    await handleReminderCommand('snooze-5', JSON.stringify(context), env);
    expect(env.leaveFor).toHaveBeenCalledWith('/calendar');
    const params = { timeZone: 'Europe/Berlin', tasks: true };
    vi.setSystemTime(FIRE + 5 * MIN);
    expect((await store.area<TickResult>(ACCOUNT, 'reminders.tick', params)).due).toEqual([]);
  });

  it('opens the summary from a click on its toast, even after a restart', async () => {
    vi.useFakeTimers({ now: FIRE - MIN, toFake: ['Date'] });
    server.addEvent({ id: 'e1', uid: 'uid-1', title: 'One', alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } } });
    server.addEvent({ id: 'e2', uid: 'uid-2', title: 'Two', alerts: { a: { '@type': 'Alert', action: 'display', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } } });
    await store.sync(ACCOUNT);
    const params = { timeZone: 'Europe/Berlin', tasks: true };
    await store.area(ACCOUNT, 'reminders.tick', params);
    vi.setSystemTime(FIRE + 60 * MIN);
    await store.area(ACCOUNT, 'reminders.tick', params);
    const batch = await store.area<{ batch: number; alerts: ReminderAlert[] }>(ACCOUNT, 'reminders.takeMissed', params);
    const toast = await buildMissedNotification(ACCOUNT, batch, labels);

    await handleReminderCommand('open', toast.context, env);
    expect(focus).toHaveBeenCalled();
    expect(useMissedReminders.getState().alerts.map((a) => a.title)).toEqual(['One', 'Two']);
    expect(useMissedReminders.getState().account).toBe(ACCOUNT);
  });

  it('goes to the calendar for a store-less reminder, and leaves mail toasts alone', async () => {
    expect(await handleReminderCommand('open', JSON.stringify({ cal: true }), env)).toBe(true);
    expect(env.leaveFor).toHaveBeenCalledTimes(1);
    expect(env.leaveFor).toHaveBeenCalledWith('/calendar');
    expect(await handleReminderCommand('open', JSON.stringify({ emailId: 'm1', slot: 3 }), env)).toBe(false);
    expect(await handleReminderCommand('open', '', env)).toBe(false);
    expect(await handleReminderCommand('open', '{broken', env)).toBe(false);
  });
});
