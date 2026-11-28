import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCalendarStore } from '../calendar-store';
import { calendarHooks, clearAllHooks } from '@/lib/plugin-hooks';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { CalendarEvent } from '@/lib/jmap/types';

// A push that names one account reloads that account's events and keeps the
// rest of the range on screen (#1857): a reload of every calendar shared with
// the user after each save downloaded megabytes.

const START = '2026-11-23T00:00:00';
const END = '2026-11-30T00:00:00';

function event(id: string, accountId: string, title = id): CalendarEvent {
  return {
    id, uid: `uid-${id}`, title, start: '2026-11-25T10:00:00', duration: 'PT1H',
    timeZone: 'Europe/Berlin', showWithoutTime: false, calendarIds: { c1: true }, accountId,
    isShared: accountId !== 'me',
  } as unknown as CalendarEvent;
}

function fakeClient(events: CalendarEvent[]) {
  return {
    getCalendarsAccountId: vi.fn(() => 'me'),
    queryAllCalendarEvents: vi.fn(async (_filter: unknown, _sort: unknown, _limit: unknown, options?: { accountIds?: string[] }) => (
      events.filter((e) => !options?.accountIds || options.accountIds.includes(e.accountId ?? 'me'))
    )),
  } as unknown as IJMAPClient & { queryAllCalendarEvents: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  clearAllHooks();
  useCalendarStore.getState().clearState();
  useCalendarStore.setState({ events: [], calendars: [], error: null, dateRange: null });
});

describe('fetchEvents for some accounts', () => {
  it("reloads only the named accounts and keeps the others' events", async () => {
    const before = [event('a', 'me'), event('b', 'boss'), event('c', 'team')];
    await useCalendarStore.getState().fetchEvents(fakeClient(before), START, END);

    // The user's own account changed: a new event, one gone.
    const client = fakeClient([event('a', 'me', 'moved'), event('n', 'me'), event('b', 'boss', 'stale')]);
    await useCalendarStore.getState().fetchEvents(client, START, END, { accountIds: ['me'] });

    expect(client.queryAllCalendarEvents.mock.calls[0][3]).toEqual({ accountIds: ['me'] });
    const shown = useCalendarStore.getState().events.map((e) => `${e.id}:${e.title}`).sort();
    expect(shown).toEqual(['a:moved', 'b:b', 'c:c', 'n:n']);
  });

  it('takes an event without an account for one of the own account', async () => {
    const own = { ...event('x', 'me'), accountId: undefined } as CalendarEvent;
    useCalendarStore.setState({ events: [own, event('b', 'boss')], dateRange: { start: START, end: END } });
    await useCalendarStore.getState().fetchEvents(fakeClient([event('x', 'me')]), START, END, { accountIds: ['me'] });
    expect(useCalendarStore.getState().events.map((e) => e.id).sort()).toEqual(['b', 'x']);
  });

  it('loads the whole range for another range, or while a plugin edits the loaded events', async () => {
    useCalendarStore.setState({ events: [event('old', 'boss')], dateRange: { start: '2026-11-16T00:00:00', end: START } });
    const client = fakeClient([event('a', 'me'), event('b', 'boss')]);
    await useCalendarStore.getState().fetchEvents(client, START, END, { accountIds: ['me'] });
    expect(client.queryAllCalendarEvents.mock.calls[0][3]).toBeUndefined();
    expect(useCalendarStore.getState().events.map((e) => e.id).sort()).toEqual(['a', 'b']);

    calendarHooks.onFetchingEvents.register('t', vi.fn((events: CalendarEvent[]) => events));
    const again = fakeClient([event('a', 'me'), event('b', 'boss')]);
    await useCalendarStore.getState().fetchEvents(again, START, END, { accountIds: ['me'] });
    expect(again.queryAllCalendarEvents.mock.calls[0][3]).toBeUndefined();
  });
});
