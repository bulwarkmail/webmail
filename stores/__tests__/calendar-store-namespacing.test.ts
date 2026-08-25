import { describe, it, expect, beforeEach } from 'vitest';
import { useCalendarStore, reconcileSelectedIds } from '../calendar-store';
import type { Calendar } from '@/lib/jmap/types';

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

describe('reconcileSelectedIds (account-switch selection stability)', () => {
  it('keeps a selection whose id form flipped raw -> namespaced', () => {
    // Persisted while account A was active (raw "b"); after the fix A is
    // namespaced. The calendar is the same, only the id string changed.
    const calendars = [cal({ id: 'A@h::b', originalId: 'b', localAccountId: 'A@h' })];
    expect(reconcileSelectedIds(['b'], calendars)).toEqual(['A@h::b']);
  });

  it('keeps an already-namespaced selection unchanged across a switch', () => {
    const calendars = [
      cal({ id: 'A@h::b', originalId: 'b', localAccountId: 'A@h' }),
      cal({ id: 'B@h::b', originalId: 'b', localAccountId: 'B@h' }),
    ];
    // Both accounts have raw id "b"; the namespaced selection is unambiguous.
    expect(reconcileSelectedIds(['B@h::b'], calendars)).toEqual(['B@h::b']);
  });

  it('remaps a just-created raw id to its namespaced form after refetch', () => {
    const calendars = [
      cal({ id: 'A@h::b', originalId: 'b', localAccountId: 'A@h' }),
      cal({ id: 'A@h::f', originalId: 'f', localAccountId: 'A@h' }),
    ];
    // createCalendar added the raw "f"; the refetch namespaced it.
    expect(reconcileSelectedIds(['A@h::b', 'f'], calendars)).toEqual(['A@h::b', 'A@h::f']);
  });

  it('drops ids that resolve to no calendar and de-dupes', () => {
    const calendars = [cal({ id: 'A@h::b', originalId: 'b', localAccountId: 'A@h' })];
    expect(reconcileSelectedIds(['b', 'A@h::b', 'gone'], calendars)).toEqual(['A@h::b']);
  });

  it('preserves the birthday calendar id verbatim', () => {
    const calendars = [cal({ id: 'A@h::b', originalId: 'b', localAccountId: 'A@h' })];
    expect(reconcileSelectedIds(['__birthday-calendar__', 'b'], calendars)).toEqual(['__birthday-calendar__', 'A@h::b']);
  });

  it('leaves single-account (raw, no localAccountId) selections untouched', () => {
    const calendars = [cal({ id: 'b' }), cal({ id: 'c' })];
    expect(reconcileSelectedIds(['b', 'c'], calendars)).toEqual(['b', 'c']);
  });
});

describe('isSubscriptionCalendar (namespace-robust, collision-safe)', () => {
  beforeEach(() => {
    useCalendarStore.setState({ calendars: [], icalSubscriptions: [] });
  });

  it('matches a subscription across the raw->namespaced boundary', () => {
    useCalendarStore.setState({
      calendars: [cal({ id: 'A@h::sub1', originalId: 'sub1', localAccountId: 'A@h', accountId: 'acctA' })],
      // subs store the raw JMAP calendar id
      icalSubscriptions: [{ id: 's', url: 'x', calendarId: 'sub1', accountId: 'acctA', name: 'Feed', color: '#000', refreshInterval: 60, lastRefreshed: null }],
    });
    expect(useCalendarStore.getState().isSubscriptionCalendar('A@h::sub1')).toBe(true);
  });

  it('does NOT false-positive when another account has the same raw id', () => {
    useCalendarStore.setState({
      calendars: [
        cal({ id: 'A@h::b', originalId: 'b', localAccountId: 'A@h', accountId: 'acctA' }), // A's subscription calendar
        cal({ id: 'B@h::b', originalId: 'b', localAccountId: 'B@h', accountId: 'acctB' }), // B's normal calendar, same raw id
      ],
      icalSubscriptions: [{ id: 's', url: 'x', calendarId: 'b', accountId: 'acctA', name: 'Feed', color: '#000', refreshInterval: 60, lastRefreshed: null }],
    });
    expect(useCalendarStore.getState().isSubscriptionCalendar('A@h::b')).toBe(true);
    expect(useCalendarStore.getState().isSubscriptionCalendar('B@h::b')).toBe(false);
  });

  it('matches a single-account (raw) subscription exactly', () => {
    useCalendarStore.setState({
      calendars: [cal({ id: 'sub1' })],
      icalSubscriptions: [{ id: 's', url: 'x', calendarId: 'sub1', name: 'Feed', color: '#000', refreshInterval: 60, lastRefreshed: null }],
    });
    expect(useCalendarStore.getState().isSubscriptionCalendar('sub1')).toBe(true);
    expect(useCalendarStore.getState().isSubscriptionCalendar('other')).toBe(false);
  });
});
