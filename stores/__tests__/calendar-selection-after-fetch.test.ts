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
    useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], calendarSelectionChosen: false, error: null });
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

describe('a selection the user made', () => {
  beforeEach(() => {
    useCalendarStore.setState({ calendars: own, selectedCalendarIds: ['a', 'b'], calendarSelectionChosen: false, error: null });
  });

  it('stays empty after the user hid every calendar', async () => {
    useCalendarStore.getState().toggleCalendarVisibility('a');
    useCalendarStore.getState().toggleCalendarVisibility('b');

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual([]);
  });

  it('keeps only the birthday calendar when the user hid every other one', async () => {
    useCalendarStore.setState({ selectedCalendarIds: ['a', 'b', BIRTHDAY_CALENDAR_ID] });
    useCalendarStore.getState().toggleCalendarVisibility('a');
    useCalendarStore.getState().toggleCalendarVisibility('b');

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual([BIRTHDAY_CALENDAR_ID]);
  });

  it('falls back to all when the calendars it named were removed', async () => {
    useCalendarStore.getState().toggleCalendarVisibility('b');

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: [cal({ id: 'c', accountId: 'me' })] }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['c']);
  });

  it('does not count showing the birthday calendar as a choice', async () => {
    useCalendarStore.setState({ selectedCalendarIds: [] });
    useCalendarStore.getState().toggleCalendarVisibility(BIRTHDAY_CALENDAR_ID);

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a', 'b', BIRTHDAY_CALENDAR_ID]);
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

// Stalwart gives every account's default calendar the same id ("b"). The
// raw ids a single-account load selected are the active login's; turning to
// the merged list mapped them onto whichever account sorted first, so the
// active account's calendars went hidden and another's showed.
describe('raw selected ids when the merged list loads', () => {
  it("map onto the active login's calendars", async () => {
    useCalendarStore.setState({ calendars: [], selectedCalendarIds: ['b', 'ca:b'], knownCalendarIds: null });
    const list = () => clientReturning({ calendars: [cal({ id: 'b', accountId: 'x' }), cal({ id: 'ca:b', accountId: 'ca', isShared: true })] });

    await useCalendarStore.getState().fetchAllAccountsCalendars(
      [{ localAccountId: 'A@h', client: list() }, { localAccountId: 'B@h', client: list() }],
      'B@h',
    );

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['B@h::b', 'B@h::ca:b']);
  });
});

// A calendar shared with the user, or made in another client, after the list
// loaded once started hidden: the kept selection never named it (#1372).
describe('a calendar that appears after the first load', () => {
  const shared = cal({ id: 'team:x', accountId: 'team', isShared: true });

  beforeEach(() => {
    useCalendarStore.setState({ calendars: [], selectedCalendarIds: [], calendarSelectionChosen: false, knownCalendarIds: null, error: null });
  });

  it('starts shown, while one the user hid stays hidden', async () => {
    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));
    useCalendarStore.getState().toggleCalendarVisibility('b');

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: [...own, shared] }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a', 'team:x']);
  });

  it('starts shown after the user hid every calendar', async () => {
    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));
    useCalendarStore.getState().toggleCalendarVisibility('a');
    useCalendarStore.getState().toggleCalendarVisibility('b');

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: [...own, shared] }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['team:x']);
  });

  it('stays hidden when the server says it is not visible, or it holds only tasks', async () => {
    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: own }));

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: [
      ...own,
      cal({ id: 'team:x', accountId: 'team', isShared: true, isVisible: false }),
      cal({ id: 'todo', accountId: 'me', isTasksOnly: true }),
    ] }));

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a', 'b']);
  });

  it('leaves a selection from before the calendars were recorded as it is', async () => {
    // Saved by a version that did not record the calendars it had seen: every
    // calendar not in the selection may be one the user hid.
    useCalendarStore.setState({ selectedCalendarIds: ['a'], knownCalendarIds: null });

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: [...own, shared] }));
    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a']);

    await useCalendarStore.getState().fetchCalendars(clientReturning({ calendars: [...own, shared, cal({ id: 'c', accountId: 'me' })] }));
    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['a', 'c']);
  });

  it('starts shown in the merged list of several logins', async () => {
    const list = (calendars: Calendar[]) => [{ localAccountId: 'A@h', client: clientReturning({ calendars }) }];
    await useCalendarStore.getState().fetchAllAccountsCalendars(list(own), 'A@h');
    useCalendarStore.getState().toggleCalendarVisibility('A@h::b');

    await useCalendarStore.getState().fetchAllAccountsCalendars(list([...own, shared]), 'A@h');

    expect(useCalendarStore.getState().selectedCalendarIds).toEqual(['A@h::a', 'A@h::team:x']);
  });
});
