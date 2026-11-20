import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as browserNavigation from '@/lib/browser-navigation';
import { useAuthStore } from '../auth-store';
import { useAccountStore } from '../account-store';
import { readCalendarView, setCalendarViewAside, useCalendarStore } from '../calendar-store';

// #1790: a refused token refresh signs out with keepLocalData, and the SSO
// sign-in that follows brings the same account back. Its calendar view has to
// come back with it.

// The demo sign-in loads these calendars and checks the selection against them.
const DEMO_CALENDARS = ['demo-calendar-work', 'demo-calendar-personal', 'demo-calendar-birthdays', 'demo-calendar-team'];

function chooseView() {
  const date = new Date();
  date.setDate(date.getDate() + 9);
  useCalendarStore.setState({
    selectedCalendarIds: ['demo-calendar-work'],
    calendarSelectionChosen: true,
    knownCalendarIds: [...DEMO_CALENDARS],
    hiddenTaskListIds: ['list-chores'],
    viewMode: 'week',
    selectedDate: date,
  });
  return date;
}

function calendarView() {
  const { selectedCalendarIds, calendarSelectionChosen, knownCalendarIds, hiddenTaskListIds, viewMode } = useCalendarStore.getState();
  return { selectedCalendarIds, calendarSelectionChosen, knownCalendarIds, hiddenTaskListIds, viewMode };
}

const CHOSEN = {
  selectedCalendarIds: ['demo-calendar-work'],
  calendarSelectionChosen: true,
  knownCalendarIds: DEMO_CALENDARS,
  hiddenTaskListIds: ['list-chores'],
  viewMode: 'week',
};

async function signIn(): Promise<string> {
  await useAuthStore.getState().loginDemo();
  return useAuthStore.getState().activeAccountId!;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
  vi.spyOn(browserNavigation, 'replaceWindowLocation').mockImplementation(() => {});
  localStorage.clear();
  sessionStorage.clear();
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  useAuthStore.setState({ isAuthenticated: false, client: null, activeAccountId: null, username: null, isDemoMode: false });
  useCalendarStore.getState().clearState();
  useCalendarStore.setState({ viewMode: 'month' });
});

describe('calendar view across a sign-out that keeps the local data', () => {
  it('comes back when the same account signs in again', async () => {
    await signIn();
    const date = chooseView();

    await useAuthStore.getState().logout({ endProviderSession: false, keepLocalData: true });

    expect(localStorage.getItem('calendar-storage')).toBeNull();
    expect(calendarView().selectedCalendarIds).toEqual([]);

    await signIn();

    expect(calendarView()).toEqual(CHOSEN);
    expect(useCalendarStore.getState().selectedDate.getTime()).toBe(date.getTime());
    expect(localStorage.getItem('calendar-kept-view')).toBeNull();
  });

  it('is cleared as before by a sign-out the user asked for', async () => {
    await signIn();
    chooseView();

    await useAuthStore.getState().logout();
    useCalendarStore.setState({ viewMode: 'month' });
    await signIn();

    expect(localStorage.getItem('calendar-kept-view')).toBeNull();
    expect(calendarView()).toEqual({
      selectedCalendarIds: DEMO_CALENDARS,
      calendarSelectionChosen: false,
      knownCalendarIds: DEMO_CALENDARS,
      hiddenTaskListIds: [],
      viewMode: 'month',
    });
  });

  it("isn't given to another account", async () => {
    chooseView();
    setCalendarViewAside(readCalendarView('someone-else'));
    useCalendarStore.getState().clearState();
    useCalendarStore.setState({ viewMode: 'month' });

    await signIn();

    expect(calendarView().selectedCalendarIds).toEqual(DEMO_CALENDARS);
    expect(calendarView().viewMode).toBe('month');
    expect(localStorage.getItem('calendar-kept-view')).toBeNull();
  });

  it('keeps the view but goes to today when the sign-in comes on another day', async () => {
    const account = await signIn();
    chooseView();
    setCalendarViewAside({ ...readCalendarView(account), day: '2000-01-01' });
    useCalendarStore.getState().clearState();

    await signIn();

    expect(calendarView()).toEqual(CHOSEN);
    const today = new Date();
    expect(useCalendarStore.getState().selectedDate.toDateString()).toBe(today.toDateString());
  });
});
