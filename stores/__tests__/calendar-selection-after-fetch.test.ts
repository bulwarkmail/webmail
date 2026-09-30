import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCalendarStore, reconcileSelectedIds } from '../calendar-store';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { Calendar } from '@/lib/jmap/types';
import { BIRTHDAY_CALENDAR_ID } from '@/lib/birthday-calendar';

// The calendar selection is persisted and reconciled against every calendars
// fetch. A failed fetch used to come back as an empty list: every real
// calendar dropped out of the selection, the always-kept birthday calendar
// stopped the "nothing left -> show all" fallback, and the calendar stayed on
// "birthdays only" for good.

function cal(overrides: Partial<Calendar>): Calendar {
  return {
    id: 'c', name: 'Cal', color: null, sortOrder: 0, isSubscribed: true, isVisible: true,
    isDefault: false, includeInAvailability: 'all', timeZone: null, shareWith: null,
    myRights: {
      mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: true, mayWriteOwn: true,
      mayUpdatePrivate: true, mayRSVP: true, mayShare: true, mayDelete: true,
    },
    ...overrides,
  } as Calendar;
}

function clientReturning(result: { calendars: Calendar[]; failedAccountIds?: string[] } | Error): IJMAPClient {
  return {
    getAllCalendarsWithFailures: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return { calendars: result.calendars, failedAccountIds: result.failedAccountIds ?? [] };
    }),
  } as unknown as IJMAPClient;
}

const own = [cal({ id: 'a', accountId: 'me' }), cal({ id: 'b', accountId: 'me' })];

describe('calendar selection after a fetch', () => {
  beforeEach(() => {
    useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], error: null });
  });

  it('leaves the list and the selection alone when the fetch fails', async () => {
    useCalendarStore.setState({ calendars: own, selectedCalendarIds: ['a', BIRTHDAY_CALENDAR_ID] });

    await useCalendarStore.getState().fetchCalendars(clientReturning(new Error('Network error')));

    const state = useCalendarStore.getState();
    expect(state.selectedCalendarIds).toEqual(['a', BIRTHDAY_CALENDAR_ID]);
    expect(state.calendars).toBe(own);
    expect(state.error).toBe('Failed to load calendars');
  });

  it('falls back to the default when only the birthday calendar is left', async () => {
    // The state the bug left behind: it heals on the next fetch.
    useCalendarStore.setState({ selectedCalendarIds: [BIRTHDAY_CALENDAR_ID] });

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a', 'b', BIRTHDAY_CALENDAR_ID]);
  });

  it('falls back to the default without adding the birthday calendar when it was not selected', async () => {
    useCalendarStore.setState({ selectedCalendarIds: ['gone'] });

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a', 'b']);
  });

  it('keeps a partial selection that still resolves', async () => {
    useCalendarStore.setState({ selectedCalendarIds: ['b', BIRTHDAY_CALENDAR_ID] });

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['b', BIRTHDAY_CALENDAR_ID]);
  });

  it('keeps the selected calendars of a shared account that failed to load', async () => {
    useCalendarStore.setState({ selectedCalendarIds: ['a', 'team:x', 'gone'] });

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own, failedAccountIds: ['team'] }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a', 'team:x']);
  });

  it('keeps the selected calendars of an aggregated account that failed to load', async () => {
    // Both accounts have a calendar with raw id "b"; B's must not be remapped
    // onto A's while B is unavailable.
    useCalendarStore.setState({ selectedCalendarIds: ['A@h::b', 'B@h::b', 'B@h::shared:s'] });

    await useCalendarStore.getState().fetchAllAccountsCalendars([
      { localAccountId: 'A@h', client: clientReturning({ calendars: [cal({ id: 'b', accountId: 'a1' })] }) },
      { localAccountId: 'B@h', client: clientReturning(new Error('Network error')) },
    ]);

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['A@h::b', 'B@h::b', 'B@h::shared:s']);
  });

  it('keeps the selected calendars of a shared account behind an aggregated account', async () => {
    useCalendarStore.setState({ selectedCalendarIds: ['A@h::b', 'A@h::team:x'] });

    await useCalendarStore.getState().fetchAllAccountsCalendars([
      { localAccountId: 'A@h', client: clientReturning({ calendars: [cal({ id: 'b', accountId: 'a1' })], failedAccountIds: ['team'] }) },
    ]);

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['A@h::b', 'A@h::team:x']);
  });
});

describe('reconcileSelectedIds with unloaded accounts', () => {
  it('keeps ids under an unloaded prefix verbatim instead of remapping them by raw id', () => {
    const calendars = [cal({ id: 'A@h::b', originalId: 'b', localAccountId: 'A@h' })];
    expect(reconcileSelectedIds(['B@h::b'], calendars, ['B@h::'])).toEqual(['B@h::b']);
    // Without the prefix the id is remapped onto A's calendar (the raw->
    // namespaced migration path).
    expect(reconcileSelectedIds(['B@h::b'], calendars)).toEqual(['A@h::b']);
  });
});
