import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/lib/browser-navigation', () => ({ apiFetch }));

import { useSettingsStore } from '../settings-store';
import { useCalendarStore } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';

// #1845: the calendars a user hid were kept in the browser only. They came
// back after every sign-out, and never reached the user's other browsers.

const A = { username: 'a@example.com', serverUrl: 'https://mail.example.com' };
const LOGIN = 'a@example.com@mail.example.com';
// Logins of their own: a load that settled stays settled for the whole file.
const C = { username: 'c@example.com', serverUrl: 'https://mail.example.com' };
const LOGIN_C = 'c@example.com@mail.example.com';
const D = { username: 'd@example.com', serverUrl: 'https://mail.example.com' };
const LOGIN_D = 'd@example.com@mail.example.com';

const CALENDARS = [
  { id: 'home', name: 'Home', isVisible: true },
  { id: 'work', name: 'Work', isVisible: true },
  { id: 'acc2:team', name: 'Team', isVisible: true, isShared: true, accountId: 'acc2' },
] as unknown as Calendar[];

const clientFor = (account: typeof A) => ({
  getAllCalendarsWithFailures: async () => ({ calendars: CALENDARS, failedAccountIds: [] }),
  getUsername: () => account.username,
  getServerUrl: () => account.serverUrl,
}) as unknown as IJMAPClient;
const client = clientFor(A);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let serverFile: Record<string, unknown> | null = null;

function lastPush(): Record<string, unknown> | undefined {
  const posts = apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
  const last = posts.at(-1);
  return last ? JSON.parse((last[1] as RequestInit).body as string).settings : undefined;
}

async function signIn(account = A) {
  await useSettingsStore.getState().loadFromServer(account.username, account.serverUrl).finally(() => {
    useSettingsStore.getState().enableSync(account.username, account.serverUrl);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** What a sign-out leaves: the settings forgotten, calendar-storage removed. */
async function signOut() {
  await useSettingsStore.getState().flushSync();
  serverFile = lastPush() ?? serverFile;
  useSettingsStore.getState().disableSync();
  useSettingsStore.getState().forgetSyncedSettings();
  useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], knownCalendarIds: null, calendarSelectionChosen: false });
}

const shown = () => [...useCalendarStore.getState().selectedCalendarIds].sort();

beforeEach(() => {
  localStorage.clear();
  serverFile = null;
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({ ok: true });
    return json({ settings: serverFile });
  });
  useSettingsStore.getState().disableSync();
  useSettingsStore.getState().resetToDefaults();
  localStorage.removeItem('settings-sync-stamps');
  useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], knownCalendarIds: null, calendarSelectionChosen: false });
});

describe('hidden calendars (#1845)', () => {
  it('stay hidden after signing out and in again', async () => {
    await signIn();
    await useCalendarStore.getState().fetchCalendars(client);
    expect(shown()).toEqual(['acc2:team', 'home', 'work']);

    useCalendarStore.getState().toggleCalendarVisibility('work');
    useCalendarStore.getState().toggleCalendarVisibility('acc2:team');
    expect(useSettingsStore.getState().calendarVisibility).toEqual({ [LOGIN]: { work: false, 'acc2:team': false } });

    await signOut();
    await signIn();
    await useCalendarStore.getState().fetchCalendars(client);
    expect(shown()).toEqual(['home']);
  });

  it('follow to another browser, and a calendar shown again there shows here too', async () => {
    serverFile = { calendarVisibility: { [LOGIN]: { work: false } } };
    await signIn();
    await useCalendarStore.getState().fetchCalendars(client);
    expect(shown()).toEqual(['acc2:team', 'home']);

    // The other browser showed it again; this one loads that.
    useSettingsStore.getState().importSettings(JSON.stringify({ calendarVisibility: { [LOGIN]: { work: true } } }), { serverAccountId: LOGIN });
    expect(shown()).toEqual(['acc2:team', 'home', 'work']);
  });

  it('carries the calendars this browser hid before over once the settings are loaded', async () => {
    useCalendarStore.setState({
      calendars: CALENDARS,
      selectedCalendarIds: ['home', 'acc2:team'],
      knownCalendarIds: ['home', 'work', 'acc2:team'],
      calendarSelectionChosen: true,
    });
    await useCalendarStore.getState().fetchCalendars(clientFor(C));
    // Not yet: the login's synced choices may still be on their way.
    expect(useSettingsStore.getState().calendarVisibility).toEqual({});

    await signIn(C);
    expect(useSettingsStore.getState().calendarVisibility).toEqual({ [LOGIN_C]: { work: false } });
    await useSettingsStore.getState().flushSync();
    expect(lastPush()?.calendarVisibility).toEqual({ [LOGIN_C]: { work: false } });
  });

  it('leaves synced choices alone when the login has some', async () => {
    serverFile = { calendarVisibility: { [LOGIN_D]: { home: false } } };
    useCalendarStore.setState({
      calendars: CALENDARS,
      selectedCalendarIds: ['home', 'acc2:team'],
      knownCalendarIds: ['home', 'work', 'acc2:team'],
      calendarSelectionChosen: true,
    });
    await useCalendarStore.getState().fetchCalendars(clientFor(D));
    await signIn(D);
    expect(useSettingsStore.getState().calendarVisibility).toEqual({ [LOGIN_D]: { home: false } });
    expect(shown()).toEqual(['acc2:team']);
  });
});
